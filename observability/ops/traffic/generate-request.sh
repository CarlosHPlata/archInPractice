#!/bin/sh
# Sends orders to the store, like the customers of a real web shop would.
#
#   ./ops/traffic/generate-request.sh 3     send 3 random orders, print a summary, exit
#   ./ops/traffic/generate-request.sh       stream: a small burst of orders every few seconds, forever
#   ./ops/traffic/generate-request.sh --verbose 3    also print each request and its response
#
# The "traffic" container in docker-compose.yml runs the stream mode as soon as
# the gateway is healthy. Settings (environment variables):
#   ORDERS_URL   where to send the orders   (default http://localhost:8080/orders)
#   INTERVAL     seconds between two bursts (default 3)
#   MAX_BURST    a burst has 1..MAX_BURST orders (default 4)
#   VERBOSE      1 = same as --verbose (default 0)
set -u

URL="${ORDERS_URL:-http://localhost:8080/orders}"
INTERVAL="${INTERVAL:-3}"
MAX_BURST="${MAX_BURST:-4}"
VERBOSE="${VERBOSE:-0}"
COUNT=""

for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    ""|*[!0-9]*) echo "usage: $0 [--verbose] [number-of-requests]"; exit 2 ;;
    *) COUNT="$arg" ;;
  esac
done

# rand N: a random number between 0 and N-1 (works in any POSIX sh)
rand() {
  n="$(od -An -N2 -tu2 /dev/urandom | tr -d ' \n')"
  echo $((n % $1))
}

# What the customers of the shop are buying right now. Most visitors are
# returning customers with their usual cart; a few arrive with a stale link.
pick_order() {
  r="$(rand 100)"
  if   [ "$r" -lt 30 ]; then CUSTOMER=c-1001; CART=cart-7
  elif [ "$r" -lt 55 ]; then CUSTOMER=c-1002; CART=cart-9
  elif [ "$r" -lt 80 ]; then CUSTOMER=c-1003; CART=cart-3
  elif [ "$r" -lt 95 ]; then CUSTOMER=c-1002; CART=cart-7
  else CUSTOMER="c-$((2000 + $(rand 8000)))"; CART="cart-$((1 + $(rand 40)))"
  fi
}

pick_browser() {
  case "$(rand 5)" in
    0) AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" ;;
    1) AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15" ;;
    2) AGENT="Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1" ;;
    3) AGENT="Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" ;;
    *) AGENT="OtzzoApp/4.12.0 (Android 15)" ;;
  esac
}

sent=0; ok=0; failed=0; other=0

send_order() {
  pick_order
  pick_browser
  body="{\"customerId\":\"$CUSTOMER\",\"cartId\":\"$CART\"}"
  # -i puts the response headers and body first; -w adds one last line with the numbers
  output="$(curl -s -i -m 10 -X POST "$URL" \
    -H 'Content-Type: application/json' -A "$AGENT" -d "$body" \
    -w '\n%{http_code} %{time_total} %header{x-trace-id}' | tr -d '\r')"
  result="${output##*
}"
  response="${output%
*}"
  status="${result%% *}"; rest="${result#* }"
  seconds="${rest%% *}"; trace_id="${rest#* }"
  sent=$((sent + 1))
  case "$status" in
    2*) ok=$((ok + 1)) ;;
    5*|000) failed=$((failed + 1)) ;;
    *) other=$((other + 1)) ;;
  esac
  echo "$(date +%H:%M:%S)  $status  $CUSTOMER $CART  ${seconds}s  trace_id=${trace_id:--}"
  if [ "$VERBOSE" = "1" ]; then
    echo "  > POST $URL"
    echo "  > Content-Type: application/json"
    echo "  > User-Agent: $AGENT"
    echo "  > $body"
    if [ -n "$response" ]; then
      printf '%s\n' "$response" | sed '/^$/d; s/^/  < /'
    else
      echo "  < (no answer)"
    fi
    echo
  fi
}

summary() {
  echo "sent=$sent  ok(2xx)=$ok  failed(5xx or no answer)=$failed  other(4xx)=$other"
}

if [ -n "$COUNT" ]; then
  # manual mode: N orders, then stop
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    send_order
    i=$((i + 1))
  done
  summary
  exit 0
fi

# stream mode: a burst of 1..MAX_BURST orders every INTERVAL seconds
trap 'summary; exit 0' INT TERM
echo "sending orders to $URL: 1 to $MAX_BURST every ${INTERVAL}s (stop with Ctrl+C or: docker compose stop traffic)"
while true; do
  burst=$((1 + $(rand "$MAX_BURST")))
  i=0
  while [ "$i" -lt "$burst" ]; do
    send_order
    i=$((i + 1))
  done
  sleep "$INTERVAL"
done
