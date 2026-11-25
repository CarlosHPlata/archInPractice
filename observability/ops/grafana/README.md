# grafana

## What it is for

Grafana is the screen in front of the three storages. It holds no telemetry of its own: it queries Prometheus (metrics), Loki (logs) and Tempo (traces) and shows the results, in dashboards or in Explore. It also links the three, so you can go from a log line to its trace and back.

Open it at <http://localhost:3000>. There is no login: anonymous access with the Admin role is switched on in `docker-compose.yml`, which is fine for a laptop and nowhere else.

## How it is configured

Nothing is set up by hand. Grafana loads these files at startup ("provisioning"):

| File | What it sets up |
| --- | --- |
| `provisioning/datasources/datasources.yml` | the three data sources and the links between them |
| `provisioning/dashboards/dashboards.yml` | tells Grafana to load every dashboard in `dashboards/` |
| `dashboards/otzzo-orders.json` | the dashboard "Otzzo - Store", also the home page |

The links between signals, in `datasources.yml`:

- **Log to trace.** On the Loki data source, a *derived field* looks for `"trace_id":"<32 hex characters>"` in each log line and turns it into a link that opens that trace in Tempo. A line with `"trace_id":"-"` gets no link.
- **Trace to logs.** On the Tempo data source, `tracesToLogsV2` adds a *Related logs* button that runs `{service=~".+"} | json | trace_id="<the trace id>"` in Loki.

The dashboard has the RED method per service on the first row, then business metrics that show what the store is doing:

| Panel | Source | Shows |
| --- | --- | --- |
| Request rate | Prometheus | requests per second |
| Error rate (5xx) | Prometheus | failed requests per second |
| Duration p50 / p95 / p99 | Prometheus | how long requests take |
| Checkouts by outcome | Prometheus | `orders_checkouts_total`: confirmed orders and each error code |
| Confirmed checkouts in the past hour | Prometheus | one big number: orders confirmed in the last 60 minutes |
| Errors in the past hour | Prometheus | one big number: 5xx answers of all services in the last 60 minutes |
| Answers with an error status | Prometheus | 4xx and 5xx per service and status |
| Discount given, by loyalty tier of the buyer | Prometheus | `orders_discount_amount_total` |
| Smart TV 55": units sold and units reserved | Prometheus | `orders_units_sold_total` (orders) next to `stock_units_reserved_total` (cart) |
| Order history: orders listed per request | Prometheus | `order_history_orders_returned_total` (customers) next to `orders_stored` (orders) |
| Logs | Loki | the latest lines of the three services |

## Working with it

- **Explore** (left menu) is where you write your own queries: pick Loki, Tempo or Prometheus at the top.
- Changes to the provisioning files need `docker compose restart grafana`. Changes made in the UI are lost on `docker compose down`.

Reference: <https://grafana.com/docs/grafana/latest/> (version 13.3).
