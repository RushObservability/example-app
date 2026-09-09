const { metrics } = require('@opentelemetry/api');

// Shared meter for all services
const meter = metrics.getMeter(process.env.SERVICE_NAME || 'unknown');

// ── Standard HTTP metrics (RED pattern) ──

const httpRequestsTotal = meter.createCounter('http_requests_total', {
  description: 'Total number of HTTP requests',
  unit: '1',
});

const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
});

const httpRequestsInFlight = meter.createUpDownCounter('http_requests_in_flight', {
  description: 'Number of HTTP requests currently being processed',
  unit: '1',
});

// ── Express middleware to record metrics ──

function metricsMiddleware(req, res, next) {
  // Skip health checks
  if (req.path === '/health' || req.path === '/healthz') {
    return next();
  }

  const start = process.hrtime.bigint();
  const service = process.env.SERVICE_NAME || 'unknown';

  httpRequestsInFlight.add(1, { service_name: service });

  // Hook into response finish
  const originalEnd = res.end;
  res.end = function (...args) {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;

    const labels = {
      service_name: service,
      method: req.method,
      path: req.route?.path || req.path,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.add(1, labels);
    httpRequestDuration.record(durationSec, labels);
    httpRequestsInFlight.add(-1, { service_name: service });

    originalEnd.apply(res, args);
  };

  next();
}

module.exports = { metricsMiddleware, meter };
