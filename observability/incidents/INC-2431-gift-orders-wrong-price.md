# [INC-2431] Gift orders are charged the wrong price

| Field | Value |
| --- | --- |
| Type | Incident |
| Status | OPEN |
| Severity | SEV-3 (MEDIUM) |
| Environment | production |
| Affected endpoint | `POST /orders` (public API, through the gateway) |
| Reporter | Finance (revenue assurance) |
| Assignee | On-call engineer (you) |
| Labels | `finance`, `pricing`, `no-alert` |
| Created | 2026-11-25 UTC |

## Description

The daily revenue report does not match the price list. Some orders that are sent as a gift (they have a `recipientId`) are charged less than they should, and a few are charged more. Bruno Diaz (`c-1002`) has no loyalty discount, but his gift orders show one. No alert fired: the orders are accepted with `201 Created`.

## Steps to reproduce

macOS, Linux, Git Bash:

```bash
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"c-1002","cartId":"cart-9","recipientId":"c-1001"}'
```

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:8080/orders -H "Content-Type: application/json" -d '{\"customerId\":\"c-1002\",\"cartId\":\"cart-9\",\"recipientId\":\"c-1001\"}'
```

| | |
| --- | --- |
| Expected | `201 Created`; headphones 89.90, no discount for `c-1002` |
| Actual | `201 Created`, but the order has a `discountAmount` and a lower `total` |

The response has an `x-trace-id` header. That trace id is your starting point.

## Notes

- The same cart ordered by the same customer without `recipientId` has the right price.
- Nothing is logged at level `error` for these orders.

## Resolution

You have no access to the code of the services, only to their logs and traces in Grafana. The incident is resolved when you have opened a ticket for the team that owns the faulty service, written with [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md).

| Field | Value |
| --- | --- |
| Faulty service | _to be filled in by the assignee_ |
| Root cause | _to be filled in by the assignee_ |
| Ticket for the owners | _to be filled in by the assignee_ |
