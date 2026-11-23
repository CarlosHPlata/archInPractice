// Observability plumbing for the orders service: JSON logs, Prometheus metrics
// and OpenTelemetry tracing. The business code is in index.ts.
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { MiddlewareHandler } from "hono";
import { Counter, Histogram, Registry } from "prom-client";

const SERVICE = "orders";

// ---------- tracing: OTLP over HTTP, W3C traceparent ----------

// The endpoint comes from OTEL_EXPORTER_OTLP_ENDPOINT (see docker-compose.yml).
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": SERVICE }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(), { scheduledDelayMillis: 1000 })],
});
provider.register(); // installs the W3C propagator and the async context manager
const tracer = trace.getTracer(SERVICE);
process.on("SIGTERM", () => provider.shutdown().finally(() => process.exit(0)));

/** Trace id of the current request, or "-" if there is none. */
export function traceId(): string {
  return trace.getActiveSpan()?.spanContext().traceId ?? "-";
}

// ---------- logs: one JSON object per line on stdout ----------

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = { ts: new Date().toISOString(), level, service: SERVICE, msg, trace_id: traceId(), ...fields };
  process.stdout.write(JSON.stringify(line) + "\n");
}

// ---------- metrics: exposed on /metrics ----------

const registry = new Registry();
const httpRequests = new Counter({
  name: "http_requests_total",
  help: "HTTP requests handled.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});
const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration.",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
export const ordersMismatch = new Counter({
  name: "orders_mismatch_total",
  help: "Orders rejected because the cart did not belong to the customer.",
  registers: [registry],
});
export const metricsText = () => registry.metrics();

// ---------- middleware: metrics and tracing around every request ----------

// THE KEY RULE: this service never starts a trace of its own. If the request
// has no "traceparent" header, no span is created and logs carry trace_id "-".
// If it has one, the handler runs inside a child span of the caller's trace.
export const telemetry: MiddlewareHandler = async (c, next) => {
  const route = c.req.path;
  if (route === "/metrics" || route === "/healthz") return next();
  const method = c.req.method;
  const stopTimer = httpDuration.startTimer({ method, route });
  const record = () => {
    stopTimer();
    httpRequests.inc({ method, route, status: String(c.res.status) });
  };

  const headers = Object.fromEntries(c.req.raw.headers);
  const parent = propagation.extract(ROOT_CONTEXT, headers);
  if (!trace.getSpanContext(parent)) {
    await next();
    return record();
  }

  const span = tracer.startSpan(`${method} ${route}`, { kind: SpanKind.SERVER }, parent);
  await context.with(trace.setSpan(parent, span), next);
  c.header("x-trace-id", span.spanContext().traceId);
  span.setAttributes({ "http.request.method": method, "http.route": route, "http.response.status_code": c.res.status });
  if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
  record();
};

// ---------- outgoing calls: forward the trace to the next service ----------

/** GET another service. Inside a trace it adds a client span and the traceparent header. */
export async function callService(name: string, url: string): Promise<Response> {
  if (!trace.getActiveSpan()) return fetch(url); // no trace: nothing to forward

  const span = tracer.startSpan(`GET ${name}`, { kind: SpanKind.CLIENT, attributes: { "url.full": url } });
  const headers: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), headers); // writes "traceparent"
  try {
    const res = await fetch(url, { headers });
    span.setAttribute("http.response.status_code", res.status);
    if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    return res;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}
