const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { encodeProfile, profileConfig, startProfiling, ExportRequest } = require('./profiling');
const { processDatabaseResult } = require('./mock-db');

function fixture() {
  return { startTime: 1000, endTime: 11000, nodes: [
    { id: 1, callFrame: { functionName: '(root)' }, children: [2, 4] },
    { id: 2, callFrame: { functionName: 'processDatabaseResult', url: 'mock-db.js', lineNumber: 26 }, children: [3] },
    { id: 3, callFrame: { functionName: 'decodeDatabaseRows', url: 'mock-db.js', lineNumber: 21 } },
    { id: 4, callFrame: { functionName: '(idle)' } },
  ], samples: [3, 3, 3, 2, 4, 4] };
}
const metadata = { service: 'articles', version: '0.2.0', instance: 'test-host', startNs: 1800000000123456789n };

test('V8 conversion preserves counts, exact epoch, lines and leaf-first stacks, excluding idle', () => {
  const request = ExportRequest.decode(encodeProfile(fixture(), metadata));
  const profile = request.resourceProfiles[0].scopeProfiles[0].profiles[0];
  const d = request.dictionary;
  assert.equal(profile.timeUnixNano.toString(), metadata.startNs.toString());
  assert.equal(profile.durationNano.toString(), '10000000');
  assert.equal(d.stringTable[profile.sampleType.unitStrindex], 'count');
  assert.equal(d.stringTable[profile.periodType.unitStrindex], 'nanoseconds');
  assert.equal(profile.period.toString(), '1000000');
  assert.equal(profile.profileId.length, 16);
  assert.deepEqual(profile.samples.map(s => s.values[0].toNumber()), [3, 1]);
  const frames = d.stackTable[profile.samples[0].stackIndex].locationIndices.map(i => d.locationTable[i].lines[0]);
  assert.deepEqual(frames.map(f => d.stringTable[d.functionTable[f.functionIndex].nameStrindex]), ['decodeDatabaseRows', 'processDatabaseResult']);
  assert.equal(frames[0].line.toNumber(), 22);
  assert.ok(!d.stringTable.includes('(idle)'));
  assert.equal(request.resourceProfiles[0].resource.attributes.find(a => a.key === 'service.name').value.stringValue, 'articles');
});

test('idle profiles produce no invented samples and malformed tree cycles are bounded', () => {
  assert.equal(encodeProfile({ ...fixture(), samples: [4, 4] }, metadata), null);
  const cyclic = fixture();
  cyclic.nodes[2].children = [2];
  assert.ok(encodeProfile(cyclic, metadata));
});

test('profiling is opt-in outside Compose and validates export configuration', () => {
  assert.equal(profileConfig({}), null);
  const enabled = { RUSH_PROFILING_ENABLED: 'true' };
  assert.equal(profileConfig({ ...enabled, RUSH_API_KEY: 'fallback' }).key, 'fallback');
  assert.equal(profileConfig({ ...enabled, RUSH_PROFILE_API_KEY: 'specific', RUSH_API_KEY: 'fallback' }).key, 'specific');
  assert.equal(profileConfig(enabled).endpoint.href, 'http://localhost:8080/v1development/profiles');
  for (const value of ['0', '61', 'NaN']) assert.throws(() => profileConfig({ ...enabled, RUSH_PROFILE_INTERVAL_SECS: value }));
  for (const value of ['file:///tmp/foo', 'https://user:secret@example.test', 'https://example.test?secret=value']) assert.throws(() => profileConfig({ ...enabled, RUSH_PROFILE_ENDPOINT: value }));
});

test('real V8 CPU samples export over HTTP with auth and flush at shutdown', async t => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, headers: req.headers, request: ExportRequest.decode(Buffer.concat(chunks)) };
    res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profiler = await startProfiling(profileConfig({
    RUSH_PROFILING_ENABLED: 'true', RUSH_PROFILE_INTERVAL_SECS: '60',
    RUSH_PROFILE_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    RUSH_PROFILE_API_KEY: 'test-profile-key', SERVICE_NAME: 'articles', SERVICE_VERSION: '0.2.0',
  }));
  t.after(() => profiler.stop());
  for (let i = 0; i < 50; i++) processDatabaseResult();
  await profiler.stop();
  assert.equal(received.path, '/v1development/profiles');
  assert.equal(received.headers.authorization, 'Bearer test-profile-key');
  assert.equal(received.headers['x-rush-tenant'], 'default');
  assert.equal(received.headers['content-type'], 'application/x-protobuf');
  assert.ok(received.request.dictionary.stringTable.includes('processDatabaseResult'));
  const samples = received.request.resourceProfiles[0].scopeProfiles[0].profiles[0].samples;
  assert.ok(samples.some(sample => sample.values[0].toNumber() > 0));
});

test('failed profile export does not leak credentials or stop the application', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', value => warnings.push(value));
  t.mock.method(global, 'fetch', async () => new Response('secret-response', { status: 403 }));
  const profiler = await startProfiling(profileConfig({ RUSH_PROFILING_ENABLED: 'true', RUSH_PROFILE_API_KEY: 'secret-key' }));
  processDatabaseResult();
  await profiler.stop();
  assert.match(warnings.join(' '), /HTTP 403/);
  assert.doesNotMatch(warnings.join(' '), /secret-response|secret-key/);
});
