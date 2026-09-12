const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.SERVICE_NAME || 'unknown';
const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION || '0.1.0',
    'deployment.environment': process.env.ENVIRONMENT || 'development',
    'host.name': require('os').hostname(),
  }),
  traceExporter: new OTLPTraceExporter({
    url: collectorUrl,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: collectorUrl,
    }),
    exportIntervalMillis: 15000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      // Disable noisy instrumentations that create standalone traces
      // with no log events (fs/dns/net fire outside HTTP request context)
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

sdk.start();

// Patch console to emit span events (controlled by RUSH_LOG_EVENTS, default: on)
const { patchConsole } = require('./log-events');
patchConsole();

const profiler = Promise.resolve().then(() => require('./profiling').startProfiling()).catch(() => {
  console.warn('[profiling] could not start; check the profiling environment configuration');
  return { stop: async () => {} };
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 9000);
  deadline.unref();
  await (await profiler).stop();
  await sdk.shutdown();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[tracing] ${serviceName} → ${collectorUrl} (traces + metrics)`);
