# traffic

## What it is for

A store with no visitors has empty dashboards. This container plays the customers: it sends random requests to the gateway (orders, gift orders, cancellations, cart views and changes, order histories) so the metrics, logs and traces always have something to show, and so your own request is one among many, as in production.

## How it is configured

One shell script, `generate-request.sh`, run by a small container that only has `curl`. The folder is mounted at `/traffic`. The container starts once the gateway is healthy.

Each request picks what a customer would do (mostly orders of returning customers, sometimes a customer that does not exist) and a browser or app User-Agent. Settings are environment variables in `docker-compose.yml`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORE_URL` | `http://localhost:8080` | the gateway of the store (`http://gateway:8080` in the container) |
| `INTERVAL` | `3` | seconds between two bursts |
| `MAX_BURST` | `3` | a burst has 1 to `MAX_BURST` requests |
| `VERBOSE` | `0` | `1` prints every request and response |

Its own output is not sent to Loki.

## Working with it

```
docker compose logs -f traffic     # see what it sends
docker compose stop traffic        # silence it
docker compose start traffic       # bring it back
```

By hand, from the root of the repo (macOS, Linux, Git Bash):

```bash
./ops/traffic/generate-request.sh 3             # send 3 requests and print a summary
./ops/traffic/generate-request.sh --verbose 3   # also print each request and response
./ops/traffic/generate-request.sh               # stream until Ctrl+C
```

Each line shows the time, the HTTP status, the request, the duration and the trace id of the request (`-` when it has none).
