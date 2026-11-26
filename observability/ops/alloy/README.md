# alloy (Grafana Alloy)

## What it is for

Alloy is the collector: the one agent that picks up telemetry and forwards it to the right storage. Services do not talk to Loki or Tempo directly. It does two jobs here:

1. **Logs.** It reads the stdout of the store's containers through the Docker API and pushes the lines to Loki.
2. **Traces.** It receives spans over OTLP from the gateway and the services, and forwards them to Tempo.

Metrics do not pass through Alloy: Prometheus scrapes the services itself.

## How it is configured

Everything is in `config.alloy`, mounted at `/etc/alloy`. The file is a pipeline of components, each one feeding the next.

Logs:

| Component | What it does |
| --- | --- |
| `discovery.docker` | lists the containers of the compose project `otzzo`, every 5 seconds |
| `discovery.relabel` | keeps `gateway`, `orders`, `cart`, `customers` and sets the label `service` to the compose service name |
| `loki.source.docker` | tails the stdout and stderr of those containers |
| `loki.write` | pushes to `http://loki:3100` |

`service` is the only label. Fields inside the JSON line, such as `trace_id` or `level`, are not labels: they are read at query time with `| json`.

Traces:

| Component | What it does |
| --- | --- |
| `otelcol.receiver.otlp` | listens on `4317` (gRPC) and `4318` (HTTP) |
| `otelcol.processor.batch` | groups spans, sends at least every second |
| `otelcol.exporter.otlp` | forwards to `tempo:4317` |

In `docker-compose.yml` the container runs as root and mounts `/var/run/docker.sock` read-only, which is what lets it see the other containers and their logs. The services find it through `OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318`.

## Without the Docker socket

Reading the stdout of other containers needs the Docker socket. Where a container cannot have it (the Shrine deployment), the `observer-alloy` image runs `config.shrine.alloy` instead: the logs part is a `loki.source.api` component, a Loki push endpoint on port `3500`, and each service sends its own lines there when `LOG_PUSH_URL` is set. The lines and the `service` label are the same, so the queries do not change. The access log of the gateway is not collected in that deployment.

## Working with it

```
docker compose logs alloy
docker compose restart alloy     # after changing config.alloy
```

Reference: <https://grafana.com/docs/alloy/latest/> (version 1.22).
