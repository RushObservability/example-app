/**
 * Patches console methods to emit span events on the active OTel span.
 *
 * Controlled by RUSH_LOG_EVENTS env var (default: "true").
 * When enabled, console.log/info/warn/error calls also produce
 * span events so log lines appear in the trace waterfall.
 */

const { trace } = require('@opentelemetry/api');

const ENABLED = (process.env.RUSH_LOG_EVENTS || 'true').toLowerCase() !== 'false';

// The service's declared OTel service.name (same value tracing.js puts on the
// trace resource). Appended to every log line so Vector resolves the log's
// ServiceName from the app's identity — exactly like APM — instead of the
// container/compose name. Vector strips it back off before storing Body.
const SERVICE_NAME = process.env.SERVICE_NAME || '';

const LEVELS = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function patchConsole() {
  if (!ENABLED) return;

  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      const span = trace.getActiveSpan();
      if (span) {
        // Emit a span event so the log shows in the trace waterfall (clean
        // message, no correlation suffix — the span already IS this trace).
        const message = args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        span.addEvent('log', {
          'log.level': level,
          'log.message': message,
        });

        // Append service + trace context so Vector can lift them into the logs
        // table's ServiceName / TraceId / SpanId columns (service resolution +
        // log↔trace correlation). Vector strips this suffix before storing Body.
        const ctx = span.spanContext();
        const svc = SERVICE_NAME ? `service.name=${SERVICE_NAME} ` : '';
        original(...args, `${svc}trace_id=${ctx.traceId} span_id=${ctx.spanId}`);
      } else if (SERVICE_NAME) {
        // No active span (startup, timers): still declare the service so the
        // log's ServiceName matches APM rather than the container name.
        original(...args, `service.name=${SERVICE_NAME}`);
      } else {
        original(...args);
      }
    };
  }
}

module.exports = { patchConsole };
