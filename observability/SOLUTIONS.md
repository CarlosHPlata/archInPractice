# Solutions (facilitator only)

Do not hand this file to the students. They work from the tickets in `incidents/` and from Grafana, with no access to the code.

Each bug lives in the way two or three services fit together. The log lines quoted below are the ones a student needs to find; all of them belong to one trace.

| Ticket | Symptom | Faulty service | Kind of bug |
| --- | --- | --- | --- |
| INC-2431 | gift orders get the wrong discount, `201` | orders | wrong identity passed downstream |
| INC-2432 | `500 invalid_amount` for VIP customers | customers | unit mismatch (percent or fraction) |
| INC-2433 | `504` for Chilean addresses | customers | retry of a failure that cannot pass, longer than the caller's timeout |
| INC-2434 | order history shows everybody's orders, `200` | customers (and orders) | parameter name mismatch, silent fallback to "no filter" |
| INC-2435 | TV stock drops twice per order, `201` | orders (and cart) | retry of a call that is not idempotent |

## INC-2431: gift orders are priced for the recipient

**Flow:** orders → cart → customers.

**What the logs say**

- orders: `checkout received: customer c-1002 orders cart cart-9 as a gift for recipient c-1001`
- orders: `checkout step 1/8 done: buyer is Bruno Diaz (customer c-1002), loyalty tier standard`
- orders: `checkout step 5/8: asking cart service for a quote of cart cart-9, priced for customer c-1001 ... (GET /carts/cart-9/quote?customerId=c-1001&country=PE)`
- cart: `quote step 1/4 done: cart cart-9 belongs to customer c-1002` and then `quote step 2/4: asking customers service for the loyalty tier of customer c-1001`
- customers: `answering 200: customer c-1001 has loyalty tier gold ... discount value 0.1`
- orders: `order confirmed ... buyer c-1002 ... discount amount 8.99 (loyalty tier gold) ... total charged to customer c-1002: 85.91`

**Cause:** in `projects/orders/src/index.ts`, step 4 overwrites `customerId` with the recipient (`customerId = recipientId ?? customerId`) to fetch the shipping address, and step 5 reuses that variable for the quote. The buyer is charged with the recipient's loyalty tier. It works both ways: a gold buyer loses the discount when the recipient is standard.

**Fix:** orders must ask for the quote with the buyer's id (`buyerId`); the recipient is only for the shipping address and country. Optional hardening: cart rejects a quote whose `customerId` is not the owner of the cart.

## INC-2432: the VIP discount is a percent, the others are fractions

**Flow:** orders → cart → customers, error logged by orders.

**What the logs say**

- customers: `answering 200: customer c-1004 has loyalty tier vip, 26900 points, discount value 20`
- cart: `quote step 4/4: total = subtotal 119.00 x (1 - discount 20) + shipping 9.00 = -2252.00`
- orders: `checkout step 6/8 failed: the amount to charge must be greater than 0, the quote says -2252.00; answering 500 invalid_amount`
- In a trace of a gold customer, customers says `discount value 0.1`.

**Cause:** in `projects/customers/main.py`, `TIER_DISCOUNT` holds fractions (`0.05`, `0.10`) for the old tiers and `20` for the new `vip` tier. cart computes `subtotal * (1 - discount)`. orders only reports the damage.

**Fix:** customers returns `0.20` for `vip`. Optional hardening: cart rejects a discount outside 0..1 instead of computing a negative total; the contract names the unit (`discountFraction`).

## INC-2433: address validation retries longer than orders waits

**Flow:** orders → customers.

**What the logs say**

- orders: `checkout step 4/8: asking customers service for the validated shipping address of customer c-1003 ... waiting at most 1000 ms`
- customers, three times: `address validation attempt N/3 failed: the address-rules store has no postal-code rule for country CL (countries with a rule: AR, CO, MX, PE)` and `waiting 500 ms before address validation attempt ...`
- orders, 1000 ms after its call: `checkout step 4/8 failed: customers service did not answer ... within 1000 ms, the call was abandoned; answering 504`
- customers, after the 504: `request finished: GET /customers/c-1003/shipping-address answered 200 in 1304 ms`

In the waterfall the customers span is longer than the orders span that called it.

**Cause:** in `projects/customers/main.py`, `validate_address` retries when a country has no postal-code rule. That failure cannot pass on a retry, and three attempts (3 × 100 ms lookup + 2 × 500 ms wait = 1300 ms) are longer than the 1000 ms orders waits.

**Fix:** customers adds a rule for `CL` (seven digits) and does not retry a missing rule: it answers at once with `verified=false`. Optional: the two teams agree on a time budget for this call.

## INC-2434: `customer_id` is not `customerId`

**Flow:** customers → orders.

**What the logs say**

- customers: `asking orders service for the orders of customer c-1002 (GET /orders?customer_id=c-1002)`
- orders: `list orders received with query string "customer_id=c-1002"`
- orders: `the query string has no customerId parameter: reading the order store without a customer filter`
- orders: `answering 200 with N order(s) that belong to 5 customer(s): c-1001, c-1002, c-1003, c-1004, c-1005`

**Cause:** in `projects/customers/main.py`, `get_order_history` sends `customer_id`; `GET /orders` in `projects/orders/src/index.ts` reads `customerId`. With no filter, orders returns every order, and customers passes the list on.

**Fix:** customers sends `customerId`. A complete answer also asks orders to stop treating "no filter" as "everything": answer `400` when `customerId` is missing, or reject unknown parameters. Good tickets mention both.

## INC-2435: the stock reservation is retried and counted twice

**Flow:** orders → cart.

**What the logs say**

- orders: `checkout step 7/8, attempt 1/2: asking cart service to reserve stock for order ord-X, items: tv-55 x1 ... waiting at most 300 ms`
- cart: `sku tv-55 is a bulky item: asking the bulky-goods warehouse for its stock level`
- orders: `checkout step 7/8, attempt 1/2: cart service did not answer ... within 300 ms, the call was abandoned`, then `attempt 2/2 ... waiting at most 1000 ms`
- cart, twice, with two reservation ids for one order: `writing reservation res-00007 ... 39 remaining` and `writing reservation res-00008 ... 38 remaining`
- cart, twice: `request finished: POST /stock/reservations answered 201 in 350 ms`

**Cause:** the bulky-goods lookup in `projects/cart/main.go` takes 350 ms; orders gives up after 300 ms and retries. cart finishes the abandoned request anyway, and `POST /stock/reservations` creates a new reservation each time it is called, so the order holds two.

**Fix:** cart makes the reservation idempotent on `orderId` (a second request for the same order returns the existing reservation). On the orders side: a first timeout above the known latency of the bulky warehouse. Either team can be the addressee; the best tickets ask for idempotency, because a longer timeout only makes the bug rarer.

## Noise that is not a bug

- `404 customer_not_found` on `POST /orders`: visitors with a stale link, sent on purpose by the traffic generator.
- `409 out_of_stock` for `tv-55`: a consequence of INC-2435 during busy minutes.
- `restock job` lines in cart have `trace_id` `-`: the job runs outside any request.
