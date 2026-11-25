# [INC-2433] [FIRING:1] OrdersSlowOrFailing - POST /orders returning HTTP 504

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

Part of the orders take about one second and then fail with `504 Gateway Timeout` and `{"error":"shipping_address_timeout"}`. A retry gives the same result. The p99 duration of `orders` on the dashboard is far above the other services.

## Steps to reproduce

macOS, Linux, Git Bash:

```bash
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"c-1003","cartId":"cart-3"}'
```

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:8080/orders -H "Content-Type: application/json" -d '{\"customerId\":\"c-1003\",\"cartId\":\"cart-3\"}'
```

| | |
| --- | --- |
| Expected | `201 Created` in less than 300 ms |
| Actual | `504 Gateway Timeout` after about 1 second |

The response has an `x-trace-id` header. That trace id is your starting point.

## Notes

- The services are healthy: no restarts, no memory or CPU pressure.
- Look at the waterfall of the trace as well as at the logs, and keep reading after the 504 was answered.

## Resolution

You have no access to the code of the services, only to their logs and traces in Grafana. The incident is resolved when you have opened a ticket for the team that owns the faulty service, written with [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md).

| Field | Value |
| --- | --- |
| Faulty service | _to be filled in by the assignee_ |
| Root cause | _to be filled in by the assignee_ |
| Ticket for the owners | _to be filled in by the assignee_ |
