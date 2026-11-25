# [INC-2432] [FIRING:1] OrdersHighErrorRate - POST /orders returning HTTP 500

| Field | Value |
| --- | --- |
| Type | Incident |
| Status | OPEN |
| Severity | SEV-2 (HIGH) |
| Environment | production |
| Affected endpoint | `POST /orders` (public API, through the gateway) |
| Reporter | `svc-grafana-alerting` (automation) |
| Assignee | On-call engineer (you) |
| Labels | `alert`, `auto-generated`, `customer-facing`, `peak-weekend` |
| Created | 2026-11-25 UTC |

## Description

The share of `POST /orders` answers with HTTP 500 is above the threshold. The rejected orders answer `{"error":"invalid_amount"}`. Customer support says the customers who complain are among our best ones, and that they could order without problems last week.

## Steps to reproduce

macOS, Linux, Git Bash:

```bash
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"c-1004","cartId":"cart-12"}'
```

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:8080/orders -H "Content-Type: application/json" -d '{\"customerId\":\"c-1004\",\"cartId\":\"cart-12\"}'
```

| | |
| --- | --- |
| Expected | `201 Created` with the order |
| Actual | `500 Internal Server Error` with `{"error":"invalid_amount"}` |

The response has an `x-trace-id` header. That trace id is your starting point.

## Notes

- Most customers are not affected.
- The error is logged by `orders`. Check whether `orders` is really the service at fault.

## Resolution

You have no access to the code of the services, only to their logs and traces in Grafana. The incident is resolved when you have opened a ticket for the team that owns the faulty service, written with [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md).

| Field | Value |
| --- | --- |
| Faulty service | _to be filled in by the assignee_ |
| Root cause | _to be filled in by the assignee_ |
| Ticket for the owners | _to be filled in by the assignee_ |
