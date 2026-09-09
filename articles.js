const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { metricsMiddleware } = require('./metrics');

const tracer = trace.getTracer('articles');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

// In-memory article store
const articles = [];

// Simulate connection pool state
let dbConnections = { active: 0, max: 20 };
let cacheConnected = true;

// Periodically toggle cache connectivity for realism
setInterval(() => {
  if (Math.random() < 0.03) {
    cacheConnected = false;
    setTimeout(() => { cacheConnected = true; }, 5000 + Math.random() * 10000);
  }
}, 10000);

// Simulate the "published" bug for free trial users
function shouldPublish(user) {
  if (user.subscription?.trial === true) {
    return false; // The "bug" — trial users' articles aren't published
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulate DB query with realistic failure modes — creates child span
async function dbQuery(operation, table, opts = {}) {
  return await tracer.startActiveSpan(`db.${operation.toLowerCase()}`, async (span) => {
    const startMs = Date.now();
    dbConnections.active++;

    span.setAttributes({
      'db.system': 'postgresql',
      'db.operation': operation,
      'db.table': table,
      'db.connections.active': dbConnections.active,
      'db.connections.max': dbConnections.max,
    });

    // Connection pool exhaustion (500)
    if (dbConnections.active > dbConnections.max * 0.9 || Math.random() < 0.03) {
      dbConnections.active--;
      const err = new Error(`Connection pool exhausted (${dbConnections.active}/${dbConnections.max})`);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      console.error(`[articles] DB pool exhausted: ${dbConnections.active}/${dbConnections.max}`);
      span.end();
      throw { status: 503, error: 'Database connection pool exhausted', internal: true };
    }

    // Simulate query duration
    let duration = opts.baseDuration || (20 + Math.random() * 80);

    // Occasional slow queries
    if (Math.random() < 0.08) {
      duration += 500 + Math.random() * 2000;
      span.setAttributes({ 'db.slow_query': true });
      console.warn(`[articles] slow query: ${operation} on ${table} (${Math.round(duration)}ms)`);
    }

    // Deadlock simulation (500)
    if (Math.random() < 0.02) {
      dbConnections.active--;
      await sleep(duration);
      const err = new Error('deadlock detected');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      console.error(`[articles] deadlock on ${table}: retrying`);
      span.end();
      throw { status: 500, error: 'Database deadlock, please retry', internal: true };
    }

    // Query timeout (504)
    if (Math.random() < 0.02) {
      dbConnections.active--;
      await sleep(5000);
      const err = new Error('query timeout exceeded (5000ms)');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      console.error(`[articles] query timeout: ${operation} on ${table}`);
      span.end();
      throw { status: 504, error: 'Database query timeout', internal: true };
    }

    await sleep(duration);
    dbConnections.active--;

    const durationMs = Date.now() - startMs;
    span.setAttributes({
      'db.duration_ms': durationMs,
      'db.rows_affected': opts.rowsAffected || 1,
    });

    span.end();
    return durationMs;
  });
}

// Simulate cache operation — creates child span
async function cacheOp(operation, key) {
  return await tracer.startActiveSpan(`cache.${operation.toLowerCase()}`, async (span) => {
    const duration = 1 + Math.random() * 5;
    await sleep(duration);

    span.setAttributes({
      'cache.system': 'redis',
      'cache.operation': operation,
      'cache.key': key,
      'cache.connected': cacheConnected,
    });

    if (!cacheConnected) {
      console.warn(`[articles] cache ${operation} failed: connection refused key=${key}`);
      span.setAttributes({ 'cache.error': 'connection_refused' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'connection refused' });
      span.end();
      return false;
    }

    // Simulate occasional cache timeout
    if (Math.random() < 0.04) {
      span.setAttributes({ 'cache.error': 'timeout' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'cache timeout' });
      console.warn(`[articles] cache timeout on ${operation} key=${key}`);
      span.end();
      return false;
    }

    span.setAttributes({
      'cache.hit': operation === 'GET' ? Math.random() > 0.3 : false,
      'cache.duration_ms': Math.round(duration),
    });

    span.end();
    return true;
  });
}

// POST /articles
app.post('/articles', async (req, res) => {
  const startTime = Date.now();
  const span = trace.getActiveSpan();
  const { user, title, content } = req.body;

  span.setAttributes({
    'user.id': user?.id,
    'user.email': user?.email,
    'user.subscription.plan': user?.subscription?.plan,
    'user.subscription.trial': user?.subscription?.trial,
  });

  // Validate input
  if (!title || title.length < 1) {
    span.setAttributes({ 'validation.failed': true, 'validation.field': 'title' });
    res.status(400).json({ error: 'Title is required' });
    return;
  }

  if (title.length > 500) {
    span.setAttributes({ 'validation.failed': true, 'validation.field': 'title', 'validation.reason': 'too_long' });
    res.status(422).json({ error: 'Title must be 500 characters or less' });
    return;
  }

  try {
    // DB insert (creates child span)
    console.log(`[articles] INSERT article for user=${user?.id} trial=${user?.subscription?.trial}`);
    const dbDuration = await dbQuery('INSERT', 'articles', { baseDuration: 20 + Math.random() * 80 });

    const article = {
      id: uuidv4(),
      title: title || 'Untitled Post',
      owner_id: user?.id,
      published: shouldPublish(user),
      word_count: Math.floor(Math.random() * 3000) + 200,
      category: ['tech', 'business', 'science', 'opinion', 'tutorial'][Math.floor(Math.random() * 5)],
      tags: [['javascript', 'node'], ['python', 'django'], ['rust', 'performance'], ['devops', 'k8s'], ['ai', 'ml']][Math.floor(Math.random() * 5)],
      created_at: new Date().toISOString(),
    };

    articles.push(article);
    console.log(`[articles] INSERT complete rows=1 duration=${Math.round(dbDuration)}ms article=${article.id}`);

    span.setAttributes({
      'article.id': article.id,
      'article.title': article.title,
      'article.published': article.published,
      'article.word_count': article.word_count,
      'article.category': article.category,
    });

    // Cache write (creates child span)
    await cacheOp('SET', `article:${article.id}`);

    // Simulate slow responses randomly
    if (Math.random() < 0.05) {
      const extraDelay = 500 + Math.random() * 2000;
      await sleep(extraDelay);
      span.setAttributes({ 'slow_request': true, 'slow_delay_ms': Math.round(extraDelay) });
    }

    const duration = Date.now() - startTime;
    article.duration_ms = duration;

    span.setAttributes({
      'deploy.commit': process.env.COMMIT_SHA || 'abc123def456',
      'deploy.version': process.env.SERVICE_VERSION || '0.1.0',
      'feature_flags.new_editor': Math.random() > 0.5,
      'feature_flags.v2_api': false,
    });

    res.status(201).json(article);
  } catch (err) {
    if (err.internal) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// GET /articles
app.get('/articles', async (req, res) => {
  const span = trace.getActiveSpan();

  try {
    console.log(`[articles] SELECT all articles total=${articles.length}`);
    const dbDuration = await dbQuery('SELECT', 'articles', { rowsAffected: articles.length });

    span.setAttributes({
      'articles.count': articles.length,
      'articles.published_count': articles.filter((a) => a.published).length,
    });

    // Cache the listing (creates child span)
    await cacheOp('SET', 'articles:list');

    console.log(`[articles] list_articles returning ${Math.min(articles.length, 20)} articles db_duration=${Math.round(dbDuration)}ms`);
    res.json({ articles: articles.slice(-20) });
  } catch (err) {
    if (err.internal) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      console.error(`[articles] list_articles error: ${err.message}`);
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// GET /articles/:id
app.get('/articles/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const articleId = req.params.id;

  span.setAttributes({ 'article.id': articleId });

  // Check cache first (creates child span)
  console.log(`[articles] cache lookup article=${articleId}`);
  const cached = await cacheOp('GET', `article:${articleId}`);

  const article = articles.find(a => a.id === articleId);
  if (!article) {
    span.setAttributes({ 'article.found': false });
    console.log(`[articles] article not found id=${articleId}`);
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  try {
    await dbQuery('SELECT', 'articles');
    span.setAttributes({ 'article.found': true, 'article.title': article.title });
    console.log(`[articles] get_article found id=${articleId} title="${article.title}" cached=${cached}`);
    res.json({ article });
  } catch (err) {
    if (err.internal) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      console.error(`[articles] get_article error: ${err.message}`);
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// DELETE /articles/:id
app.delete('/articles/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const articleId = req.params.id;

  span.setAttributes({ 'article.id': articleId });

  const idx = articles.findIndex(a => a.id === articleId);
  if (idx === -1) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  try {
    await dbQuery('DELETE', 'articles');
    articles.splice(idx, 1);

    // Invalidate cache (creates child spans)
    await cacheOp('DEL', `article:${articleId}`);
    await cacheOp('DEL', 'articles:list');

    console.log(`[articles] DELETE article=${articleId}`);
    res.json({ deleted: true });
  } catch (err) {
    if (err.internal) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// POST /articles/:id/publish
app.post('/articles/:id/publish', async (req, res) => {
  const span = trace.getActiveSpan();
  const articleId = req.params.id;
  const { published, user } = req.body;

  span.setAttributes({
    'article.id': articleId,
    'publish.requested': !!published,
    'user.id': user?.id,
  });

  const article = articles.find(a => a.id === articleId);
  if (!article) {
    res.status(404).json({ error: 'Article not found' });
    return;
  }

  // Check ownership
  if (article.owner_id !== user?.id && user?.role !== 'admin') {
    span.setAttributes({ 'publish.denied': true, 'publish.reason': 'not_owner' });
    res.status(403).json({ error: 'Cannot publish articles you do not own' });
    return;
  }

  try {
    await dbQuery('UPDATE', 'articles');
    article.published = !!published;

    // Invalidate cache (creates child span)
    await cacheOp('DEL', `article:${articleId}`);

    console.log(`[articles] ${published ? 'PUBLISH' : 'UNPUBLISH'} article=${articleId}`);
    span.setAttributes({ 'article.published': article.published });
    res.json({ article });
  } catch (err) {
    if (err.internal) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

// POST /search
app.post('/search', async (req, res) => {
  const span = trace.getActiveSpan();
  const { q, filters } = req.body;
  const startMs = Date.now();

  span.setAttributes({
    'search.query': q || '',
    'search.engine': 'elasticsearch',
  });

  // Simulate search index issues (503)
  if (Math.random() < 0.04) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Search index unavailable' });
    span.recordException(new Error('Elasticsearch cluster red'));
    console.error('[articles] search index unavailable: cluster red');
    res.status(503).json({ error: 'Search index temporarily unavailable' });
    return;
  }

  // Simulate search with child span
  await tracer.startActiveSpan('elasticsearch.query', async (esSpan) => {
    esSpan.setAttributes({
      'es.index': 'articles',
      'es.query': q || '',
      'es.total_docs': articles.length,
    });

    const searchDuration = 10 + Math.random() * 150;
    await sleep(searchDuration);

    esSpan.setAttributes({ 'es.took_ms': Math.round(searchDuration) });
    esSpan.end();
  });

  // Simulate query parse error (400)
  if (q && q.includes('*') && Math.random() < 0.3) {
    span.setAttributes({ 'search.error': 'invalid_query' });
    console.warn(`[articles] search query parse error: invalid syntax q="${q}"`);
    res.status(400).json({ error: 'Invalid search query syntax' });
    return;
  }

  const query = (q || '').toLowerCase();
  const results = articles
    .filter(a => a.title.toLowerCase().includes(query) || (a.category && a.category.includes(query)))
    .slice(0, 20);

  const tookMs = Date.now() - startMs;
  span.setAttributes({
    'search.results_count': results.length,
    'search.took_ms': tookMs,
    'search.total_docs': articles.length,
  });

  console.log(`[articles] search complete q="${q || ''}" results=${results.length} took=${tookMs}ms`);
  res.json({ results, total: results.length, took_ms: tookMs });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: cacheConnected ? 'ok' : 'degraded',
    service: 'articles',
    db_connections: dbConnections.active,
    cache_connected: cacheConnected,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[articles] listening on :${PORT}`);
});
