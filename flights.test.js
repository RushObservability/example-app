const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FLIGHTS, makeBatch, readConfig, sendBatch } = require('./flights');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

test('generates flight attributes and matching JSON body for saved log views', () => {
  const batch = makeBatch(0, 1_700_000_000_000);
  const records = batch;
  assert.equal(records.length, FLIGHTS.length);
  assert.equal(records[0].LogAttributes.observed_at, '2023-11-14T22:13:20.000Z');
  assert.equal(records[0].ServiceName, 'flight-data-demo');
  for (const record of records) {
    const data = JSON.parse(record.Body);
    const attrs = record.LogAttributes;
    assert.equal(attrs.type, 'event_data');
    for (const key of ['airline', 'flight_number', 'status', 'origin', 'destination']) {
      assert.equal(attrs[key], data[key]);
    }
    assert.equal(attrs.synthetic, true);
  }
  assert.equal(JSON.parse(records[0].Body).flight_number, 'EA0042');
  assert.ok(records.some(record => JSON.parse(record.Body).status === 'Delayed'));
  assert.notDeepEqual(makeBatch(1, 1_700_000_000_000), batch);
});

test('validates endpoint and cadence', () => {
  assert.equal(readConfig({}).url, 'http://localhost:8080/api/v1/ingest/logs');
  assert.equal(readConfig({ RUSH_API_ENDPOINT: 'http://localhost:8080/' }).url, 'http://localhost:8080/api/v1/ingest/logs');
  for (const value of ['0', '-1', 'NaN', '3601']) {
    assert.throws(() => readConfig({ FLIGHTS_INTERVAL_SECS: value }));
  }
  assert.throws(() => readConfig({ RUSH_API_ENDPOINT: 'https://user:secret@example.test' }));
  assert.throws(() => readConfig({ RUSH_API_ENDPOINT: 'file:///tmp/logs' }));
});

test('sends Rush JSON logs to the default tenant with optional authentication', async () => {
  for (const apiKey of ['', 'test-key']) {
    let sent;
    await sendBatch(readConfig({ RUSH_API_KEY: apiKey }), makeBatch(), new AbortController().signal, async (url, options) => {
      sent = { url, ...options };
      return new Response(null, { status: 200 });
    });
    assert.equal(sent.headers['X-Rush-Tenant'], 'default');
    assert.equal(sent.headers.Authorization, apiKey ? 'Bearer test-key' : undefined);
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.equal(sent.redirect, 'error');
    assert.equal(JSON.parse(sent.body).length, 8);
  }
});

test('reports authentication and backpressure without reflecting response secrets', async () => {
  const config = readConfig({});
  const signal = new AbortController().signal;
  await assert.rejects(sendBatch(config, makeBatch(), signal, async () => new Response('secret-value', { status: 403 })), error => {
    assert.match(error.message, /default-tenant ingest key/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  await assert.rejects(sendBatch(config, makeBatch(), signal, async () => new Response(null, { status: 429 })), /HTTP 429/);
});

test('one-shot CLI delivers to an HTTP server and exits nonzero on rejection', async t => {
  let received;
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, headers: req.headers, rows: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(status);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = {
    env: { ...process.env, RUSH_API_ENDPOINT: `http://127.0.0.1:${server.address().port}`, RUSH_API_KEY: 'demo-test-key', FLIGHTS_INTERVAL_SECS: '5' },
    timeout: 15_000,
  };
  const run = () => promisify(execFile)(process.execPath, [path.join(__dirname, 'flights.js'), '--once'], options);
  const result = await run();
  assert.match(result.stdout, /Sent 8 updates/);
  assert.equal(received.path, '/api/v1/ingest/logs');
  assert.equal(received.headers['x-rush-tenant'], 'default');
  assert.equal(received.headers.authorization, 'Bearer demo-test-key');
  assert.equal(received.rows.length, 8);
  assert.equal(received.rows[0].LogAttributes.type, 'event_data');
  status = 403;
  await assert.rejects(run(), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /default-tenant ingest key/);
    assert.doesNotMatch(error.stderr, /demo-test-key/);
    return true;
  });
});
