// Observability plumbing for the orders service: JSON logs, Prometheus metrics
// and OpenTelemetry tracing. The business code is in index.ts.
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { MiddlewareHandler } from "hono";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

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
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, msg, trace_id: traceId(), ...fields });
  process.stdout.write(line + "\n");
  pushLog(line);
}

// Where nothing can read the stdout of the containers, LOG_PUSH_URL names a
// Loki push endpoint (Alloy's) and every line is also sent there, once a
// second, with the label "service". Without the variable nothing is sent.
// A line that cannot be delivered is dropped: logging never fails a request.
const LOG_PUSH_URL = process.env.LOG_PUSH_URL;
const MAX_PENDING_LOGS = 5000;
let pendingLogs: [string, string][] = [];
let logSequence = 0;

function pushLog(line: string): void {
  if (!LOG_PUSH_URL || pendingLogs.length >= MAX_PENDING_LOGS) return;
  // Loki wants nanoseconds; the sequence keeps lines of the same millisecond in order.
  logSequence = (logSequence + 1) % 1_000_000;
  pendingLogs.push([`${Date.now()}${String(logSequence).padStart(6, "0")}`, line]);
}

async function flushLogs(): Promise<void> {
  if (!LOG_PUSH_URL || pendingLogs.length === 0) return;
  const values = pendingLogs;
  pendingLogs = [];
  try {
    await fetch(LOG_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streams: [{ stream: { service: SERVICE }, values }] }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // dropped, see above
  }
}
if (LOG_PUSH_URL) setInterval(flushLogs, 1000).unref();

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
// business metrics: what happens to the checkouts
export const checkouts = new Counter({
  name: "orders_checkouts_total",
  help: "Checkouts by outcome: confirmed, or the error code answered to the client.",
  labelNames: ["outcome"],
  registers: [registry],
});
export const unitsSold = new Counter({
  name: "orders_units_sold_total",
  help: "Units in confirmed orders.",
  labelNames: ["sku"],
  registers: [registry],
});
export const unitsCancelled = new Counter({
  name: "orders_units_cancelled_total",
  help: "Units in cancelled orders.",
  labelNames: ["sku"],
  registers: [registry],
});
export const discountGiven = new Counter({
  name: "orders_discount_amount_total",
  help: "Discount given in confirmed orders, by the loyalty tier of the buyer.",
  labelNames: ["buyer_tier"],
  registers: [registry],
});
export const ordersStored = new Gauge({
  name: "orders_stored",
  help: "Orders in the order store, per customer.",
  labelNames: ["customer_id"],
  registers: [registry],
});
export const metricsText = () => registry.metrics();

// ---------- middleware: metrics and tracing around every request ----------

// THE KEY RULE: this service never starts a trace of its own. If the request
// has no "traceparent" header, no span is created and logs carry trace_id "-".
// If it has one, the handler runs inside a child span of the caller's trace.
export const telemetry: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (path === "/metrics" || path === "/healthz") return next();
  const route = path.replace(/ord-[0-9a-f]+/, ":id"); // keeps the metric labels few
  const method = c.req.method;
  const started = Date.now();
  const stopTimer = httpDuration.startTimer({ method, route });
  const handle = async () => {
    await next();
    stopTimer();
    httpRequests.inc({ method, route, status: String(c.res.status) });
    log("info", `request finished: ${method} ${path} answered ${c.res.status} in ${Date.now() - started} ms`);
  };

  const headers = Object.fromEntries(c.req.raw.headers);
  const parent = propagation.extract(ROOT_CONTEXT, headers);
  if (!trace.getSpanContext(parent)) return handle();

  const span = tracer.startSpan(`${method} ${route}`, { kind: SpanKind.SERVER }, parent);
  await context.with(trace.setSpan(parent, span), handle);
  c.header("x-trace-id", span.spanContext().traceId);
  span.setAttributes({ "http.request.method": method, "http.route": route, "http.response.status_code": c.res.status });
  if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
};

// ---------- outgoing calls: forward the trace to the next service ----------

export type CallOptions = { body?: unknown; timeoutMs: number };

/**
 * Calls another service and gives up after timeoutMs (fetch then throws a
 * TimeoutError). Inside a trace it adds a client span and the traceparent header.
 */
export async function callService(name: string, method: string, url: string, opts: CallOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(opts.timeoutMs) };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  if (!trace.getActiveSpan()) return fetch(url, init); // no trace: nothing to forward

  const span = tracer.startSpan(`${method} ${name}`, { kind: SpanKind.CLIENT, attributes: { "url.full": url } });
  propagation.inject(trace.setSpan(context.active(), span), headers); // writes "traceparent"
  try {
    const res = await fetch(url, init);
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
