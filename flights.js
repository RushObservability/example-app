// Synthetic flight updates for the saved Flights log view. Node 20+, no dependencies.
const { setTimeout: sleep } = require('node:timers/promises');

const FLIGHTS = [
  ['Example Air', 'EA0042', 'SFO', 'JFK'],
  ['Example Air', 'EA1088', 'LAX', 'SEA'],
  ['Pacific Demo', 'PD0205', 'SEA', 'HNL'],
  ['Pacific Demo', 'PD0317', 'SFO', 'DEN'],
  ['Atlas Demo', 'AD0601', 'JFK', 'LHR'],
  ['Atlas Demo', 'AD0742', 'BOS', 'ORD'],
  ['Coastal Demo', 'CD0019', 'SAN', 'SFO'],
  ['Coastal Demo', 'CD0904', 'MIA', 'ATL'],
];
const STATUSES = ['Scheduled', 'Boarding', 'Departed', 'In flight', 'Landed', 'Delayed', 'Cancelled'];

function readConfig(env = process.env) {
  const endpoint = new URL(env.RUSH_API_ENDPOINT || 'http://localhost:8080');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('RUSH_API_ENDPOINT must be an HTTP(S) base URL without credentials, query, or fragment.');
  }
  const interval = Number(env.FLIGHTS_INTERVAL_SECS || 5);
  if (!Number.isFinite(interval) || interval < 1 || interval > 3600) {
    throw new Error('FLIGHTS_INTERVAL_SECS must be between 1 and 3600.');
  }
  return { url: `${endpoint.href.replace(/\/$/, '')}/api/v1/ingest/logs`, intervalMs: interval * 1000, apiKey: env.RUSH_API_KEY || '' };
}

function makeBatch(tick = 0, now = Date.now()) {
  return FLIGHTS.map(([airline, flight_number, origin, destination], index) => {
    const status = STATUSES[(tick + index) % STATUSES.length];
    const data = {
      type: 'event_data', dataset: 'flights', synthetic: true,
      airline, flight_number, status, origin, destination,
      gate: `${String.fromCharCode(65 + index % 3)}${10 + index}`,
      observed_at: new Date(now).toISOString(),
      delay_minutes: status === 'Delayed' ? 15 + (tick % 4) * 15 : 0,
      scheduled_departure: new Date(now + (index - 3) * 15 * 60_000).toISOString(),
    };
    return {
      // Rush's JSON ingest endpoint assigns the receipt timestamp. observed_at
      // retains the generation time if a batch has to wait for the API.
      ServiceName: 'flight-data-demo', ScopeName: 'rush.flight-demo',
      SeverityNumber: status === 'Delayed' || status === 'Cancelled' ? 13 : 9,
      SeverityText: status === 'Delayed' || status === 'Cancelled' ? 'WARN' : 'INFO',
      Body: JSON.stringify(data), LogAttributes: data,
      ResourceAttributes: { 'deployment.environment.name': 'development' },
    };
  });
}

async function sendBatch(config, batch, signal, fetchImpl = fetch) {
  const headers = { 'Content-Type': 'application/json', 'X-Rush-Tenant': 'default' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetchImpl(config.url, {
    method: 'POST', headers, body: JSON.stringify(batch),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    // Never log response bodies: a server or proxy could reflect credentials.
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}. ${[401, 403].includes(response.status)
      ? 'Use a default-tenant ingest key with logs permission in RUSH_API_KEY.'
      : 'Check that query-api is running and ClickHouse is ready.'}`);
  }
  // The JSON ingest route returns an empty 200 response on success.
  await response.body?.cancel();
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node flights.js [--once]\nSends eight synthetic flight logs to the default tenant every five seconds.\nEnv: RUSH_API_ENDPOINT=http://localhost:8080, RUSH_API_KEY, FLIGHTS_INTERVAL_SECS=5');
    return;
  }
  if (args.some(arg => arg !== '--once')) throw new Error('Unknown argument. Use --help.');
  const config = readConfig();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let tick = 0;
  let failures = 0;
  // Keep only one pending batch, so an API outage cannot grow memory indefinitely.
  let pending;
  console.log('[flights] Synthetic flight logs, tenant=default, service=flight-data-demo');
  try {
    while (!shutdown.signal.aborted) {
      pending ||= makeBatch(tick);
      try {
        await sendBatch(config, pending, shutdown.signal);
        console.log(`[flights] Sent ${FLIGHTS.length} updates, type=event_data`);
        pending = undefined;
        tick++;
        failures = 0;
        if (args.includes('--once')) return;
      } catch (error) {
        if (shutdown.signal.aborted) return;
        if (args.includes('--once')) throw error;
        failures++;
        console.error(`[flights] ${error.message}. Retrying the pending batch.`);
      }
      const delay = failures ? Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) : config.intervalMs;
      try { await sleep(delay, undefined, { signal: shutdown.signal }); }
      catch { if (shutdown.signal.aborted) return; }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

module.exports = { FLIGHTS, makeBatch, readConfig, sendBatch };
if (require.main === module) main().catch(error => {
  console.error(`[flights] ${error.message}`);
  process.exitCode = 1;
});
