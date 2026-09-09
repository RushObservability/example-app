const express = require('express');
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { metricsMiddleware } = require('./metrics');

const tracer = trace.getTracer('gateway');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

const ARTICLES_URL = process.env.ARTICLES_URL || 'http://localhost:3001';
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://localhost:3002';
const USERS_URL = process.env.USERS_URL || 'http://localhost:3003';
const PAYMENTS_URL = process.env.PAYMENTS_URL || 'http://localhost:3004';
const MEDIA_URL = process.env.MEDIA_URL || 'http://localhost:3005';

// Fake user database
const USERS = [
  { id: 'u-001', email: 'alice@example.com', activated: true, role: 'admin', subscription: { id: 's-001', plan: 'pro', trial: false, expires_at: '2027-01-01T00:00:00Z' } },
  { id: 'u-002', email: 'bob@example.com', activated: true, role: 'editor', subscription: { id: 's-002', plan: 'free', trial: true, expires_at: '2026-03-01T00:00:00Z' } },
  { id: 'u-003', email: 'carol@example.com', activated: true, role: 'viewer', subscription: { id: 's-003', plan: 'free', trial: true, expires_at: '2026-02-20T00:00:00Z' } },
  { id: 'u-004', email: 'dave@example.com', activated: false, role: 'editor', subscription: { id: 's-004', plan: 'pro', trial: false, expires_at: '2027-06-01T00:00:00Z' } },
  { id: 'u-005', email: 'eve@example.com', activated: true, role: 'admin', subscription: { id: 's-005', plan: 'team', trial: false, expires_at: '2027-01-01T00:00:00Z' } },
  { id: 'u-006', email: 'frank@example.com', activated: true, role: 'editor', subscription: { id: 's-006', plan: 'pro', trial: false, expires_at: '2026-12-01T00:00:00Z' } },
  { id: 'u-007', email: 'grace@example.com', activated: false, role: 'viewer', subscription: { id: 's-007', plan: 'free', trial: true, expires_at: '2026-01-15T00:00:00Z' } },
  { id: 'u-008', email: 'hank@example.com', activated: true, role: 'editor', subscription: { id: 's-008', plan: 'team', trial: false, expires_at: '2027-03-01T00:00:00Z' } },
];

function getUser() {
  return USERS[Math.floor(Math.random() * USERS.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Demo: keep the gateway "healthy". The OTel HTTP instrumentation marks a server
// span as an error only on a 5xx response, so we never surface a 5xx — downstream
// failures are recorded as span attributes but the gateway responds 200.
function clampStatus(s) {
  return s >= 500 ? 200 : s;
}

// Auth check — creates child span
async function authCheck(user) {
  return await tracer.startActiveSpan('auth.check', async (authSpan) => {
    authSpan.setAttributes({
      'auth.user_id': user.id,
      'auth.role': user.role,
      'auth.activated': user.activated,
    });

    // Simulate token lookup latency
    await sleep(2 + Math.random() * 8);

    // Gateway auth always succeeds — error injection disabled (demo: clean gateway).
    authSpan.setAttributes({ 'auth.result': 'allowed' });
    authSpan.end();
    return { ok: true };
  });
}

// Rate limit check — creates child span
async function rateLimit(userId) {
  return await tracer.startActiveSpan('rate_limit.check', async (rlSpan) => {
    const now = Date.now();
    const windowMs = 60000;
    if (!requestCounts[userId] || requestCounts[userId].reset < now) {
      requestCounts[userId] = { count: 0, reset: now + windowMs };
    }
    requestCounts[userId].count++;

    rlSpan.setAttributes({
      'rate_limit.user_id': userId,
      'rate_limit.count': requestCounts[userId].count,
      'rate_limit.window_ms': windowMs,
    });

    await sleep(1 + Math.random() * 3);

    // Rate limiting always passes — error injection disabled (demo: clean gateway).
    rlSpan.setAttributes({ 'rate_limit.hit': false });
    rlSpan.end();
    return true;
  });
}

let requestCounts = {};

// POST /articles — Create an article (proxied to articles service)
app.post('/articles', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'user.email': user.email,
    'user.role': user.role,
    'user.subscription.plan': user.subscription.plan,
    'user.subscription.trial': user.subscription.trial,
    'gateway.route': 'create_article',
    'gateway.request_id': uuidv4(),
  });

  // Auth check (child span)
  const auth = await authCheck(user);
  if (!auth.ok) {
    console.warn(`[gateway] create_article auth rejected user=${user.id} reason=${auth.error}`);
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // Rate limit (child span)
  if (!(await rateLimit(user.id))) {
    console.warn(`[gateway] rate limit exceeded for user=${user.id}`);
    res.status(429).json({ error: 'Rate limit exceeded', retry_after: 60 });
    return;
  }

  try {
    // Call articles service (child span)
    const article = await tracer.startActiveSpan('downstream.articles.create', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'http.url': `${ARTICLES_URL}/articles`, 'downstream.service': 'articles' });
      console.log(`[gateway] routing ${req.method} /articles for user=${user.id} plan=${user.subscription.plan}`);

      const articlesRes = await fetch(`${ARTICLES_URL}/articles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req.body, user }),
      });
      const data = await articlesRes.json();
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status, 'article.id': data.id, 'article.published': data.published });
      dsSpan.end();
      return { data, status: articlesRes.status };
    });

    // Call notifications service (child span, non-critical)
    await tracer.startActiveSpan('downstream.notifications.send', async (notifySpan) => {
      notifySpan.setAttributes({ 'http.method': 'POST', 'http.url': `${NOTIFICATIONS_URL}/notify`, 'downstream.service': 'notifications', 'notification.event': 'article_created' });
      try {
        console.log(`[gateway] notifying for article=${article.data.id} published=${article.data.published}`);
        const notifyRes = await fetch(`${NOTIFICATIONS_URL}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'article_created', user, article: article.data }),
        });
        notifySpan.setAttributes({ 'http.status_code': notifyRes.status });
      } catch (notifyErr) {
        console.error(`[gateway] notification failed: ${notifyErr.message}`);
      }
      notifySpan.end();
    });

    res.status(clampStatus(article.status)).json(article.data);
  } catch (err) {
    console.error(`[gateway] downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Downstream service failed', message: err.message });
  }
});

// GET /articles — List articles
app.get('/articles', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'user.subscription.plan': user.subscription.plan,
    'gateway.route': 'list_articles',
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    console.warn(`[gateway] list_articles auth rejected user=${user.id} reason=${auth.error}`);
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.articles.list', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'GET', 'http.url': `${ARTICLES_URL}/articles`, 'downstream.service': 'articles' });
      console.log(`[gateway] routing GET /articles for user=${user.id}`);
      const articlesRes = await fetch(`${ARTICLES_URL}/articles`);
      const data = await articlesRes.json();
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status, 'articles.count': data.articles?.length ?? 0 });
      dsSpan.end();
      return { data, status: articlesRes.status };
    });

    console.log(`[gateway] list_articles response count=${result.data.articles?.length ?? 0}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] list_articles downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Downstream service failed' });
  }
});

// GET /articles/:id — Get single article
app.get('/articles/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'gateway.route': 'get_article',
    'article.id': req.params.id,
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    console.warn(`[gateway] get_article auth rejected user=${user.id} reason=${auth.error}`);
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.articles.get', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'GET', 'http.url': `${ARTICLES_URL}/articles/${req.params.id}`, 'downstream.service': 'articles', 'article.id': req.params.id });
      console.log(`[gateway] routing GET /articles/${req.params.id} for user=${user.id}`);
      const articlesRes = await fetch(`${ARTICLES_URL}/articles/${req.params.id}`);
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status });
      if (articlesRes.status === 404) {
        dsSpan.setAttributes({ 'article.found': false });
        dsSpan.end();
        return { data: { error: 'Article not found' }, status: 404 };
      }
      const data = await articlesRes.json();
      dsSpan.setAttributes({ 'article.found': true });
      dsSpan.end();
      return { data, status: articlesRes.status };
    });

    console.log(`[gateway] get_article response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] get_article downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Downstream service failed' });
  }
});

// DELETE /articles/:id — Delete article
app.delete('/articles/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'user.role': user.role,
    'gateway.route': 'delete_article',
    'article.id': req.params.id,
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  // Only admins can delete
  if (user.role !== 'admin') {
    span.setAttributes({ 'auth.forbidden': true, 'auth.required_role': 'admin' });
    console.warn(`[gateway] user=${user.id} role=${user.role} tried to delete article=${req.params.id}`);
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }

  try {
    // Delete from articles service (child span)
    const result = await tracer.startActiveSpan('downstream.articles.delete', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'DELETE', 'http.url': `${ARTICLES_URL}/articles/${req.params.id}`, 'downstream.service': 'articles', 'article.id': req.params.id });
      console.log(`[gateway] routing DELETE /articles/${req.params.id} by admin user=${user.id}`);
      const articlesRes = await fetch(`${ARTICLES_URL}/articles/${req.params.id}`, { method: 'DELETE' });
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status });
      dsSpan.end();
      return { status: articlesRes.status };
    });

    if (result.status === 404) {
      console.log(`[gateway] delete_article not found id=${req.params.id}`);
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    // Notify about deletion (child span)
    await tracer.startActiveSpan('downstream.notifications.send', async (notifySpan) => {
      notifySpan.setAttributes({ 'downstream.service': 'notifications', 'notification.event': 'article_deleted' });
      try {
        const notifyRes = await fetch(`${NOTIFICATIONS_URL}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'article_deleted', user, article_id: req.params.id }),
        });
        notifySpan.setAttributes({ 'http.status_code': notifyRes.status });
      } catch (e) {
      }
      notifySpan.end();
    });

    console.log(`[gateway] delete_article success id=${req.params.id}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error(`[gateway] delete_article downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Downstream service failed' });
  }
});

// POST /articles/:id/publish — Publish/unpublish
app.post('/articles/:id/publish', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'gateway.route': 'publish_article',
    'article.id': req.params.id,
    'publish.action': req.body.published ? 'publish' : 'unpublish',
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (user.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot publish' });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.articles.publish', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'articles', 'article.id': req.params.id, 'publish.action': req.body.published ? 'publish' : 'unpublish' });
      console.log(`[gateway] routing POST /articles/${req.params.id}/publish action=${req.body.published ? 'publish' : 'unpublish'} user=${user.id}`);
      const articlesRes = await fetch(`${ARTICLES_URL}/articles/${req.params.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ published: req.body.published, user }),
      });
      const data = await articlesRes.json();
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status });
      dsSpan.end();
      return { data, status: articlesRes.status };
    });

    console.log(`[gateway] publish_article response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] publish_article downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Downstream service failed' });
  }
});

// GET /users/:id — User profile (proxied to users service)
app.get('/users/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'get_user', 'user.id': user.id, 'target_user.id': req.params.id });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.users.get', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'GET', 'downstream.service': 'users', 'target_user.id': req.params.id });
      console.log(`[gateway] routing GET /users/${req.params.id}`);
      const usersRes = await fetch(`${USERS_URL}/users/${req.params.id}`);
      const data = await usersRes.json();
      dsSpan.setAttributes({ 'http.status_code': usersRes.status });
      dsSpan.end();
      return { data, status: usersRes.status };
    });

    console.log(`[gateway] get_user response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] get_user downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Users service unavailable' });
  }
});

// GET /users/:id/preferences
app.get('/users/:id/preferences', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'get_user_preferences', 'user.id': user.id, 'target_user.id': req.params.id });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.users.get_preferences', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'GET', 'downstream.service': 'users', 'target_user.id': req.params.id });
      console.log(`[gateway] routing GET /users/${req.params.id}/preferences`);
      const usersRes = await fetch(`${USERS_URL}/users/${req.params.id}/preferences`);
      const data = await usersRes.json();
      dsSpan.setAttributes({ 'http.status_code': usersRes.status });
      dsSpan.end();
      return { data, status: usersRes.status };
    });

    console.log(`[gateway] get_user_preferences response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] get_user_preferences downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Users service unavailable' });
  }
});

// POST /login — Proxy to users service
app.post('/login', async (req, res) => {
  const span = trace.getActiveSpan();
  span.setAttributes({ 'gateway.route': 'login' });

  try {
    const result = await tracer.startActiveSpan('downstream.users.login', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'users', 'auth.email': req.body.email });
      console.log(`[gateway] routing POST /login email=${req.body.email}`);
      const usersRes = await fetch(`${USERS_URL}/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await usersRes.json();
      dsSpan.setAttributes({ 'http.status_code': usersRes.status, 'auth.result': data.token ? 'success' : 'failed' });
      dsSpan.end();
      return { data, status: usersRes.status };
    });

    console.log(`[gateway] login response status=${result.status} result=${result.data.token ? 'success' : 'failed'}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] login downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Auth service unavailable' });
  }
});

// POST /logout
app.post('/logout', async (req, res) => {
  const span = trace.getActiveSpan();
  span.setAttributes({ 'gateway.route': 'logout' });

  try {
    const result = await tracer.startActiveSpan('downstream.users.logout', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'users' });
      console.log(`[gateway] routing POST /logout session=${req.body.session_id}`);
      const usersRes = await fetch(`${USERS_URL}/users/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await usersRes.json();
      dsSpan.setAttributes({ 'http.status_code': usersRes.status });
      dsSpan.end();
      return { data, status: usersRes.status };
    });

    console.log(`[gateway] logout response status=${result.status}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] logout downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Auth service unavailable' });
  }
});

// POST /search — Search articles
app.post('/search', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'gateway.route': 'search',
    'search.query': req.body.q || '',
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (!req.body.q || req.body.q.length < 2) {
    console.warn(`[gateway] search rejected: query too short q="${req.body.q || ''}"`);
    res.status(400).json({ error: 'Search query must be at least 2 characters' });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.articles.search', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'articles', 'search.query': req.body.q });
      console.log(`[gateway] routing POST /search q="${req.body.q}" user=${user.id}`);
      const articlesRes = await fetch(`${ARTICLES_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await articlesRes.json();
      dsSpan.setAttributes({ 'http.status_code': articlesRes.status, 'search.results_count': data.results?.length ?? 0, 'search.took_ms': data.took_ms });
      dsSpan.end();
      return { data, status: articlesRes.status };
    });

    console.log(`[gateway] search response results=${result.data.results?.length ?? 0} took=${result.data.took_ms}ms`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] search downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Search service unavailable' });
  }
});

// POST /upload — File upload (proxied to media service)
app.post('/upload', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();

  span.setAttributes({
    'user.id': user.id,
    'gateway.route': 'upload',
  });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (!(await rateLimit(user.id))) {
    res.status(429).json({ error: 'Rate limit exceeded', retry_after: 60 });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.media.upload', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'media' });
      const mediaRes = await fetch(`${MEDIA_URL}/media/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.id,
          filename: `upload-${Date.now()}.${Math.random() > 0.5 ? 'jpg' : 'png'}`,
          content_type: req.headers['content-type'] || 'image/jpeg',
          size_bytes: parseInt(req.headers['content-length'] || String(Math.floor(Math.random() * 5000000))),
        }),
      });
      const data = await mediaRes.json();
      dsSpan.setAttributes({ 'http.status_code': mediaRes.status, 'media.id': data.id });
      dsSpan.end();
      return { data, status: mediaRes.status };
    });

    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] media service failure: ${err.message}`);
    res.status(200).json({ error: 'Media service unavailable' });
  }
});

// GET /media/:id — Get media (proxied to media service)
app.get('/media/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  span.setAttributes({ 'gateway.route': 'get_media', 'media.id': req.params.id });

  try {
    const result = await tracer.startActiveSpan('downstream.media.get', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'GET', 'downstream.service': 'media', 'media.id': req.params.id });
      console.log(`[gateway] routing GET /media/${req.params.id}`);
      const mediaRes = await fetch(`${MEDIA_URL}/media/${req.params.id}`);
      const data = await mediaRes.json();
      dsSpan.setAttributes({ 'http.status_code': mediaRes.status });
      dsSpan.end();
      return { data, status: mediaRes.status };
    });

    console.log(`[gateway] get_media response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] get_media downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Media service unavailable' });
  }
});

// POST /media/:id/transform — Transform image (proxied to media service)
app.post('/media/:id/transform', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'transform_media', 'media.id': req.params.id, 'user.id': user.id });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.media.transform', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'media', 'media.id': req.params.id });
      console.log(`[gateway] routing POST /media/${req.params.id}/transform user=${user.id}`);
      const mediaRes = await fetch(`${MEDIA_URL}/media/transform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_id: req.params.id, operations: req.body.operations || ['resize'] }),
      });
      const data = await mediaRes.json();
      dsSpan.setAttributes({ 'http.status_code': mediaRes.status });
      dsSpan.end();
      return { data, status: mediaRes.status };
    });

    console.log(`[gateway] transform_media response status=${result.status} id=${req.params.id}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] transform_media downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Media service unavailable' });
  }
});

// POST /payments/charge — Charge (proxied to payments service)
app.post('/payments/charge', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'payment_charge', 'user.id': user.id });

  const auth = await authCheck(user);
  if (!auth.ok) {
    console.warn(`[gateway] payment_charge auth rejected user=${user.id} reason=${auth.error}`);
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (!(await rateLimit(user.id))) {
    res.status(429).json({ error: 'Rate limit exceeded', retry_after: 60 });
    return;
  }

  try {
    // Call payments service (child span)
    const result = await tracer.startActiveSpan('downstream.payments.charge', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'payments', 'payment.amount': req.body.amount, 'payment.currency': req.body.currency || 'usd' });
      console.log(`[gateway] routing POST /payments/charge user=${user.id} amount=${req.body.amount}`);
      const payRes = await fetch(`${PAYMENTS_URL}/payments/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req.body, user_id: user.id }),
      });
      const data = await payRes.json();
      dsSpan.setAttributes({ 'http.status_code': payRes.status, 'payment.status': data.status || 'unknown' });
      dsSpan.end();
      return { data, status: payRes.status, ok: payRes.ok };
    });

    // Notify about payment (child span, non-critical)
    if (result.ok) {
      await tracer.startActiveSpan('downstream.notifications.send', async (notifySpan) => {
        notifySpan.setAttributes({ 'downstream.service': 'notifications', 'notification.event': 'payment_charged' });
        try {
          const notifyRes = await fetch(`${NOTIFICATIONS_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'payment_charged', user, amount: req.body.amount }),
          });
          notifySpan.setAttributes({ 'http.status_code': notifyRes.status });
        } catch (e) {
        }
        notifySpan.end();
      });
    }

    console.log(`[gateway] payment_charge response status=${result.status}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] payment_charge downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Payments service unavailable' });
  }
});

// POST /payments/subscribe — Subscribe (proxied to payments service)
app.post('/payments/subscribe', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'payment_subscribe', 'user.id': user.id, 'subscription.plan': req.body.plan });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.payments.subscribe', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'payments', 'subscription.plan': req.body.plan });
      console.log(`[gateway] routing POST /payments/subscribe user=${user.id} plan=${req.body.plan}`);
      const payRes = await fetch(`${PAYMENTS_URL}/payments/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id, plan: req.body.plan }),
      });
      const data = await payRes.json();
      dsSpan.setAttributes({ 'http.status_code': payRes.status });
      dsSpan.end();
      return { data, status: payRes.status, ok: payRes.ok };
    });

    if (result.ok) {
      await tracer.startActiveSpan('downstream.notifications.send', async (notifySpan) => {
        notifySpan.setAttributes({ 'downstream.service': 'notifications', 'notification.event': 'subscription_created' });
        try {
          const notifyRes = await fetch(`${NOTIFICATIONS_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'subscription_created', user, plan: req.body.plan }),
          });
          notifySpan.setAttributes({ 'http.status_code': notifyRes.status });
        } catch (e) {
        }
        notifySpan.end();
      });
    }

    console.log(`[gateway] payment_subscribe response status=${result.status} plan=${req.body.plan}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] payment_subscribe downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Payments service unavailable' });
  }
});

// POST /payments/refund
app.post('/payments/refund', async (req, res) => {
  const span = trace.getActiveSpan();
  const user = getUser();
  span.setAttributes({ 'gateway.route': 'payment_refund', 'user.id': user.id });

  const auth = await authCheck(user);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can issue refunds' });
    return;
  }

  try {
    const result = await tracer.startActiveSpan('downstream.payments.refund', async (dsSpan) => {
      dsSpan.setAttributes({ 'http.method': 'POST', 'downstream.service': 'payments', 'refund.transaction_id': req.body.transaction_id });
      console.log(`[gateway] routing POST /payments/refund txn=${req.body.transaction_id} by admin user=${user.id}`);
      const payRes = await fetch(`${PAYMENTS_URL}/payments/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await payRes.json();
      dsSpan.setAttributes({ 'http.status_code': payRes.status });
      dsSpan.end();
      return { data, status: payRes.status };
    });

    console.log(`[gateway] payment_refund response status=${result.status}`);
    res.status(clampStatus(result.status)).json(result.data);
  } catch (err) {
    console.error(`[gateway] payment_refund downstream failure: ${err.message}`);
    res.status(200).json({ error: 'Payments service unavailable' });
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gateway' });
});

// Catch-all for unknown routes
app.use((req, res) => {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes({ 'gateway.route': 'not_found', 'gateway.requested_path': req.path });
  }
  console.warn(`[gateway] 404 not found: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found', path: req.path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}`);
});
