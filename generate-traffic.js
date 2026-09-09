/**
 * Traffic generator — sends a varied stream of requests to the gateway
 * with periodic traffic spikes and error spikes for realism.
 *
 * Usage: node generate-traffic.js [requests-per-second] [duration-seconds]
 *
 * Traffic spikes:  3-5x RPS for 2-5min, first at ~5-15min, then every ~45-75min
 * Error spikes:    elevated error rates for 1-3min, first at ~8-20min, then every ~30-60min
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const RPS = parseInt(process.argv[2]) || 5;
const DURATION = parseInt(process.argv[3]) || 60;

const titles = [
  'Getting Started with Wide Events',
  'Why Observability Matters',
  'ClickHouse Performance Tuning',
  'OpenTelemetry Best Practices',
  'Distributed Tracing Deep Dive',
  'Microservices Architecture Patterns',
  'Building Reliable Systems',
  'Debugging Production Issues',
  'The Art of On-Call',
  'Scaling Your Monitoring Stack',
  'Event-Driven Architecture',
  'Understanding Tail Latency',
  'SLOs and Error Budgets',
  'Infrastructure as Code',
  'Container Orchestration Guide',
  'Kubernetes Networking Explained',
  'Service Mesh with Istio',
  'gRPC vs REST Performance',
  'Database Indexing Strategies',
  'Redis Caching Patterns',
  'Message Queue Design',
  'CI/CD Pipeline Optimization',
  'Zero-Downtime Deployments',
  'Chaos Engineering in Practice',
  'Prometheus and Grafana Setup',
];

const searchQueries = [
  'observability', 'kubernetes', 'performance', 'tracing', 'monitoring',
  'database', 'caching', 'microservices', 'deployment', 'architecture',
  'security', 'scaling', 'debugging', 'testing', 'docker',
  '', // empty search to trigger 400
  'a', // too short to trigger 400
  'find*all', // wildcard to trigger parse errors
];

const USER_IDS = ['u-001', 'u-002', 'u-003', 'u-004', 'u-005', 'u-006', 'u-007', 'u-008'];

// Track created IDs for subsequent operations
const createdArticleIds = [];
const createdMediaIds = [];
const createdTxnIds = [];
const sessionIds = [];

let totalRequests = 0;
let totalErrors = 0;
let statusCounts = {};

function countStatus(status) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
}

function randomTitle() {
  return titles[Math.floor(Math.random() * titles.length)];
}

function randomUserId() {
  return USER_IDS[Math.floor(Math.random() * USER_IDS.length)];
}

function randomArticleId() {
  if (createdArticleIds.length === 0) return 'nonexistent-id';
  if (Math.random() < 0.8) {
    return createdArticleIds[Math.floor(Math.random() * createdArticleIds.length)];
  }
  return 'nonexistent-' + Math.floor(Math.random() * 1000);
}

function randomMediaId() {
  if (createdMediaIds.length === 0) return 'nonexistent-media';
  if (Math.random() < 0.75) {
    return createdMediaIds[Math.floor(Math.random() * createdMediaIds.length)];
  }
  return 'nonexistent-media-' + Math.floor(Math.random() * 1000);
}

function randomTxnId() {
  if (createdTxnIds.length === 0) return 'txn_nonexistent';
  return createdTxnIds[Math.floor(Math.random() * createdTxnIds.length)];
}

// ── Spike State ──

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

let trafficSpikeActive = false;
let errorSpikeActive = false;
let spikeRpsMultiplier = 1;

// First spikes come quickly for demo purposes, then space out
let nextTrafficSpike = Date.now() + randomBetween(5 * 60_000, 15 * 60_000);
let nextErrorSpike   = Date.now() + randomBetween(8 * 60_000, 20 * 60_000);
let trafficSpikeEnd = 0;
let errorSpikeEnd = 0;

function updateSpikes() {
  const now = Date.now();

  // ── Traffic spike lifecycle ──
  if (!trafficSpikeActive && now >= nextTrafficSpike) {
    trafficSpikeActive = true;
    spikeRpsMultiplier = 3 + Math.floor(Math.random() * 3); // 3x, 4x, or 5x
    const durationMs = randomBetween(2 * 60_000, 5 * 60_000);
    trafficSpikeEnd = now + durationMs;
    console.log(`\n[traffic] *** TRAFFIC SPIKE *** ${spikeRpsMultiplier}x RPS (~${RPS * spikeRpsMultiplier}/s) for ~${Math.round(durationMs / 60_000)}min`);
  }
  if (trafficSpikeActive && now >= trafficSpikeEnd) {
    trafficSpikeActive = false;
    spikeRpsMultiplier = 1;
    const nextIn = randomBetween(45 * 60_000, 75 * 60_000);
    nextTrafficSpike = now + nextIn;
    console.log(`[traffic] *** TRAFFIC SPIKE ENDED *** next in ~${Math.round(nextIn / 60_000)}min\n`);
  }

  // ── Error spike lifecycle ──
  if (!errorSpikeActive && now >= nextErrorSpike) {
    errorSpikeActive = true;
    const durationMs = randomBetween(1 * 60_000, 3 * 60_000);
    errorSpikeEnd = now + durationMs;
    console.log(`\n[traffic] *** ERROR SPIKE *** elevated error rates for ~${Math.round(durationMs / 60_000)}min`);
  }
  if (errorSpikeActive && now >= errorSpikeEnd) {
    errorSpikeActive = false;
    const nextIn = randomBetween(30 * 60_000, 60 * 60_000);
    nextErrorSpike = now + nextIn;
    console.log(`[traffic] *** ERROR SPIKE ENDED *** next in ~${Math.round(nextIn / 60_000)}min\n`);
  }
}

// ── Request Type Selection ──

function pickRequestTypeNormal() {
  const r = Math.random();
  if (r < 0.18) return 'create_article';
  if (r < 0.30) return 'list_articles';
  if (r < 0.38) return 'get_article';
  if (r < 0.44) return 'search';
  if (r < 0.50) return 'get_user';
  if (r < 0.55) return 'login';
  if (r < 0.59) return 'logout';
  if (r < 0.63) return 'user_prefs';
  if (r < 0.68) return 'upload';
  if (r < 0.72) return 'get_media';
  if (r < 0.75) return 'transform_media';
  if (r < 0.80) return 'payment_charge';
  if (r < 0.84) return 'payment_subscribe';
  if (r < 0.86) return 'payment_refund';
  if (r < 0.89) return 'publish_article';
  if (r < 0.92) return 'delete_article';
  if (r < 0.96) return 'bad_route';
  return 'health';
}

function pickRequestType() {
  // During error spikes, 50% of picks bias toward error-prone types
  if (errorSpikeActive && Math.random() < 0.5) {
    const r = Math.random();
    if (r < 0.20) return 'create_article';    // empty title → 400
    if (r < 0.35) return 'payment_charge';     // bad amount → 400/422
    if (r < 0.50) return 'get_article';        // nonexistent → 404
    if (r < 0.65) return 'bad_route';          // always 404
    if (r < 0.80) return 'search';             // bad query → 400
    if (r < 0.90) return 'get_media';          // nonexistent → 404
    return 'get_user';                         // nonexistent → 404
  }
  return pickRequestTypeNormal();
}

// ── Request Sending ──

async function sendRequest() {
  const type = pickRequestType();
  // During error spikes, 60% of requests inject error-triggering data
  const forceError = errorSpikeActive && Math.random() < 0.6;

  try {
    let res;

    switch (type) {
      case 'create_article': {
        const useEmptyTitle = forceError || Math.random() < 0.03;
        res = await fetch(`${GATEWAY_URL}/articles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: useEmptyTitle ? '' : randomTitle(),
            content: `Content for: ${randomTitle()}. `.repeat(20 + Math.floor(Math.random() * 50)),
          }),
        });
        if (res.ok) {
          try {
            const data = await res.json();
            if (data.id) {
              createdArticleIds.push(data.id);
              if (createdArticleIds.length > 200) createdArticleIds.shift();
            }
          } catch {}
        }
        break;
      }

      case 'list_articles': {
        const page = Math.floor(Math.random() * 5) + 1;
        res = await fetch(`${GATEWAY_URL}/articles?page=${page}&limit=20`);
        break;
      }

      case 'get_article': {
        const articleId = forceError
          ? 'nonexistent-spike-' + Math.floor(Math.random() * 9999)
          : randomArticleId();
        res = await fetch(`${GATEWAY_URL}/articles/${articleId}`);
        break;
      }

      case 'delete_article': {
        const articleId = randomArticleId();
        res = await fetch(`${GATEWAY_URL}/articles/${articleId}`, { method: 'DELETE' });
        break;
      }

      case 'publish_article': {
        const articleId = randomArticleId();
        res = await fetch(`${GATEWAY_URL}/articles/${articleId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ published: Math.random() > 0.3 }),
        });
        break;
      }

      case 'search': {
        const badQueries = ['', 'a', 'find*all', '**', ''];
        const q = forceError
          ? badQueries[Math.floor(Math.random() * badQueries.length)]
          : searchQueries[Math.floor(Math.random() * searchQueries.length)];
        res = await fetch(`${GATEWAY_URL}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q }),
        });
        break;
      }

      case 'get_user': {
        const userId = forceError
          ? 'u-nonexistent-' + Math.floor(Math.random() * 999)
          : (Math.random() < 0.8 ? randomUserId() : 'u-nonexistent');
        res = await fetch(`${GATEWAY_URL}/users/${userId}`);
        break;
      }

      case 'login': {
        const emails = ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com', 'eve@example.com', 'frank@example.com', 'unknown@example.com'];
        const email = emails[Math.floor(Math.random() * emails.length)];
        res = await fetch(`${GATEWAY_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'password123' }),
        });
        if (res.ok) {
          try {
            const data = await res.json();
            if (data.session_id) {
              sessionIds.push(data.session_id);
              if (sessionIds.length > 50) sessionIds.shift();
            }
          } catch {}
        }
        break;
      }

      case 'logout': {
        const sessionId = sessionIds.length > 0 ? sessionIds[Math.floor(Math.random() * sessionIds.length)] : 'invalid-session';
        res = await fetch(`${GATEWAY_URL}/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        });
        break;
      }

      case 'user_prefs': {
        const userId = Math.random() < 0.85 ? randomUserId() : 'u-nonexistent';
        res = await fetch(`${GATEWAY_URL}/users/${userId}/preferences`);
        break;
      }

      case 'upload': {
        const mimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf', 'application/octet-stream'];
        res = await fetch(`${GATEWAY_URL}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': mimeTypes[Math.floor(Math.random() * mimeTypes.length)],
            'Content-Length': String(Math.floor(Math.random() * 15000000)),
          },
          body: 'simulated-file-data',
        });
        if (res.ok) {
          try {
            const data = await res.json();
            if (data.id) {
              createdMediaIds.push(data.id);
              if (createdMediaIds.length > 100) createdMediaIds.shift();
            }
          } catch {}
        }
        break;
      }

      case 'get_media': {
        const mediaId = forceError
          ? 'nonexistent-spike-' + Math.floor(Math.random() * 9999)
          : randomMediaId();
        res = await fetch(`${GATEWAY_URL}/media/${mediaId}`);
        break;
      }

      case 'transform_media': {
        const mediaId = randomMediaId();
        const ops = [['resize'], ['crop', 'resize'], ['grayscale'], ['blur', 'resize'], ['rotate']];
        res = await fetch(`${GATEWAY_URL}/media/${mediaId}/transform`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: ops[Math.floor(Math.random() * ops.length)] }),
        });
        break;
      }

      case 'payment_charge': {
        const goodAmounts = [999, 1999, 4999, 9999, 14999, 29999, 49999];
        const badAmounts = [0, -100, -500, 200000];
        const amount = forceError
          ? badAmounts[Math.floor(Math.random() * badAmounts.length)]
          : goodAmounts[Math.floor(Math.random() * goodAmounts.length)];
        res = await fetch(`${GATEWAY_URL}/payments/charge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount,
            currency: ['usd', 'eur', 'gbp'][Math.floor(Math.random() * 3)],
            description: `Charge for ${randomTitle()}`,
          }),
        });
        if (res.ok || res.status === 201) {
          try {
            const data = await res.json();
            if (data.id) {
              createdTxnIds.push(data.id);
              if (createdTxnIds.length > 50) createdTxnIds.shift();
            }
          } catch {}
        }
        break;
      }

      case 'payment_subscribe': {
        const plans = ['free', 'pro', 'team', 'enterprise']; // 'enterprise' is invalid
        res = await fetch(`${GATEWAY_URL}/payments/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: plans[Math.floor(Math.random() * plans.length)] }),
        });
        break;
      }

      case 'payment_refund': {
        const txnId = randomTxnId();
        res = await fetch(`${GATEWAY_URL}/payments/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction_id: txnId,
            amount: Math.floor(Math.random() * 5000),
            reason: ['requested_by_customer', 'duplicate', 'fraudulent'][Math.floor(Math.random() * 3)],
          }),
        });
        break;
      }

      case 'bad_route': {
        const badPaths = ['/api/v2/articles', '/graphql', '/admin', '/metrics', '/debug/pprof', '/favicon.ico', '/wp-admin', '/.env', '/actuator/health'];
        const path = badPaths[Math.floor(Math.random() * badPaths.length)];
        res = await fetch(`${GATEWAY_URL}${path}`);
        break;
      }

      case 'health': {
        res = await fetch(`${GATEWAY_URL}/health`);
        break;
      }
    }

    totalRequests++;
    if (res) {
      countStatus(res.status);
      if (!res.ok) totalErrors++;
      // Consume body to free connection
      try { await res.text(); } catch {}
    }
  } catch (err) {
    totalRequests++;
    totalErrors++;
    countStatus('network_error');
  }
}

// ── Main Loop ──

console.log(`[traffic] Sending ~${RPS} req/s to ${GATEWAY_URL} for ${DURATION}s`);
console.log(`[traffic] Mix: articles(44%) auth(13%) media(12%) payments(11%) user(10%) 404/health(8%) + errors`);
console.log(`[traffic] Traffic spikes: 3-5x RPS every ~1hr | Error spikes: elevated errors every ~1hr`);
console.log(`[traffic] Press Ctrl+C to stop\n`);

const interval = setInterval(() => {
  updateSpikes();

  const effectiveRps = Math.round(RPS * spikeRpsMultiplier);
  const jitter = Math.floor(effectiveRps * 0.3);
  const thisSecondRps = effectiveRps + Math.floor(Math.random() * jitter * 2) - jitter;

  for (let i = 0; i < Math.max(1, thisSecondRps); i++) {
    const delay = Math.floor(Math.random() * 900);
    setTimeout(sendRequest, delay);
  }
}, 1000);

// Status updates every 5 seconds
const statusInterval = setInterval(() => {
  const statusStr = Object.entries(statusCounts)
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const effectiveRps = Math.round(RPS * spikeRpsMultiplier);
  const spikeInfo = [];
  if (trafficSpikeActive) spikeInfo.push(`TRAFFIC_SPIKE(${spikeRpsMultiplier}x)`);
  if (errorSpikeActive) spikeInfo.push('ERROR_SPIKE');
  const spikeStr = spikeInfo.length ? ` [${spikeInfo.join(' ')}]` : '';
  console.log(`[traffic] sent=${totalRequests} errors=${totalErrors} rate=~${effectiveRps}/s${spikeStr} | ${statusStr}`);
}, 5000);

setTimeout(() => {
  clearInterval(interval);
  clearInterval(statusInterval);
  const statusStr = Object.entries(statusCounts)
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  console.log(`\n[traffic] Done. total=${totalRequests} errors=${totalErrors}`);
  console.log(`[traffic] Status breakdown: ${statusStr}`);
  // Wait a bit for inflight requests
  setTimeout(() => process.exit(0), 3000);
}, DURATION * 1000);
