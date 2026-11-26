"""Observability plumbing for the customers service: JSON logs, Prometheus
metrics and OpenTelemetry tracing. The business code is in main.py."""
import asyncio
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import Response
from opentelemetry import propagate, trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, StatusCode
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest

SERVICE = "customers"

# ---------- tracing: OTLP over HTTP, W3C traceparent ----------

# The endpoint comes from OTEL_EXPORTER_OTLP_ENDPOINT (see docker-compose.yml).
provider = TracerProvider(resource=Resource({"service.name": SERVICE}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(), schedule_delay_millis=1000))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer(SERVICE)


def trace_id() -> str:
    """Trace id of the current request, or "-" if there is none."""
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else "-"


# ---------- logs: one JSON object per line on stdout ----------

def log(level: str, msg: str, **fields) -> None:
    line = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": level, "service": SERVICE, "msg": msg, "trace_id": trace_id(), **fields,
    }
    text = json.dumps(line)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    _push_log(text)


# Where nothing can read the stdout of the containers, LOG_PUSH_URL names a
# Loki push endpoint (Alloy's) and every line is also sent there, once a
# second, with the label "service". Without the variable nothing is sent.
# A line that cannot be delivered is dropped: logging never fails a request.
LOG_PUSH_URL = os.environ.get("LOG_PUSH_URL")
_pending_logs: queue.Queue = queue.Queue(maxsize=5000)


def _push_log(text: str) -> None:
    if not LOG_PUSH_URL:
        return
    try:
        _pending_logs.put_nowait([str(time.time_ns()), text])  # Loki wants nanoseconds
    except queue.Full:
        pass


def _flush_logs_forever() -> None:
    while True:
        time.sleep(1)
        values = []
        while not _pending_logs.empty():
            values.append(_pending_logs.get_nowait())
        if not values:
            continue
        body = json.dumps({"streams": [{"stream": {"service": SERVICE}, "values": values}]}).encode()
        request = urllib.request.Request(LOG_PUSH_URL, data=body, headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(request, timeout=2).close()
        except (urllib.error.URLError, TimeoutError, OSError):
            pass  # dropped, see above


if LOG_PUSH_URL:
    threading.Thread(target=_flush_logs_forever, daemon=True).start()


# ---------- metrics: exposed on /metrics ----------

registry = CollectorRegistry()
http_requests = Counter("http_requests_total", "HTTP requests handled.",
                        ["method", "route", "status"], registry=registry)
http_duration = Histogram("http_request_duration_seconds", "HTTP request duration.",
                          ["method", "route"], registry=registry,
                          buckets=[.005, .01, .025, .05, .1, .25, .5, 1, 2.5])


# business metrics: what the order history hands out
history_requests = Counter("order_history_requests_total", "Order histories served.", registry=registry)
history_orders = Counter("order_history_orders_returned_total", "Orders listed in the order histories served.",
                         registry=registry)


def metrics_response() -> Response:
    return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)


# ---------- middleware: metrics and tracing around every request ----------

async def telemetry_middleware(request: Request, call_next):
    """THE KEY RULE: this service never starts a trace of its own. If the request
    has no "traceparent" header, no span is created and logs carry trace_id "-".
    If it has one, the handler runs inside a child span of the caller's trace."""
    if request.url.path in ("/metrics", "/healthz"):
        return await call_next(request)
    start = time.perf_counter()
    method = request.method

    def finished(response) -> None:
        ms = round((time.perf_counter() - start) * 1000)
        log("info", f"request finished: {method} {request.url.path} answered {response.status_code} in {ms} ms")

    parent = propagate.extract(request.headers)
    if trace.get_current_span(parent).get_span_context().is_valid:
        with tracer.start_as_current_span(f"{method} {request.url.path}", context=parent, kind=SpanKind.SERVER) as span:
            response = await call_next(request)
            response.headers["x-trace-id"] = trace_id()
            span.set_attribute("http.request.method", method)
            span.set_attribute("http.response.status_code", response.status_code)
            if response.status_code >= 500:
                span.set_status(StatusCode.ERROR)
            finished(response)
    else:
        response = await call_next(request)
        finished(response)

    matched = request.scope.get("route")
    route = matched.path if matched else request.url.path
    http_requests.labels(method, route, str(response.status_code)).inc()
    http_duration.labels(method, route).observe(time.perf_counter() - start)
    return response


# ---------- outgoing calls: forward the trace to the next service ----------

def _get(url: str, headers: dict) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=2) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, {}
    except (urllib.error.URLError, TimeoutError):
        return 0, {}


async def call_service(name: str, url: str) -> tuple[int, dict]:
    """GET another service; returns (status, JSON body). Status 0 means no answer.
    Inside a trace it adds a client span and the traceparent header."""
    if not trace.get_current_span().get_span_context().is_valid:
        return await asyncio.to_thread(_get, url, {})  # no trace: nothing to forward

    with tracer.start_as_current_span(f"GET {name}", kind=SpanKind.CLIENT, attributes={"url.full": url}) as span:
        headers: dict = {}
        propagate.inject(headers)  # writes "traceparent"
        status, body = await asyncio.to_thread(_get, url, headers)
        span.set_attribute("http.response.status_code", status)
        if status == 0 or status >= 500:
            span.set_status(StatusCode.ERROR)
        return status, body
