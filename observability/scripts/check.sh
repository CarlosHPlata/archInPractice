#!/usr/bin/env bash
# Checks the homework: the failing order must now return 201 and a flag.
# Usage: ./scripts/check.sh
set -u

URL="${ORDERS_URL:-http://localhost:8080/orders}"
BODY='{"customerId":"c-1002","cartId":"cart-7"}'

echo "POST $URL"
echo "     $BODY"
echo

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
response="$(curl -sS -m 15 -D "$headers" -w '\n%{http_code}' -X POST "$URL" \
  -H 'Content-Type: application/json' -d "$BODY")" || {
  echo "FAIL: could not reach the gateway. Is the stack running? (docker compose up --build)"
  exit 1
}
status="${response##*$'\n'}"
body="${response%$'\n'*}"
trace_id="$(tr -d '\r' < "$headers" | awk -F': ' 'tolower($1) == "x-trace-id" { print $2 }')"
flag="$(printf '%s' "$body" | grep -o 'FLAG{[^}"]*}' | head -n 1)"

echo "HTTP status : $status"
echo "Body        : $body"
echo "x-trace-id  : ${trace_id:-(none: the request reached orders without a trace id)}"
echo

if [ "$status" = "201" ] && [ -n "$flag" ]; then
  if [ -z "$trace_id" ]; then
    echo "ALMOST: the order works, but there is still no trace id. Tracing at the gateway is part of the homework."
    exit 1
  fi
  echo "PASS: the order was created. Your flag is $flag"
  exit 0
fi

echo "FAIL: expected HTTP 201 with a flag, got HTTP $status."
if [ -z "$trace_id" ]; then
  echo "      Next step: no trace id yet, so the logs of the services cannot be correlated. Start at the gateway."
else
  echo "      Next step: follow trace $trace_id in Grafana (logs and trace) to find where the order goes wrong."
fi
exit 1
