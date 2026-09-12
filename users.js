const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { metricsMiddleware } = require('./metrics');
const { databaseSpanOptions, processDatabaseResult } = require('./mock-db');

const tracer = trace.getTracer('users');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-memory user store
const users = [
  { id: 'u-001', email: 'alice@example.com', name: 'Alice Chen', role: 'admin', activated: true, created_at: '2025-01-15T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: true },
  { id: 'u-002', email: 'bob@example.com', name: 'Bob Smith', role: 'editor', activated: true, created_at: '2025-03-10T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: false },
  { id: 'u-003', email: 'carol@example.com', name: 'Carol Davis', role: 'viewer', activated: true, created_at: '2025-06-01T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: false },
  { id: 'u-004', email: 'dave@example.com', name: 'Dave Wilson', role: 'editor', activated: false, created_at: '2025-02-28T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: true },
  { id: 'u-005', email: 'eve@example.com', name: 'Eve Taylor', role: 'admin', activated: true, created_at: '2025-01-01T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: true },
  { id: 'u-006', email: 'frank@example.com', name: 'Frank Brown', role: 'editor', activated: true, created_at: '2025-07-15T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: false },
  { id: 'u-007', email: 'grace@example.com', name: 'Grace Lee', role: 'viewer', activated: false, created_at: '2025-08-20T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: false },
  { id: 'u-008', email: 'hank@example.com', name: 'Hank Miller', role: 'editor', activated: true, created_at: '2025-04-10T00:00:00Z', last_login: null, login_count: 0, mfa_enabled: false },
];

// Session store
const sessions = new Map();

// GET /users/:id
app.get('/users/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const userId = req.params.id;

  span.setAttributes({ 'user.lookup_id': userId });

  // Simulate DB lookup (child span)
  const user = await tracer.startActiveSpan('SELECT users', databaseSpanOptions('postgresql', 'identity', 'SELECT', 'users'), async (dbSpan) => {
    dbSpan.setAttributes({ 'db.system': 'postgresql', 'db.operation': 'SELECT', 'db.table': 'users' });

    const dbDuration = 5 + Math.random() * 30;
    await sleep(dbDuration);
    dbSpan.setAttributes({ 'db.duration_ms': Math.round(dbDuration) });

    // Simulate slow query on some users
    if (Math.random() < 0.06) {
      const extra = 300 + Math.random() * 700;
      await sleep(extra);
      dbSpan.setAttributes({ 'db.slow_query': true, 'db.duration_ms': Math.round(dbDuration + extra) });
      console.warn(`[users] slow query: SELECT user=${userId} (${Math.round(dbDuration + extra)}ms)`);
    }

    const found = users.find(u => u.id === userId);
    processDatabaseResult();
    dbSpan.setAttributes({ 'db.rows_found': found ? 1 : 0 });
    dbSpan.end();
    return found;
  });

  if (!user) {
    span.setAttributes({ 'user.found': false });
    console.log(`[users] user not found id=${userId}`);
    res.status(404).json({ error: 'User not found' });
    return;
  }

  span.setAttributes({ 'user.found': true, 'user.role': user.role, 'user.activated': user.activated });
  console.log(`[users] SELECT user=${userId} role=${user.role} activated=${user.activated}`);

  // Simulate intermittent DB error
  if (Math.random() < 0.03) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'connection reset by peer' });
    span.recordException(new Error('connection reset by peer'));
    console.error(`[users] DB error fetching user=${userId}`);
    res.status(500).json({ error: 'Database error' });
    return;
  }

  console.log(`[users] get_user success id=${userId} name="${user.name}"`);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, activated: user.activated, mfa_enabled: user.mfa_enabled, created_at: user.created_at } });
});

// POST /users/login
app.post('/users/login', async (req, res) => {
  const span = trace.getActiveSpan();
  const { email, password } = req.body;

  span.setAttributes({ 'auth.email': email, 'auth.method': 'password' });

  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  // Simulate credential check (child span)
  const authResult = await tracer.startActiveSpan('auth.verify_credentials', async (authSpan) => {
    authSpan.setAttributes({ 'auth.email': email, 'auth.method': 'password' });

    const authDuration = 50 + Math.random() * 100;
    await sleep(authDuration);
    authSpan.setAttributes({ 'auth.check_duration_ms': Math.round(authDuration) });

    const user = users.find(u => u.email === email);

    // User not found
    if (!user) {
      authSpan.setAttributes({ 'auth.result': 'user_not_found' });
      authSpan.end();
      return { ok: false, status: 401, error: 'Invalid credentials', reason: 'user_not_found' };
    }

    // Account locked/deactivated
    if (!user.activated) {
      authSpan.setAttributes({ 'auth.result': 'account_deactivated', 'user.id': user.id });
      authSpan.end();
      return { ok: false, status: 403, error: 'Account is deactivated', reason: 'account_deactivated' };
    }

    // Simulate wrong password (30% of attempts)
    if (Math.random() < 0.3) {
      authSpan.setAttributes({ 'auth.result': 'invalid_password', 'user.id': user.id });
      authSpan.end();
      return { ok: false, status: 401, error: 'Invalid credentials', reason: 'invalid_password' };
    }

    authSpan.setAttributes({ 'auth.result': 'credentials_valid', 'user.id': user.id });
    authSpan.end();
    return { ok: true, user };
  });

  if (!authResult.ok) {
    span.setAttributes({ 'auth.result': authResult.reason });
    console.log(`[users] login failed: ${authResult.reason} email=${email}`);
    res.status(authResult.status).json({ error: authResult.error });
    return;
  }

  const user = authResult.user;

  // Simulate MFA challenge (child span)
  if (user.mfa_enabled) {
    const mfaResult = await tracer.startActiveSpan('auth.verify_mfa', async (mfaSpan) => {
      mfaSpan.setAttributes({ 'auth.mfa_required': true, 'user.id': user.id });

      await sleep(20 + Math.random() * 40);

      // MFA failure (15% when MFA enabled)
      if (Math.random() < 0.15) {
        mfaSpan.setAttributes({ 'auth.mfa_result': 'failed' });
        mfaSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'MFA verification failed' });
        mfaSpan.end();
        return { ok: false };
      }

      mfaSpan.setAttributes({ 'auth.mfa_result': 'success' });
      mfaSpan.end();
      return { ok: true };
    });

    if (!mfaResult.ok) {
      span.setAttributes({ 'auth.result': 'mfa_failed', 'user.id': user.id });
      console.log(`[users] MFA failed user=${user.id}`);
      res.status(401).json({ error: 'MFA verification failed' });
      return;
    }
  }

  // Simulate bcrypt/argon2 hash verification (child span)
  await tracer.startActiveSpan('auth.hash_verify', async (hashSpan) => {
    hashSpan.setAttributes({ 'auth.hash_algorithm': 'argon2id' });
    await sleep(100 + Math.random() * 200);
    hashSpan.setAttributes({ 'auth.hash_verified': true });
    hashSpan.end();
  });

  // Create session
  const sessionId = uuidv4();
  const token = uuidv4();
  sessions.set(sessionId, { user_id: user.id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() });

  user.last_login = new Date().toISOString();
  user.login_count++;

  span.setAttributes({
    'auth.result': 'success',
    'user.id': user.id,
    'user.role': user.role,
    'session.id': sessionId,
    'auth.mfa_used': !!user.mfa_enabled,
  });

  console.log(`[users] login success user=${user.id} session=${sessionId}`);
  res.json({ token, session_id: sessionId, user: { id: user.id, email: user.email, role: user.role } });
});

// POST /users/logout
app.post('/users/logout', async (req, res) => {
  const span = trace.getActiveSpan();
  const { session_id } = req.body;

  span.setAttributes({ 'session.id': session_id });

  if (!session_id || !sessions.has(session_id)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  sessions.delete(session_id);
  await sleep(5 + Math.random() * 10);

  console.log(`[users] logout session=${session_id}`);
  res.json({ status: 'logged_out' });
});

// POST /users/validate-token
app.post('/users/validate-token', async (req, res) => {
  const span = trace.getActiveSpan();

  // Simulate token validation (child span)
  const result = await tracer.startActiveSpan('auth.validate_token', async (tokenSpan) => {
    tokenSpan.setAttributes({ 'auth.token_type': 'jwt' });

    const validateDuration = 3 + Math.random() * 15;
    await sleep(validateDuration);
    tokenSpan.setAttributes({ 'auth.validate_duration_ms': Math.round(validateDuration) });

    // Simulate expired token
    if (Math.random() < 0.1) {
      tokenSpan.setAttributes({ 'auth.token_valid': false, 'auth.reason': 'expired' });
      tokenSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'token expired' });
      console.warn(`[users] token validation failed: expired`);
      tokenSpan.end();
      return { ok: false, status: 401, error: 'Token expired' };
    }

    // Simulate invalid token
    if (Math.random() < 0.05) {
      tokenSpan.setAttributes({ 'auth.token_valid': false, 'auth.reason': 'invalid_signature' });
      tokenSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'invalid signature' });
      console.warn(`[users] token validation failed: invalid signature`);
      tokenSpan.end();
      return { ok: false, status: 401, error: 'Invalid token' };
    }

    tokenSpan.setAttributes({ 'auth.token_valid': true });
    const randomUser = users[Math.floor(Math.random() * users.length)];
    tokenSpan.end();
    return { ok: true, user_id: randomUser.id, role: randomUser.role };
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  span.setAttributes({ 'auth.token_valid': true });
  console.log(`[users] token valid for user=${result.user_id} role=${result.role}`);
  res.json({ valid: true, user_id: result.user_id, role: result.role });
});

// GET /users/:id/preferences
app.get('/users/:id/preferences', async (req, res) => {
  const span = trace.getActiveSpan();
  const userId = req.params.id;

  span.setAttributes({ 'user.id': userId });

  // DB lookup (child span)
  const user = await tracer.startActiveSpan('SELECT user_preferences', databaseSpanOptions('postgresql', 'identity', 'SELECT', 'user_preferences'), async (dbSpan) => {
    dbSpan.setAttributes({ 'db.system': 'postgresql', 'db.operation': 'SELECT', 'db.table': 'user_preferences' });

    console.log(`[users] SELECT preferences for user=${userId}`);
    const dbDuration = 8 + Math.random() * 25;
    await sleep(dbDuration);
    dbSpan.setAttributes({ 'db.duration_ms': Math.round(dbDuration) });

    const found = users.find(u => u.id === userId);
    processDatabaseResult();
    dbSpan.setAttributes({ 'db.rows_found': found ? 1 : 0 });
    dbSpan.end();
    return found;
  });

  if (!user) {
    console.log(`[users] preferences lookup failed: user not found id=${userId}`);
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Cache read (child span)
  await tracer.startActiveSpan('GET preferences', databaseSpanOptions('redis', 'identity-cache', 'GET', 'preferences'), async (cacheSpan) => {
    cacheSpan.setAttributes({ 'cache.system': 'redis', 'cache.key': `prefs:${userId}` });
    await sleep(2 + Math.random() * 5);

    if (Math.random() < 0.04) {
      cacheSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Cache read timeout' });
      cacheSpan.setAttributes({ 'cache.error': 'timeout' });
      console.warn(`[users] cache timeout reading prefs for user=${userId}`);
    } else {
      cacheSpan.setAttributes({ 'cache.hit': Math.random() > 0.4 });
    }
    cacheSpan.end();
  });

  console.log(`[users] get_preferences success user=${userId}`);
  res.json({
    user_id: userId,
    theme: Math.random() > 0.5 ? 'dark' : 'light',
    notifications_enabled: Math.random() > 0.2,
    timezone: ['UTC', 'US/Eastern', 'US/Pacific', 'Europe/London', 'Asia/Tokyo'][Math.floor(Math.random() * 5)],
    language: ['en', 'es', 'fr', 'de', 'ja'][Math.floor(Math.random() * 5)],
  });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'users', active_sessions: sessions.size });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`[users] listening on :${PORT}`);
});
