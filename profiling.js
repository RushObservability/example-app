const { Session } = require('node:inspector/promises');
const { randomBytes } = require('node:crypto');
const { hostname } = require('node:os');
const path = require('node:path');
const protobuf = require('protobufjs');

const ExportRequest = protobuf.loadSync(path.join(__dirname, 'profiles.proto')).lookupType('ExportProfilesServiceRequest');
const SAMPLE_INTERVAL_US = 1000;

function encodeProfile(profile, { service, version, instance, startNs }) {
  const dictionary = { stringTable: ['', 'cpu', 'count', 'nanoseconds'], functionTable: [{}], locationTable: [{}], stackTable: [{}] };
  const intern = value => {
    let index = dictionary.stringTable.indexOf(value);
    if (index < 0) index = dictionary.stringTable.push(value) - 1;
    return index;
  };
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const counts = new Map();
  for (const id of profile.samples || []) counts.set(id, (counts.get(id) || 0) + 1);
  const locations = new Map();
  const samples = [];
  for (const [id, count] of counts) {
    const leaf = nodes.get(id);
    if (!leaf || ['(idle)', '(root)'].includes(leaf.callFrame.functionName)) continue;
    const stack = [];
    const seen = new Set();
    let current = id;
    while (nodes.has(current) && !seen.has(current) && stack.length < 128) {
      seen.add(current);
      const frame = nodes.get(current).callFrame;
      if (frame.functionName !== '(root)') {
        if (!locations.has(current)) {
          const index = dictionary.functionTable.length;
          dictionary.functionTable.push({ nameStrindex: intern(frame.functionName || '(anonymous)'), filenameStrindex: intern(frame.url || '') });
          dictionary.locationTable.push({ lines: [{ functionIndex: index, line: Math.max(0, (frame.lineNumber ?? -1) + 1) }] });
          locations.set(current, index);
        }
        stack.push(locations.get(current));
      }
      current = parents.get(current);
    }
    if (!stack.length) continue;
    samples.push({ stackIndex: dictionary.stackTable.length, values: [count] });
    dictionary.stackTable.push({ locationIndices: stack }); // OTLP leaf first
  }
  if (!samples.length) return null;
  const attributes = { 'service.name': service, 'service.version': version, 'service.instance.id': instance, 'host.name': instance };
  const resource = { attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })) };
  const message = ExportRequest.fromObject({ dictionary, resourceProfiles: [{ resource, scopeProfiles: [{ profiles: [{
    sampleType: { typeStrindex: 1, unitStrindex: 2 },
    periodType: { typeStrindex: 1, unitStrindex: 3 }, period: SAMPLE_INTERVAL_US * 1000,
    timeUnixNano: startNs.toString(), durationNano: String(Math.max(1, Math.round((profile.endTime - profile.startTime) * 1000))),
    profileId: randomBytes(16), samples,
  }] }] }] });
  return Buffer.from(ExportRequest.encode(message).finish());
}

function profileConfig(env = process.env) {
  if (env.RUSH_PROFILING_ENABLED !== 'true') return null;
  const endpoint = new URL(env.RUSH_PROFILE_ENDPOINT || 'http://localhost:8080');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('RUSH_PROFILE_ENDPOINT must be an HTTP(S) base URL without credentials, query, or fragment');
  const interval = Number(env.RUSH_PROFILE_INTERVAL_SECS || 10);
  if (!Number.isFinite(interval) || interval < 1 || interval > 60) throw new Error('RUSH_PROFILE_INTERVAL_SECS must be between 1 and 60');
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1development/profiles`;
  return { endpoint, interval, service: env.SERVICE_NAME || 'unknown', version: env.SERVICE_VERSION || '0.1.0', instance: hostname(), tenant: env.RUSH_PROFILE_TENANT || 'default', key: env.RUSH_PROFILE_API_KEY || env.RUSH_API_KEY || '' };
}

async function startProfiling(config = profileConfig()) {
  if (!config) return { stop: async () => {} };
  const session = new Session();
  session.connect(); // In-process only, no debugger port is opened.
  let timer, startNs, stopped = false, busy = Promise.resolve();
  const begin = async () => {
    startNs = BigInt(Date.now()) * 1000000n;
    await session.post('Profiler.start');
  };
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
    await begin();
  } catch (error) { session.disconnect(); throw error; }

  async function collect(final = false) {
    const { profile } = await session.post('Profiler.stop');
    const capturedStart = startNs;
    // Pause during upload, bounding the sample buffer even if Rush is offline.
    try {
      const payload = encodeProfile(profile, { ...config, startNs: capturedStart });
      if (payload) {
        const headers = { 'Content-Type': 'application/x-protobuf', 'X-Rush-Tenant': config.tenant };
        if (config.key) headers.Authorization = `Bearer ${config.key}`;
        const response = await fetch(config.endpoint, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(5000), redirect: 'error' });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        console.log(`[profiling] ${config.service}: uploaded CPU samples`);
      }
    } catch (error) {
      // No response body or endpoint in logs: either could contain credentials.
      console.warn(`[profiling] upload failed (${error.message.startsWith('HTTP ') ? error.message : 'network or encoding error'}); dropping this window`);
    }
    if (!final && !stopped) await begin();
  }
  const schedule = () => {
    timer = setTimeout(() => {
      busy = collect().catch(() => { stopped = true; session.disconnect(); console.warn('[profiling] sampler stopped after an inspector error'); }).finally(() => { if (!stopped) schedule(); });
    }, config.interval * 1000);
    timer.unref();
  };
  schedule();
  console.log(`[profiling] ${config.service}: V8 CPU sampling enabled, ${config.interval}s windows`);
  return { async stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    await busy;
    try { await collect(true); } catch { /* A concurrent collection may already have stopped the sampler. */ }
    session.disconnect();
  } };
}

module.exports = { encodeProfile, profileConfig, startProfiling, ExportRequest };
