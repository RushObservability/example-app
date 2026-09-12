const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpanKind } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { databaseSpanOptions, processDatabaseResult } = require('./mock-db');

test('database spans identify distinct mock dependencies and carry client semantics', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const tracer = provider.getTracer('mock-db-test');
  for (const [system, namespace, port] of [['postgresql', 'content', 5432], ['postgresql', 'identity', 5432], ['mysql', 'ledger', 3306], ['redis', 'identity-cache', 6379]]) {
    const span = tracer.startSpan('SELECT rows', databaseSpanOptions(system, namespace, 'SELECT', 'rows'));
    span.end();
    const exported = exporter.getFinishedSpans().at(-1);
    assert.equal(exported.kind, SpanKind.CLIENT);
    assert.equal(exported.attributes['db.system'], system);
    assert.equal(exported.attributes['db.system.name'], system);
    assert.equal(exported.attributes['db.namespace'], namespace);
    assert.equal(exported.attributes['server.address'], `${namespace}-${system}.example`);
    assert.equal(exported.attributes['server.port'], port);
    assert.equal(exported.attributes['demo.synthetic'], true);
    assert.equal(exported.attributes['db.query.summary'], 'SELECT rows');
  }
  await provider.shutdown();
});

test('mock row processing does real work and can be disabled', t => {
  const original = process.env.DEMO_DB_CPU_MS;
  t.after(() => { if (original === undefined) delete process.env.DEMO_DB_CPU_MS; else process.env.DEMO_DB_CPU_MS = original; });
  process.env.DEMO_DB_CPU_MS = '2';
  assert.equal(processDatabaseResult(), 66);
  process.env.DEMO_DB_CPU_MS = '0';
  assert.equal(processDatabaseResult(), 0);
});
