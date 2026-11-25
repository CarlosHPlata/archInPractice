#!/bin/sh
# Plays the customers of the store: they look at their cart, change it, check
# their order history, place orders (some as a gift) and sometimes cancel one.
#
#   ./ops/traffic/generate-request.sh 5     send 5 random requests, print a summary, exit
#   ./ops/traffic/generate-request.sh       stream: a small burst of requests every few seconds, forever
#   ./ops/traffic/generate-request.sh --verbose 5    also print each request and its response
#
# The "traffic" container in docker-compose.yml runs the stream mode as soon as
# the gateway is healthy. Settings (environment variables):
#   STORE_URL    the gateway of the store   (default http://localhost:8080)
#   INTERVAL     seconds between two bursts (default 3)
#   MAX_BURST    a burst has 1..MAX_BURST requests (default 3)
#   VERBOSE      1 = same as --verbose (default 0)
set -u

URL="${STORE_URL:-http://localhost:8080}"
INTERVAL="${INTERVAL:-3}"
MAX_BURST="${MAX_BURST:-3}"
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

# Each customer has one cart.
pick_customer() {
  case "$(rand 5)" in
    0) CUSTOMER=c-1001; CART=cart-7 ;;
    1) CUSTOMER=c-1002; CART=cart-9 ;;
    2) CUSTOMER=c-1003; CART=cart-3 ;;
    3) CUSTOMER=c-1004; CART=cart-12 ;;
    *) CUSTOMER=c-1005; CART=cart-5 ;;
  esac
}

order() { METHOD=POST; REQ_PATH=/orders; BODY="{\"customerId\":\"$1\",\"cartId\":\"$2\"}"; }
gift()  { METHOD=POST; REQ_PATH=/orders; BODY="{\"customerId\":\"$1\",\"cartId\":\"$2\",\"recipientId\":\"$3\"}"; }

LAST_ORDER="" # id of the last order that was accepted: the next one to be cancelled

# What the customers of the shop are doing right now.
pick_request() {
  BODY=""
  r="$(rand 100)"
  if   [ "$r" -lt 20 ]; then order c-1001 cart-7
  elif [ "$r" -lt 34 ]; then order c-1002 cart-9
  elif [ "$r" -lt 46 ]; then order c-1005 cart-5
  elif [ "$r" -lt 52 ]; then order c-1003 cart-3
  elif [ "$r" -lt 57 ]; then order c-1004 cart-12
  elif [ "$r" -lt 61 ]; then gift c-1002 cart-9 c-1001
  elif [ "$r" -lt 64 ]; then gift c-1005 cart-5 c-1001
  elif [ "$r" -lt 66 ]; then gift c-1001 cart-7 c-1005
  elif [ "$r" -lt 76 ]; then pick_customer; METHOD=GET; REQ_PATH="/customers/$CUSTOMER/orders"
  elif [ "$r" -lt 85 ]; then pick_customer; METHOD=GET; REQ_PATH="/carts/$CART?customerId=$CUSTOMER"
  elif [ "$r" -lt 91 ]; then
    # only the carts of c-1002 and c-1005 get extras
    if [ "$(rand 2)" = 0 ]; then CART=cart-9; else CART=cart-5; fi
    if [ "$(rand 2)" = 0 ]; then SKU=cb-3; else SKU=mg-7; fi
    METHOD=PUT; REQ_PATH="/carts/$CART/items/$SKU"; BODY="{\"qty\":$(rand 4)}"
  elif [ "$r" -lt 95 ] && [ -n "$LAST_ORDER" ]; then
    METHOD=POST; REQ_PATH="/orders/$LAST_ORDER/cancel"; LAST_ORDER=""
  else
    # a visitor with a stale link: this customer does not exist
    order "c-$((2000 + $(rand 8000)))" "cart-$((20 + $(rand 40)))"
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

send_request() {
  pick_request
  pick_browser
  # -i puts the response headers and body first; -w adds one last line with the numbers
  if [ -n "$BODY" ]; then
    output="$(curl -s -i -m 10 -X "$METHOD" "$URL$REQ_PATH" \
      -H 'Content-Type: application/json' -A "$AGENT" -d "$BODY" \
      -w '\n%{http_code} %{time_total} %header{x-trace-id}' | tr -d '\r')"
  else
    output="$(curl -s -i -m 10 -X "$METHOD" "$URL$REQ_PATH" -A "$AGENT" \
      -w '\n%{http_code} %{time_total} %header{x-trace-id}' | tr -d '\r')"
  fi
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
  if [ "$status" = "201" ]; then
    LAST_ORDER="$(printf '%s' "$response" | sed -n 's/.*"orderId":"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  echo "$(date +%H:%M:%S)  $status  $METHOD $REQ_PATH ${BODY:+$BODY }${seconds}s  trace_id=${trace_id:--}"
  if [ "$VERBOSE" = "1" ]; then
    echo "  > $METHOD $URL$REQ_PATH"
    echo "  > User-Agent: $AGENT"
    [ -n "$BODY" ] && echo "  > $BODY"
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
  # manual mode: N requests, then stop
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    send_request
    i=$((i + 1))
  done
  summary
  exit 0
fi

# stream mode: a burst of 1..MAX_BURST requests every INTERVAL seconds
trap 'summary; exit 0' INT TERM
echo "sending requests to $URL: 1 to $MAX_BURST every ${INTERVAL}s (stop with Ctrl+C or: docker compose stop traffic)"
while true; do
  burst=$((1 + $(rand "$MAX_BURST")))
  i=0
  while [ "$i" -lt "$burst" ]; do
    send_request
    i=$((i + 1))
  done
  sleep "$INTERVAL"
done
