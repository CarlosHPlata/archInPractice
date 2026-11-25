# [INC-2417] [FIRING:1] OrdersHighErrorRate - POST /orders returning HTTP 500

> This ticket was created automatically by **Grafana Alerting** through the Jira automation webhook. Do not reply to the reporter: it is a service account.

| Field | Value |
| --- | --- |
| Type | Incident |
| Status | OPEN |
| Severity | SEV-2 (HIGH) |
| Priority | P1 |
| Customer impact | Yes |
| Environment | production |
| Affected endpoint | `POST /orders` (public API, through the gateway) |
| Reporter | `svc-grafana-alerting` (automation) |
| Assignee | On-call engineer (you) |
| Escalation | Otzzo Platform, on-call rotation |
| Labels | `alert`, `auto-generated`, `customer-facing`, `peak-weekend` |
| Created | 2026-11-25 14:20:23 UTC |
| Alert started | 2026-11-25 14:15:23 UTC |
| Last evaluation | 2026-11-25 14:21:15 UTC |

## Alert

| Field | Value |
| --- | --- |
| Alert name | `OrdersHighErrorRate` |
| State | **FIRING** |
| Rule group | `otzzo-slo / orders-availability` |
| Condition | share of `POST /orders` answers with HTTP 5xx is above 5 % for 5 minutes |
| Value at firing | 23.8 % |
| Threshold | 5 % |
| Datasource | Prometheus |
| Dashboard | Otzzo - Orders (<http://localhost:3000>) |
| Runbook | none linked |

## Description

The error rate of `POST /orders` has been above the threshold for more than 5 minutes. Part of the orders sent by customers are rejected with:

```
HTTP/1.1 500 Internal Server Error
{"error":"order_mismatch"}
```

Customer support confirms the alert: customers report that they cannot complete their orders. The impact is partial, because other orders are accepted during the same period.

## Sample log lines

Attached by the alert rule: the last failing requests seen when the alert fired (service `orders`, level `error`).

```json
{"ts":"2026-11-25T14:20:23.931Z","level":"error","service":"orders","msg":"order mismatch: cart owner differs from the customer placing the order","order_id":"ord-d66003c6","cart_id":"cart-7","customer_id":"c-1002","cart_owner":"c-1001"}
{"ts":"2026-11-25T14:20:38.938Z","level":"error","service":"orders","msg":"order mismatch: cart owner differs from the customer placing the order","order_id":"ord-fcd5ff38","cart_id":"cart-7","customer_id":"c-1002","cart_owner":"c-1001"}
{"ts":"2026-11-25T14:20:48.052Z","level":"error","service":"orders","msg":"order mismatch: cart owner differs from the customer placing the order","order_id":"ord-c69200e5","cart_id":"cart-7","customer_id":"c-1002","cart_owner":"c-1001"}
{"ts":"2026-11-25T14:20:51.076Z","level":"error","service":"orders","msg":"order mismatch: cart owner differs from the customer placing the order","order_id":"ord-da356cca","cart_id":"cart-7","customer_id":"c-1002","cart_owner":"c-1001"}
{"ts":"2026-11-25T14:21:15.171Z","level":"error","service":"orders","msg":"order mismatch: cart owner differs from the customer placing the order","order_id":"ord-a479f640","cart_id":"cart-7","customer_id":"c-1002","cart_owner":"c-1001"}
```

## Customer impact

- Affected customers cannot place their order. A retry gives the same error.
- Support tickets linked so far: 14 (the number is growing).
- It is the peak weekend, so every rejected order is lost revenue.

## Steps to reproduce

macOS, Linux, Git Bash:

```bash
curl -i -X POST http://localhost:8080/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"c-1002","cartId":"cart-7"}'
```

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:8080/orders -H "Content-Type: application/json" -d '{\"customerId\":\"c-1002\",\"cartId\":\"cart-7\"}'
```

| | |
| --- | --- |
| Expected | `201 Created` with the order |
| Actual | `500 Internal Server Error` with `{"error":"order_mismatch"}` |
| Reproducibility | Always, with the request above |

## Activity

| Time (UTC) | Author | Event |
| --- | --- | --- |
| 14:15:23 | Grafana Alerting | `OrdersHighErrorRate` went from Normal to Pending |
| 14:20:23 | Grafana Alerting | `OrdersHighErrorRate` went from Pending to **Firing**, ticket created |
| 14:20:25 | Jira Automation | Severity set to HIGH, on-call engineer paged |
| 14:29:03 | Customer Support | Linked 14 customer tickets that report "order mismatch" |

## Resolution

| Field | Value |
| --- | --- |
| Root cause | _to be filled in by the assignee_ |
| Fix | _to be filled in by the assignee_ |
| Resolved at | _open_ |
