# [INC-2434] Order history shows the orders of other customers

| Field | Value |
| --- | --- |
| Type | Incident (privacy) |
| Status | OPEN |
| Severity | SEV-1 (CRITICAL) |
| Environment | production |
| Affected endpoint | `GET /customers/:id/orders` (public API, through the gateway) |
| Reporter | Customer Support, escalated to the Data Protection Officer |
| Assignee | On-call engineer (you) |
| Labels | `privacy`, `data-leak`, `no-alert` |
| Created | 2026-11-25 UTC |

## Description

A customer sent a screenshot of the *My orders* page of the app: it lists a 55" TV that they never bought, shipped to an address in another country. Support reproduced it with several accounts. No alert fired: the endpoint answers `200 OK`.

## Steps to reproduce

macOS, Linux, Git Bash:

```bash
curl -i http://localhost:8080/customers/c-1002/orders
```

Windows PowerShell:

```powershell
curl.exe -i http://localhost:8080/customers/c-1002/orders
```

| | |
| --- | --- |
| Expected | `200 OK` with the orders of `c-1002` only |
| Actual | `200 OK` with orders whose `customerId` is not `c-1002` |

The response has an `x-trace-id` header. That trace id is your starting point.

## Notes

- Nothing is logged at level `error` or `warn` for these requests.
- `GET /orders?customerId=c-1002` on the gateway returns the right list.

## Resolution

You have no access to the code of the services, only to their logs and traces in Grafana. The incident is resolved when you have opened a ticket for the team that owns the faulty service, written with [TICKET-TEMPLATE.md](TICKET-TEMPLATE.md).

| Field | Value |
| --- | --- |
| Faulty service | _to be filled in by the assignee_ |
| Root cause | _to be filled in by the assignee_ |
| Ticket for the owners | _to be filled in by the assignee_ |
