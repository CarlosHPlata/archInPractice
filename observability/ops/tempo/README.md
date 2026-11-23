# tempo (Grafana Tempo)

## What it is for

Tempo stores the traces. A trace is the set of spans that share one trace id: one span per piece of work, each with a start, a duration, the service that did it and its parent span. Grafana reads them from Tempo and draws the waterfall.

## How it is configured

`tempo.yml`, mounted at `/etc/tempo`. It runs as a single process.

- **Receives OTLP over gRPC on port 4317.** Only Alloy sends to it.
- **Answers queries on port 3200.** Only Grafana reads from it.
- **Storage on the local filesystem** under `/var/tempo` inside the container. There is no volume: `docker compose down` deletes the traces.
- **Retention of 24 hours.**
- `trace_idle_period: 5s`: a trace can be found by search a few seconds after its last span arrives. Opening a trace by its id works right away.

Tempo only stores what it is sent. If no span is ever created for a request, there is nothing to find here.

## Working with it

In Grafana (Explore > Tempo), paste a trace id in the *TraceQL* box, or search:

```traceql
{ resource.service.name = "orders" }
{ status = error }
```

From a trace, the *Related logs* button opens the log lines with the same trace id.

Reference: <https://grafana.com/docs/tempo/latest/> (version 2.10).
