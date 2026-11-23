"""Observability plumbing for the customers service: JSON logs, Prometheus
metrics and OpenTelemetry tracing. The business code is in main.py."""
import json
import sys
import time
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
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()


# ---------- metrics: exposed on /metrics ----------

registry = CollectorRegistry()
http_requests = Counter("http_requests_total", "HTTP requests handled.",
                        ["method", "route", "status"], registry=registry)
http_duration = Histogram("http_request_duration_seconds", "HTTP request duration.",
                          ["method", "route"], registry=registry,
                          buckets=[.005, .01, .025, .05, .1, .25, .5, 1, 2.5])


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

    parent = propagate.extract(request.headers)
    if trace.get_current_span(parent).get_span_context().is_valid:
        with tracer.start_as_current_span(f"{method} {request.url.path}", context=parent, kind=SpanKind.SERVER) as span:
            response = await call_next(request)
            span.set_attribute("http.request.method", method)
            span.set_attribute("http.response.status_code", response.status_code)
            if response.status_code >= 500:
                span.set_status(StatusCode.ERROR)
    else:
        response = await call_next(request)

    matched = request.scope.get("route")
    route = matched.path if matched else request.url.path
    http_requests.labels(method, route, str(response.status_code)).inc()
    http_duration.labels(method, route).observe(time.perf_counter() - start)
    return response
