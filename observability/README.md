# Otzzo: the order that will not go through

Hands-on homework for the observability session of *Architecture in Practice*.

## The story

It is the peak weekend at Otzzo, the online store. Customers are receiving wrong orders, alerts are piling up, and the on-call engineers face the usual question: with several microservices, **where** is the problem?

You are on call. One API call fails every single time. The metrics and the logs are already wired. One piece of the observability setup is missing, and until you add it you cannot follow a request from one service to the next.

## Your goal

1. Make every request get a **trace id** when it enters the system, so that logs and traces of all the services can be correlated.
2. Use the **log search, the traces and the dashboard** to find out why the call fails.
3. Fix it and get the.

The rule of the game: find the bug with the tools, not by reading the source code of the services. Open the code only when the tools have told you where to look and what to look for.

## What is running

```
you ──> gateway (Traefik, :8080) ──> orders ──> cart
                                           └──> customers
```

The repo has two main folders: `projects/` is the store's own code, `ops/` is everything needed to run and observe it. Each folder in `ops/` has a README that explains what the tool is for and how it is configured.

| Folder | What it is |
| --- | --- |
| `projects/orders/` | Node + Hono, `POST /orders` |
| `projects/cart/` | Go, `GET /carts/:id` |
| `projects/customers/` | Python + FastAPI, `GET /customers/:id` |
| `ops/gateway/` | Traefik, the only public entry point |
| `ops/alloy/` | Grafana Alloy: collects container logs, receives traces (OTLP) |
| `ops/loki/`, `ops/tempo/`, `ops/prometheus/` | storage for logs, traces and metrics |
| `ops/grafana/` | dashboards and Explore |
| `ops/traffic/` | a script that plays the customers of the shop and sends orders |
| `scripts/` | the check scripts |

## Start

You need Docker Desktop (about 1 GB of free RAM for the stack) and nothing else.

```
docker compose up --build
```

The first start downloads and builds images, so it takes a few minutes. It is ready when `gateway` is running. Then open Grafana at <http://localhost:3000> (no login).

To stop and delete everything: `docker compose down`.

## Traffic

A shop is never quiet. As soon as the gateway is healthy, the `traffic` container sends a small burst of random orders every 3 seconds: returning customers with their usual cart, different browsers, and now and then a link that no longer exists. Some of these orders work and some do not, as on the real peak weekend. You can watch it on the dashboard.

```
docker compose logs -f traffic     # see what it sends
docker compose stop traffic        # silence it
docker compose start traffic       # bring it back
```

You can also run the script yourself (macOS, Linux, Git Bash) to send an exact number of orders:

```bash
./ops/traffic/generate-request.sh 3
```

Because of this background traffic, your own request is one among many. That is the point of the trace id.

## The failing call

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

It answers `500 {"error":"order_mismatch"}`. Other orders work, for example customer `c-1001` with `cart-7`, or customer `c-1002` with `cart-9`. They are useful for comparing.

## Check your progress

```bash
./scripts/check.sh        # macOS, Linux, Git Bash
```

```powershell
.\scripts\check.ps1       # Windows PowerShell
```

The script sends the failing call and tells you whether the homework passes (HTTP 201 and a flag) or what is still missing.

## How the pieces are wired

- **Metrics.** Each service exposes `/metrics`. Prometheus scrapes them every 5 seconds.
- **Logs.** Each service writes JSON lines to stdout with `ts`, `level`, `service`, `msg`, `trace_id` and ids such as `order_id`, `cart_id`, `customer_id`. Alloy ships them to Loki with one label, `service`.
- **Traces.** Each service has the OpenTelemetry SDK and sends spans to Alloy, which forwards them to Tempo. Alloy receives OTLP at `alloy:4318` (HTTP) and `alloy:4317` (gRPC).
- **The key rule.** A service never starts a trace of its own. If a request arrives with a W3C `traceparent` header, the service joins that trace, logs its `trace_id` and passes the header on. If it arrives without one, there is no span and the log says `"trace_id":"-"`. Trace ids are created in one place only: the gateway, as in the slides.
- When a request has a trace id, `orders` returns it in the `x-trace-id` response header.

## Hints for the tools

**Logs (Grafana > Explore > Loki).** Switch the query editor to *Code* and try:

```logql
{service="orders"}
{service=~".+"} | json
{service=~".+"} | json | level="error"
{service=~".+"} | json | trace_id="PASTE-A-TRACE-ID"
```

`trace_id` is a field inside the log line, not a label, so it needs `| json` before the filter. Look at what the lines say today, before you change anything. Do not trust the log level alone: follow one request.

**Traces (Grafana > Explore > Tempo).** Paste a trace id in the *TraceQL* box to see the waterfall. A log line with a real trace id also has a link that opens its trace, and a trace has a *Related logs* button that goes back to the logs.

**Dashboard (Grafana > Dashboards > Otzzo - Orders).** Request rate, error rate and duration per service, a counter of rejected orders, and the latest logs.

**Gateway.** Traefik reads `ops/gateway/traefik.yml` once, at startup. Its documentation has a page on tracing. After changing the file:

```
docker compose restart gateway
```

**Rebuilding one service after a code change:**

```
docker compose up --build -d <service>
```

## What to hand in

- The flag.
- The trace id of one failing request, and two or three sentences on the clues that led you to the cause: which log lines, which spans, which panel.
- What you changed in the gateway and the one line you changed in the code.
