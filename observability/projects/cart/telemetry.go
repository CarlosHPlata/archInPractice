// Observability plumbing for the cart service: JSON logs, Prometheus metrics
// and OpenTelemetry tracing. The business code is in main.go.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const serviceName = "cart"

// ---------- logs: one JSON object per line on stdout ----------

// logHandler adds "service" and "trace_id" to every log line.
type logHandler struct{ slog.Handler }

func (h logHandler) Handle(ctx context.Context, r slog.Record) error {
	r.AddAttrs(slog.String("service", serviceName), slog.String("trace_id", traceID(ctx)))
	return h.Handler.Handle(ctx, r)
}

// traceID returns the trace id of the current request, or "-" if there is none.
func traceID(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		return sc.TraceID().String()
	}
	return "-"
}

func setupLogs() {
	json := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.TimeKey:
				a.Key = "ts"
			case slog.LevelKey:
				a.Value = slog.StringValue(strings.ToLower(a.Value.String()))
			}
			return a
		},
	})
	slog.SetDefault(slog.New(logHandler{json}))
}

// ---------- metrics: exposed on /metrics ----------

var (
	httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "HTTP requests handled.",
	}, []string{"method", "route", "status"})
	httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "HTTP request duration.",
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5},
	}, []string{"method", "route"})
	registry = prometheus.NewRegistry()
)

func metricsHandler() http.Handler {
	return promhttp.HandlerFor(registry, promhttp.HandlerOpts{})
}

// ---------- tracing: OTLP over HTTP, W3C traceparent ----------

func setupTelemetry() (shutdown func()) {
	setupLogs()
	registry.MustRegister(httpRequests, httpDuration)

	// The endpoint comes from OTEL_EXPORTER_OTLP_ENDPOINT (see docker-compose.yml).
	exporter, err := otlptracehttp.New(context.Background())
	if err != nil {
		slog.Error("cannot create trace exporter: " + err.Error())
		os.Exit(1)
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(time.Second)),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", serviceName))),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return func() { provider.Shutdown(context.Background()) }
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// instrument wraps a handler with metrics and tracing.
//
// THE KEY RULE: this service never starts a trace of its own. If the request
// has no "traceparent" header, no span is created and logs carry trace_id "-".
// If it has one, the handler runs inside a child span of the caller's trace.
func instrument(route string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		var span trace.Span
		if trace.SpanContextFromContext(ctx).IsValid() {
			ctx, span = otel.Tracer(serviceName).Start(ctx, r.Method+" "+route, trace.WithSpanKind(trace.SpanKindServer))
		}

		next(rec, r.WithContext(ctx))

		if span != nil {
			span.SetAttributes(attribute.String("http.request.method", r.Method), attribute.String("http.route", route),
				attribute.Int("http.response.status_code", rec.status))
			if rec.status >= 500 {
				span.SetStatus(codes.Error, http.StatusText(rec.status))
			}
			span.End()
		}
		httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
		httpDuration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}
