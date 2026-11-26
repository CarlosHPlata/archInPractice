# [INC-2435] TV stock does not match sales

| Field | Value |
| --- | --- |
| Type | Incident |
| Status | OPEN |
| Severity | SEV-3 (MEDIUM) |
| Environment | production |
| Affected endpoint | `POST /orders` (public API, through the gateway) |
| Reporter | Warehouse operations |
| Assignee | On-call engineer (you) |
| Labels | `inventory`, `no-alert`, `peak-weekend` |
| Created | 2026-11-25 UTC |

## Description

The stock of the 55" Smart TV (`tv-55`) goes down about twice as fast as we sell it. The warehouse counted the shelves: the TVs are there, but the store says they are reserved. During the busiest minutes customers get `409 out_of_stock` for a product we still have. Other products are not affected.

## Steps to reproduce

macOS, Linux, Git Bash:

1. first get the current stock
```bash
curl -s https://apps.tail9a6ddb.ts.net/stock/tv-55
```

2. try to add it to the cart
```bash
curl -i -X POST https://apps.tail9a6ddb.ts.net/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"c-1001","cartId":"cart-7"}'
```

3. confirm stock

```bash
curl -s https://apps.tail9a6ddb.ts.net/stock/tv-55
```

Windows PowerShell:

1. get current stock

```powershell
curl.exe -s https://apps.tail9a6ddb.ts.net/stock/tv-55
```

2. try to add it to the cart

```powershell
curl.exe -i -X POST https://apps.tail9a6ddb.ts.net/orders -H "Content-Type: application/json" -d '{\"customerId\":\"c-1001\",\"cartId\":\"cart-7\"}'
```

3. confirm stock
```powershell
curl.exe -s https://apps.tail9a6ddb.ts.net/stock/tv-55
```

| | |
| --- | --- |
| Expected | `201 Created`, and `available` goes down by 1 |
| Actual | `201 Created`, and `available` goes down by 2 |

The response has an `x-trace-id` header. That trace id is your starting point.

## Notes

- The restock job refills the shelves every 2 minutes.
- Nothing is logged at level `error` for these orders.

## Resolution

You have no access to the code of the services, only to their logs and traces in Grafana. The incident is resolved when you have opened a ticket for the team that owns the faulty service, written with [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md).

| Field | Value |
| --- | --- |
| Faulty service | _to be filled in by the assignee_ |
| Root cause | _to be filled in by the assignee_ |
| Ticket for the owners | _to be filled in by the assignee_ |
