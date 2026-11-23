# loki (Grafana Loki)

## What it is for

Loki stores the logs and answers the log searches made from Grafana. It indexes only the labels of a log stream (here, `service`) and keeps the log lines themselves as compressed text, so anything inside a line is filtered at query time.

## How it is configured

`loki.yml`, mounted at `/etc/loki`. It runs as a single process, which is enough for a laptop.

- **No tenants, no login** (`auth_enabled: false`).
- **Storage on the local filesystem** under `/loki` inside the container, with the `tsdb` index and schema `v13`. There is no volume: `docker compose down` deletes the logs.
- **Retention of 24 hours**, enforced by the compactor.
- **Port 3100**, reachable only from the other containers. Alloy writes to it, Grafana reads from it.

## Working with it

You query Loki from Grafana (Explore > Loki) with LogQL:

```logql
{service="orders"}                               all lines of one service
{service=~".+"} | json                           all services, JSON fields parsed
{service=~".+"} | json | level="error"           filter on a field
{service=~".+"} | json | trace_id="..."          one request across services
```

The part in braces selects streams by label and is required. Everything after `|` works on the content of the lines.

Reference: <https://grafana.com/docs/loki/latest/query/> (version 3.7).
