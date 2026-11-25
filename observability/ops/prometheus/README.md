# prometheus

## What it is for

Prometheus collects the metrics. It works by pulling: every few seconds it calls `/metrics` on each service, reads the current value of every counter and histogram, and stores them as time series. Grafana then asks it questions in PromQL.

## How it is configured

`prometheus.yml`, mounted at `/etc/prometheus`.

- **Scrape every 5 seconds.**
- **One job, `otzzo`, with three targets**, each with a `service` label:

  | Target | `service` |
  | --- | --- |
  | `orders:3000` | `orders` |
  | `cart:8080` | `cart` |
  | `customers:8000` | `customers` |

- **Retention of 1 day**, set with a flag in `docker-compose.yml`. There is no volume: `docker compose down` deletes the data.

All three services expose the same two metrics, so one query covers them all:

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |

The services also expose business metrics: `orders_checkouts_total`, `orders_units_sold_total`, `orders_units_cancelled_total`, `orders_discount_amount_total` and `orders_stored` (orders); `stock_units_reserved_total`, `stock_units_released_total` and `stock_units_available` (cart); `order_history_requests_total` and `order_history_orders_returned_total` (customers).

## Working with it

Query it from Grafana (Explore > Prometheus):

```promql
sum by (service) (rate(http_requests_total[1m]))
sum by (service) (rate(http_requests_total{status=~"5.."}[1m]))
histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[1m])))
```

A metric tells you that something is wrong and how often. It does not tell you which request, or why.

Reference: <https://prometheus.io/docs/> (version 3.16).
