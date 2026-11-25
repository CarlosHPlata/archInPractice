// orders service: checkout, order lookup, order list and cancellation.
//
//   POST /orders              {"customerId": "c-1002", "cartId": "cart-9", "recipientId": "c-1001"}
//                             recipientId is optional: a gift, shipped to another customer
//   GET  /orders/:id          one order
//   GET  /orders?customerId=  the orders of a customer
//   POST /orders/:id/cancel   cancel: gives the stock and the loyalty points back
//
// The checkout talks to the customers service (profile, shipping address,
// loyalty points) and to the cart service (cart, quote, stock). Logging rule
// of the store: say when a request comes in, say what you are about to ask a
// store or another service, say what you answer.
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { callService, checkouts, discountGiven, log, metricsText, ordersStored, telemetry, unitsCancelled, unitsSold } from "./telemetry.js";

const CART_URL = process.env.CART_URL ?? "http://cart:8080";
const CUSTOMERS_URL = process.env.CUSTOMERS_URL ?? "http://customers:8000";
const PORT = Number(process.env.PORT ?? 3000);

const DEFAULT_TIMEOUT_MS = 2000;
const ADDRESS_TIMEOUT_MS = 1000;
const RESERVE_TIMEOUTS_MS = [300, 1000]; // one entry per attempt
const MAX_STORED_ORDERS = 400;

type Item = { sku: string; name: string; qty: number; price: number };
type Cart = { id: string; customerId: string; items: Item[]; total: number };
type Customer = { id: string; name: string; email: string; loyaltyTier: string };
type Address = { name: string; street: string; city: string; postalCode: string; country: string; verified: boolean };
type Quote = { subtotal: number; loyaltyTier: string; discount: number; discountAmount: number; shipping: number; total: number };
type Order = {
  orderId: string;
  status: "confirmed" | "cancelled";
  customerId: string;
  cartId: string;
  recipientId: string | null;
  items: Item[];
  subtotal: number;
  loyaltyTier: string;
  discountAmount: number;
  shipping: number;
  total: number;
  pointsAwarded: number;
  shipTo: Address;
  createdAt: string;
};

// ---------- the "database" ----------

const orders: Order[] = [];

function saveOrder(order: Order): void {
  orders.push(order);
  ordersStored.inc({ customer_id: order.customerId });
  if (orders.length > MAX_STORED_ORDERS) {
    const archived = orders.shift()!; // old orders move to the archive
    ordersStored.dec({ customer_id: archived.customerId });
  }
}

function seed(): void {
  const past: [string, string, string, number, string][] = [
    ["c-1001", "cart-7", "tv-55", 1299.0, "PE"],
    ["c-1002", "cart-9", "hp-20", 89.9, "CO"],
    ["c-1002", "cart-9", "cb-3", 9.5, "CO"],
    ["c-1003", "cart-3", "nb-1", 15.0, "CL"],
    ["c-1004", "cart-12", "kb-88", 119.0, "MX"],
    ["c-1005", "cart-5", "bk-102", 24.5, "PE"],
    ["c-1005", "cart-5", "mg-7", 14.0, "PE"],
    ["c-1001", "cart-7", "hp-20", 89.9, "PE"],
  ];
  past.forEach(([customerId, cartId, sku, subtotal, country], i) => {
    saveOrder({
      orderId: `ord-${(0xa1000 + i * 7919).toString(16)}00`,
      status: "confirmed",
      customerId,
      cartId,
      recipientId: null,
      items: [{ sku, name: sku, qty: 1, price: subtotal }],
      subtotal,
      loyaltyTier: "standard",
      discountAmount: 0,
      shipping: 5,
      total: subtotal + 5,
      pointsAwarded: Math.floor(subtotal + 5),
      shipTo: { name: customerId, street: "-", city: "-", postalCode: "-", country, verified: true },
      createdAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
    });
  });
}

// ---------- helpers ----------

const money = (v: number) => v.toFixed(2);
const describe = (items: Item[]) => items.map((it) => `${it.sku} x${it.qty}`).join(", ") || "(empty)";

type Answer<T> = { status: number; data: T; timedOut: boolean }; // status 0: no answer

/** Calls another service and reads its JSON answer. Never throws. */
async function ask<T>(service: string, method: string, url: string, timeoutMs: number, body?: unknown): Promise<Answer<T>> {
  try {
    const res = await callService(service, method, url, { body, timeoutMs });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data, timedOut: false };
  } catch (err) {
    return { status: 0, data: {} as T, timedOut: (err as Error).name === "TimeoutError" };
  }
}

const app = new Hono();
app.use(telemetry); // logs, metrics and tracing: see telemetry.ts

app.get("/healthz", (c) => c.text("ok"));
app.get("/metrics", async (c) => c.text(await metricsText()));

// ---------- POST /orders: the checkout ----------

app.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cartId, recipientId } = body as { cartId?: string; recipientId?: string };
  let { customerId } = body as { customerId?: string };
  if (!customerId || !cartId) {
    log("warn", "checkout received without customerId or cartId; answering 400 bad_request");
    checkouts.inc({ outcome: "bad_request" });
    return c.json({ error: "bad_request", detail: "customerId and cartId are required" }, 400);
  }

  const orderId = `ord-${randomUUID().slice(0, 8)}`;
  const buyerId = customerId;
  const ids = { order_id: orderId, cart_id: cartId, customer_id: buyerId, ...(recipientId ? { recipient_id: recipientId } : {}) };
  log(
    "info",
    recipientId
      ? `checkout received: customer ${buyerId} orders cart ${cartId} as a gift for recipient ${recipientId}; order id is ${orderId}`
      : `checkout received: customer ${buyerId} orders cart ${cartId}; order id is ${orderId}`,
    ids,
  );

  // 1. who is buying
  let path = `/customers/${buyerId}`;
  log("info", `checkout step 1/8: asking customers service for the profile of the buyer, customer ${buyerId} (GET ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const profile = await ask<Customer>("customers", "GET", CUSTOMERS_URL + path, DEFAULT_TIMEOUT_MS);
  if (profile.status !== 200) {
    log("warn", `checkout step 1/8 failed: customers service answered ${profile.status} for customer ${buyerId}; answering 404 customer_not_found`, ids);
    checkouts.inc({ outcome: "customer_not_found" });
    return c.json({ error: "customer_not_found" }, 404);
  }
  log("info", `checkout step 1/8 done: buyer is ${profile.data.name} (customer ${buyerId}), loyalty tier ${profile.data.loyaltyTier}`, ids);

  // 2. what they are buying
  path = `/carts/${cartId}?customerId=${buyerId}`;
  log("info", `checkout step 2/8: asking cart service for cart ${cartId} of customer ${buyerId} (GET ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const cartAnswer = await ask<Cart>("cart", "GET", CART_URL + path, DEFAULT_TIMEOUT_MS);
  if (cartAnswer.status !== 200) {
    log("warn", `checkout step 2/8 failed: cart service answered ${cartAnswer.status} for cart ${cartId}; answering 404 cart_not_found`, ids);
    checkouts.inc({ outcome: "cart_not_found" });
    return c.json({ error: "cart_not_found" }, 404);
  }
  const cart = cartAnswer.data;
  log("info", `checkout step 2/8 done: cart ${cartId} has items: ${describe(cart.items)}; its owner is customer ${cart.customerId}`, ids);

  // 3. never sell a cart to somebody who does not own it
  log("info", `checkout step 3/8: checking that cart ${cartId} (owner ${cart.customerId}) belongs to the buyer (customer ${buyerId})`, ids);
  if (cart.customerId !== buyerId) {
    log("warn", `checkout step 3/8 failed: cart ${cartId} belongs to customer ${cart.customerId}, not to the buyer ${buyerId}; answering 403 cart_not_owned`, ids);
    checkouts.inc({ outcome: "cart_not_owned" });
    return c.json({ error: "cart_not_owned" }, 403);
  }
  if (cart.items.length === 0) {
    log("warn", `checkout step 3/8 failed: cart ${cartId} is empty; answering 400 empty_cart`, ids);
    checkouts.inc({ outcome: "empty_cart" });
    return c.json({ error: "empty_cart" }, 400);
  }
  log("info", `checkout step 3/8 done: cart ${cartId} belongs to the buyer`, ids);

  // 4. where the parcel goes: a gift is delivered to the recipient
  customerId = recipientId ?? customerId;
  path = `/customers/${customerId}/shipping-address`;
  log("info", `checkout step 4/8: asking customers service for the validated shipping address of customer ${customerId} (GET ${path}), waiting at most ${ADDRESS_TIMEOUT_MS} ms`, ids);
  const address = await ask<Address>("customers", "GET", CUSTOMERS_URL + path, ADDRESS_TIMEOUT_MS);
  if (address.timedOut) {
    log("error", `checkout step 4/8 failed: customers service did not answer GET ${path} within ${ADDRESS_TIMEOUT_MS} ms, the call was abandoned; answering 504 shipping_address_timeout`, ids);
    checkouts.inc({ outcome: "shipping_address_timeout" });
    return c.json({ error: "shipping_address_timeout" }, 504);
  }
  if (address.status !== 200) {
    log("warn", `checkout step 4/8 failed: customers service answered ${address.status} for the shipping address of customer ${customerId}; answering 404 recipient_not_found`, ids);
    checkouts.inc({ outcome: "recipient_not_found" });
    return c.json({ error: "recipient_not_found" }, 404);
  }
  const shipTo = address.data;
  log("info", `checkout step 4/8 done: the parcel goes to ${shipTo.name}, ${shipTo.city}, country ${shipTo.country} (address verified=${shipTo.verified})`, ids);

  // 5. the price
  path = `/carts/${cartId}/quote?customerId=${customerId}&country=${shipTo.country}`;
  log("info", `checkout step 5/8: asking cart service for a quote of cart ${cartId}, priced for customer ${customerId}, shipping to country ${shipTo.country} (GET ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const quoteAnswer = await ask<Quote>("cart", "GET", CART_URL + path, DEFAULT_TIMEOUT_MS);
  if (quoteAnswer.status !== 200) {
    log("error", `checkout step 5/8 failed: cart service answered ${quoteAnswer.status || "nothing"} to the quote of cart ${cartId}; answering 502 quote_unavailable`, ids);
    checkouts.inc({ outcome: "quote_unavailable" });
    return c.json({ error: "quote_unavailable" }, 502);
  }
  const quote = quoteAnswer.data;
  log("info", `checkout step 5/8 done: quote for cart ${cartId}: subtotal ${money(quote.subtotal)}, loyalty tier ${quote.loyaltyTier}, discount amount ${money(quote.discountAmount)}, shipping ${money(quote.shipping)}, total ${money(quote.total)}`, ids);

  // 6. the amount to charge
  log("info", `checkout step 6/8: checking the amount to charge to customer ${buyerId}: ${money(quote.total)}`, ids);
  if (!(quote.total > 0)) {
    log("error", `checkout step 6/8 failed: the amount to charge must be greater than 0, the quote says ${money(quote.total)}; answering 500 invalid_amount`, ids);
    checkouts.inc({ outcome: "invalid_amount" });
    return c.json({ error: "invalid_amount" }, 500);
  }
  log("info", `checkout step 6/8 done: amount ${money(quote.total)} accepted`, ids);

  // 7. keep the stock for this order
  const wanted = cart.items.map(({ sku, qty }) => ({ sku, qty }));
  let reserved = false;
  for (let attempt = 1; attempt <= RESERVE_TIMEOUTS_MS.length && !reserved; attempt++) {
    const timeoutMs = RESERVE_TIMEOUTS_MS[attempt - 1];
    const of = `${attempt}/${RESERVE_TIMEOUTS_MS.length}`;
    log("info", `checkout step 7/8, attempt ${of}: asking cart service to reserve stock for order ${orderId}, items: ${describe(cart.items)} (POST /stock/reservations), waiting at most ${timeoutMs} ms`, ids);
    const reservation = await ask<{ sku?: string }>("cart", "POST", `${CART_URL}/stock/reservations`, timeoutMs, { orderId, items: wanted });
    if (reservation.status === 201) {
      log("info", `checkout step 7/8 done: cart service answered 201 on attempt ${of}, stock is reserved for order ${orderId}`, ids);
      reserved = true;
    } else if (reservation.status === 409) {
      log("warn", `checkout step 7/8 failed: cart service answered 409, sku ${reservation.data.sku} is out of stock; answering 409 out_of_stock`, ids);
      checkouts.inc({ outcome: "out_of_stock" });
      return c.json({ error: "out_of_stock", sku: reservation.data.sku }, 409);
    } else if (reservation.timedOut) {
      log("warn", `checkout step 7/8, attempt ${of}: cart service did not answer POST /stock/reservations within ${timeoutMs} ms, the call was abandoned`, ids);
    } else {
      log("warn", `checkout step 7/8, attempt ${of}: cart service answered ${reservation.status || "nothing"} to POST /stock/reservations`, ids);
    }
  }
  if (!reserved) {
    log("error", `checkout step 7/8 failed: stock could not be reserved for order ${orderId} after ${RESERVE_TIMEOUTS_MS.length} attempts; answering 503 stock_unavailable`, ids);
    checkouts.inc({ outcome: "stock_unavailable" });
    return c.json({ error: "stock_unavailable" }, 503);
  }

  // 8. loyalty points for the buyer
  const points = Math.floor(quote.total);
  path = `/customers/${buyerId}/loyalty/points`;
  log("info", `checkout step 8/8: asking customers service to add ${points} loyalty point(s) to customer ${buyerId} for order ${orderId} (POST ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const awarded = await ask<{ points: number }>("customers", "POST", CUSTOMERS_URL + path, DEFAULT_TIMEOUT_MS, { orderId, points });
  if (awarded.status === 200) {
    log("info", `checkout step 8/8 done: customer ${buyerId} now has ${awarded.data.points} loyalty points`, ids);
  } else {
    log("warn", `checkout step 8/8: customers service answered ${awarded.status || "nothing"}, the points were not added; the order continues`, ids);
  }

  const order: Order = {
    orderId,
    status: "confirmed",
    customerId: buyerId,
    cartId,
    recipientId: recipientId ?? null,
    items: cart.items,
    subtotal: quote.subtotal,
    loyaltyTier: quote.loyaltyTier,
    discountAmount: quote.discountAmount,
    shipping: quote.shipping,
    total: quote.total,
    pointsAwarded: awarded.status === 200 ? points : 0,
    shipTo,
    createdAt: new Date().toISOString(),
  };
  log("info", `writing order ${orderId} to the order store`, ids);
  saveOrder(order);
  checkouts.inc({ outcome: "confirmed" });
  for (const it of order.items) unitsSold.inc({ sku: it.sku }, it.qty);
  discountGiven.inc({ buyer_tier: profile.data.loyaltyTier }, Math.max(order.discountAmount, 0));

  log("info", `order confirmed, answering 201: order ${orderId}, buyer ${buyerId}, shipped to ${shipTo.name} in ${shipTo.country}, subtotal ${money(order.subtotal)}, discount amount ${money(order.discountAmount)} (loyalty tier ${order.loyaltyTier}), shipping ${money(order.shipping)}, total charged to customer ${buyerId}: ${money(order.total)}`, { ...ids, total: order.total });
  return c.json(order, 201);
});

// ---------- GET /orders: the orders of a customer ----------

app.get("/orders", (c) => {
  const queryString = new URL(c.req.url).search.slice(1);
  const customerId = c.req.query("customerId");
  log("info", `list orders received with query string "${queryString}"`);

  log("info", customerId
    ? `reading the order store with filter customerId=${customerId}`
    : `the query string has no customerId parameter: reading the order store without a customer filter`);
  const found = customerId ? orders.filter((o) => o.customerId === customerId) : orders;

  const owners = [...new Set(found.map((o) => o.customerId))].sort();
  log("info", `answering 200 with ${found.length} order(s) that belong to ${owners.length} customer(s): ${owners.join(", ") || "none"}`,
    customerId ? { customer_id: customerId } : {});
  return c.json({ orders: found });
});

// ---------- GET /orders/:id ----------

app.get("/orders/:id", (c) => {
  const orderId = c.req.param("id");
  log("info", `get order received: order ${orderId}`, { order_id: orderId });
  log("info", `reading order ${orderId} from the order store`, { order_id: orderId });
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    log("warn", `answering 404 order_not_found: the order store has no order ${orderId}`, { order_id: orderId });
    return c.json({ error: "order_not_found" }, 404);
  }
  log("info", `answering 200 with order ${orderId}: customer ${order.customerId}, status ${order.status}, total ${money(order.total)}`, { order_id: orderId, customer_id: order.customerId });
  return c.json(order);
});

// ---------- POST /orders/:id/cancel ----------

app.post("/orders/:id/cancel", async (c) => {
  const orderId = c.req.param("id");
  log("info", `cancel order received: order ${orderId}`, { order_id: orderId });

  log("info", `reading order ${orderId} from the order store`, { order_id: orderId });
  const order = orders.find((o) => o.orderId === orderId);
  if (!order) {
    log("warn", `answering 404 order_not_found: the order store has no order ${orderId}`, { order_id: orderId });
    return c.json({ error: "order_not_found" }, 404);
  }
  const ids = { order_id: orderId, cart_id: order.cartId, customer_id: order.customerId };
  if (order.status === "cancelled") {
    log("warn", `answering 409 already_cancelled: order ${orderId} was cancelled before`, ids);
    return c.json({ error: "already_cancelled" }, 409);
  }
  log("info", `order ${orderId} found: customer ${order.customerId}, items: ${describe(order.items)}, ${order.pointsAwarded} loyalty point(s) awarded`, ids);

  // 1. the stock goes back to the shelf
  let path = `/stock/reservations/${orderId}`;
  log("info", `cancel step 1/2: asking cart service to release the stock of order ${orderId} (DELETE ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const released = await ask<{ released?: unknown[] }>("cart", "DELETE", CART_URL + path, DEFAULT_TIMEOUT_MS);
  if (released.status === 200) {
    log("info", `cancel step 1/2 done: cart service released ${released.data.released?.length ?? 0} reservation(s) of order ${orderId}`, ids);
  } else {
    log("warn", `cancel step 1/2: cart service answered ${released.status || "nothing"} to the release of order ${orderId}; the cancellation continues`, ids);
  }

  // 2. the loyalty points go back
  path = `/customers/${order.customerId}/loyalty/points`;
  log("info", `cancel step 2/2: asking customers service to take ${order.pointsAwarded} loyalty point(s) back from customer ${order.customerId} (POST ${path}), waiting at most ${DEFAULT_TIMEOUT_MS} ms`, ids);
  const revoked = await ask<{ points: number }>("customers", "POST", CUSTOMERS_URL + path, DEFAULT_TIMEOUT_MS, { orderId, points: -order.pointsAwarded });
  if (revoked.status === 200) {
    log("info", `cancel step 2/2 done: customer ${order.customerId} now has ${revoked.data.points} loyalty points`, ids);
  } else {
    log("warn", `cancel step 2/2: customers service answered ${revoked.status || "nothing"}, the points were not taken back; the cancellation continues`, ids);
  }

  log("info", `writing status cancelled for order ${orderId} to the order store`, ids);
  order.status = "cancelled";
  for (const it of order.items) unitsCancelled.inc({ sku: it.sku }, it.qty);
  log("info", `order cancelled, answering 200: order ${orderId} of customer ${order.customerId}`, ids);
  return c.json(order);
});

seed();
serve({ fetch: app.fetch, port: PORT }, () => log("info", `orders service listening on :${PORT}`));
