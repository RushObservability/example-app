const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { metricsMiddleware } = require('./metrics');

const tracer = trace.getTracer('payments');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulated payment gateway state
let stripeHealthy = true;
setInterval(() => {
  if (Math.random() < 0.02) {
    stripeHealthy = false;
    console.error('[payments] Stripe gateway degraded');
    setTimeout(() => { stripeHealthy = true; console.log('[payments] Stripe gateway recovered'); }, 10000 + Math.random() * 20000);
  }
}, 30000);

// In-memory ledger
const transactions = [];
const subscriptions = new Map();

const PLANS = {
  free: { price: 0, features: ['5_articles', 'basic_search'] },
  pro: { price: 1999, features: ['unlimited_articles', 'advanced_search', 'analytics'] },
  team: { price: 4999, features: ['unlimited_articles', 'advanced_search', 'analytics', 'team_mgmt', 'sso'] },
};

// POST /payments/charge
app.post('/payments/charge', async (req, res) => {
  const span = trace.getActiveSpan();
  const { user_id, amount, currency, description, idempotency_key } = req.body;

  span.setAttributes({
    'payment.user_id': user_id,
    'payment.amount': amount,
    'payment.currency': currency || 'usd',
    'payment.description': description,
    'payment.idempotency_key': idempotency_key,
    'payment.provider': 'stripe',
  });

  console.log(`[payments] charge request user=${user_id} amount=${amount} currency=${currency || 'usd'}`);

  if (!amount || amount <= 0) {
    span.setAttributes({ 'payment.validation_error': 'invalid_amount' });
    console.warn(`[payments] charge rejected: invalid amount=${amount} user=${user_id}`);
    res.status(400).json({ error: 'Invalid amount' });
    return;
  }

  if (amount > 100000) {
    span.setAttributes({ 'payment.validation_error': 'amount_too_large' });
    console.warn(`[payments] charge rejected: amount too large amount=${amount} user=${user_id}`);
    res.status(422).json({ error: 'Amount exceeds maximum', max: 100000 });
    return;
  }

  // Fraud check (child span)
  const fraudResult = await tracer.startActiveSpan('fraud.check', async (fraudSpan) => {
    fraudSpan.setAttributes({
      'fraud.user_id': user_id,
      'fraud.amount': amount,
      'fraud.provider': 'internal',
    });

    const fraudDuration = 10 + Math.random() * 40;
    await sleep(fraudDuration);
    fraudSpan.setAttributes({ 'fraud.duration_ms': Math.round(fraudDuration) });

    // Simulate fraud flag (2%)
    if (Math.random() < 0.02) {
      fraudSpan.setAttributes({ 'fraud.result': 'flagged', 'fraud.reason': 'unusual_amount' });
      fraudSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'transaction flagged' });
      fraudSpan.end();
      return { ok: false };
    }

    fraudSpan.setAttributes({ 'fraud.result': 'passed', 'fraud.risk_score': Math.round(Math.random() * 30) });
    fraudSpan.end();
    return { ok: true };
  });

  if (!fraudResult.ok) {
    span.setAttributes({ 'payment.status': 'fraud_review' });
    res.status(422).json({ error: 'Transaction flagged for review' });
    return;
  }

  // Stripe API call (child span)
  const stripeResult = await tracer.startActiveSpan('stripe.charge', async (stripeSpan) => {
    stripeSpan.setAttributes({
      'stripe.amount': amount,
      'stripe.currency': currency || 'usd',
      'stripe.api_version': '2024-12-18',
    });

    const stripeDuration = 100 + Math.random() * 400;
    await sleep(stripeDuration);
    stripeSpan.setAttributes({ 'stripe.duration_ms': Math.round(stripeDuration) });

    // Stripe gateway down
    if (!stripeHealthy) {
      const err = new Error('Stripe API 503: service unavailable');
      stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      stripeSpan.recordException(err);
      console.error(`[payments] Stripe unavailable for charge user=${user_id} amount=${amount}`);
      stripeSpan.end();
      return { ok: false, status: 503, error: 'Payment gateway temporarily unavailable' };
    }

    // Card declined
    if (Math.random() < 0.12) {
      const declineReasons = [
        { code: 'card_declined', message: 'Your card was declined' },
        { code: 'insufficient_funds', message: 'Insufficient funds' },
        { code: 'expired_card', message: 'Card has expired' },
        { code: 'incorrect_cvc', message: 'Incorrect CVC' },
        { code: 'processing_error', message: 'Processing error, please retry' },
        { code: 'fraud_suspected', message: 'Transaction flagged for review' },
      ];
      const decline = declineReasons[Math.floor(Math.random() * declineReasons.length)];
      stripeSpan.setAttributes({ 'stripe.decline_code': decline.code, 'stripe.status': 'declined' });
      console.warn(`[payments] charge declined: ${decline.code} user=${user_id}`);
      stripeSpan.end();
      return { ok: false, status: 402, error: decline.message, decline_code: decline.code };
    }

    // Timeout
    if (Math.random() < 0.03) {
      await sleep(5000);
      const err = new Error('Stripe API timeout after 5000ms');
      stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      stripeSpan.recordException(err);
      console.error(`[payments] Stripe timeout for charge user=${user_id}`);
      stripeSpan.end();
      return { ok: false, status: 504, error: 'Payment gateway timeout' };
    }

    const chargeId = 'ch_' + uuidv4().slice(0, 16);
    stripeSpan.setAttributes({ 'stripe.charge_id': chargeId, 'stripe.status': 'succeeded' });
    stripeSpan.end();
    return { ok: true, chargeId };
  });

  if (!stripeResult.ok) {
    span.setAttributes({ 'payment.status': 'failed' });
    res.status(stripeResult.status).json({ error: stripeResult.error, decline_code: stripeResult.decline_code });
    return;
  }

  // Ledger write (child span)
  const txn = await tracer.startActiveSpan('ledger.write', async (ledgerSpan) => {
    ledgerSpan.setAttributes({ 'db.system': 'postgresql', 'db.operation': 'INSERT', 'db.table': 'transactions' });

    const ledgerDuration = 5 + Math.random() * 20;
    await sleep(ledgerDuration);
    ledgerSpan.setAttributes({ 'db.duration_ms': Math.round(ledgerDuration) });

    // Internal error (2%)
    if (Math.random() < 0.02) {
      const err = new Error('Failed to write to ledger');
      ledgerSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      ledgerSpan.recordException(err);
      console.error(`[payments] ledger write failed for user=${user_id}`);
      ledgerSpan.end();
      return null;
    }

    const t = {
      id: 'txn_' + uuidv4().slice(0, 12),
      user_id,
      amount,
      currency: currency || 'usd',
      status: 'succeeded',
      stripe_charge_id: stripeResult.chargeId,
      created_at: new Date().toISOString(),
    };
    transactions.push(t);
    ledgerSpan.setAttributes({ 'ledger.transaction_id': t.id });
    ledgerSpan.end();
    return t;
  });

  if (!txn) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Internal ledger error' });
    res.status(500).json({ error: 'Internal payment processing error' });
    return;
  }

  span.setAttributes({
    'payment.status': 'succeeded',
    'payment.transaction_id': txn.id,
    'payment.stripe_charge_id': txn.stripe_charge_id,
  });

  console.log(`[payments] charge succeeded: ${txn.id} user=${user_id} amount=${amount}`);
  res.status(201).json(txn);
});

// POST /payments/subscribe
app.post('/payments/subscribe', async (req, res) => {
  const span = trace.getActiveSpan();
  const { user_id, plan } = req.body;

  span.setAttributes({
    'subscription.user_id': user_id,
    'subscription.plan': plan,
    'subscription.provider': 'stripe',
  });

  console.log(`[payments] subscribe request user=${user_id} plan=${plan}`);

  if (!PLANS[plan]) {
    console.warn(`[payments] subscribe rejected: invalid plan="${plan}" user=${user_id}`);
    res.status(400).json({ error: 'Invalid plan', valid_plans: Object.keys(PLANS) });
    return;
  }

  const planInfo = PLANS[plan];

  // Free plan - no charge needed
  if (planInfo.price === 0) {
    const sub = { id: 'sub_' + uuidv4().slice(0, 12), user_id, plan, status: 'active', price: 0, created_at: new Date().toISOString() };
    subscriptions.set(user_id, sub);
    span.setAttributes({ 'subscription.status': 'active', 'subscription.id': sub.id });
    console.log(`[payments] free subscription created: ${sub.id} user=${user_id}`);
    res.status(201).json(sub);
    return;
  }

  // Stripe subscription creation (child span)
  const stripeResult = await tracer.startActiveSpan('stripe.create_subscription', async (stripeSpan) => {
    stripeSpan.setAttributes({
      'stripe.plan': plan,
      'stripe.amount': planInfo.price,
      'stripe.api_version': '2024-12-18',
    });

    const stripeDuration = 200 + Math.random() * 600;
    await sleep(stripeDuration);
    stripeSpan.setAttributes({ 'stripe.duration_ms': Math.round(stripeDuration) });

    // Payment failure
    if (Math.random() < 0.08) {
      stripeSpan.setAttributes({ 'stripe.status': 'payment_failed' });
      stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'payment failed' });
      console.warn(`[payments] subscription payment failed user=${user_id} plan=${plan}`);
      stripeSpan.end();
      return { ok: false, status: 402, error: 'Payment failed for subscription' };
    }

    if (!stripeHealthy) {
      stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Stripe unavailable' });
      stripeSpan.end();
      return { ok: false, status: 503, error: 'Payment gateway unavailable' };
    }

    const subId = 'sub_stripe_' + uuidv4().slice(0, 12);
    stripeSpan.setAttributes({ 'stripe.subscription_id': subId, 'stripe.status': 'active' });
    stripeSpan.end();
    return { ok: true, subId };
  });

  if (!stripeResult.ok) {
    span.setAttributes({ 'subscription.status': 'failed' });
    res.status(stripeResult.status).json({ error: stripeResult.error });
    return;
  }

  const sub = {
    id: 'sub_' + uuidv4().slice(0, 12),
    user_id,
    plan,
    status: 'active',
    price: planInfo.price,
    stripe_subscription_id: stripeResult.subId,
    current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    created_at: new Date().toISOString(),
  };
  subscriptions.set(user_id, sub);

  span.setAttributes({
    'subscription.status': 'active',
    'subscription.id': sub.id,
    'subscription.price': planInfo.price,
  });

  console.log(`[payments] subscription created: ${sub.id} user=${user_id} plan=${plan}`);
  res.status(201).json(sub);
});

// POST /payments/refund
app.post('/payments/refund', async (req, res) => {
  const span = trace.getActiveSpan();
  const { transaction_id, amount, reason } = req.body;

  span.setAttributes({
    'refund.transaction_id': transaction_id,
    'refund.amount': amount,
    'refund.reason': reason || 'requested_by_customer',
  });

  console.log(`[payments] refund request txn=${transaction_id} amount=${amount} reason=${reason || 'requested_by_customer'}`);

  const txn = transactions.find(t => t.id === transaction_id);
  if (!txn) {
    console.warn(`[payments] refund rejected: transaction not found txn=${transaction_id}`);
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }

  if (amount > txn.amount) {
    console.warn(`[payments] refund rejected: amount ${amount} exceeds charge ${txn.amount}`);
    res.status(422).json({ error: 'Refund amount exceeds charge', max: txn.amount });
    return;
  }

  // Stripe refund (child span)
  const refundResult = await tracer.startActiveSpan('stripe.refund', async (stripeSpan) => {
    stripeSpan.setAttributes({
      'stripe.charge_id': txn.stripe_charge_id,
      'stripe.refund_amount': amount || txn.amount,
      'stripe.api_version': '2024-12-18',
    });

    const refundDuration = 150 + Math.random() * 300;
    await sleep(refundDuration);
    stripeSpan.setAttributes({ 'stripe.duration_ms': Math.round(refundDuration) });

    // Refund failure
    if (Math.random() < 0.06) {
      const err = new Error('Stripe refund API error');
      stripeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      stripeSpan.recordException(err);
      console.error(`[payments] refund failed txn=${transaction_id}`);
      stripeSpan.end();
      return { ok: false };
    }

    const refundId = 're_' + uuidv4().slice(0, 12);
    stripeSpan.setAttributes({ 'stripe.refund_id': refundId, 'stripe.status': 'succeeded' });
    stripeSpan.end();
    return { ok: true, refundId };
  });

  if (!refundResult.ok) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Refund processing error' });
    res.status(500).json({ error: 'Refund processing failed' });
    return;
  }

  const refund = {
    id: refundResult.refundId,
    transaction_id,
    amount: amount || txn.amount,
    status: 'succeeded',
    created_at: new Date().toISOString(),
  };

  span.setAttributes({ 'refund.status': 'succeeded', 'refund.id': refund.id });
  console.log(`[payments] refund processed: ${refund.id} txn=${transaction_id} amount=${amount || txn.amount}`);
  res.status(201).json(refund);
});

// GET /payments/transactions/:userId
app.get('/payments/transactions/:userId', async (req, res) => {
  const span = trace.getActiveSpan();
  const userId = req.params.userId;

  span.setAttributes({ 'payment.user_id': userId });

  // DB query (child span)
  const userTxns = await tracer.startActiveSpan('db.select', async (dbSpan) => {
    dbSpan.setAttributes({ 'db.system': 'postgresql', 'db.operation': 'SELECT', 'db.table': 'transactions' });

    console.log(`[payments] SELECT transactions for user=${userId}`);
    const dbDuration = 15 + Math.random() * 60;
    await sleep(dbDuration);
    dbSpan.setAttributes({ 'db.duration_ms': Math.round(dbDuration) });

    const txns = transactions.filter(t => t.user_id === userId);
    dbSpan.setAttributes({ 'db.rows_found': txns.length });
    dbSpan.end();
    return txns;
  });

  span.setAttributes({ 'payment.transaction_count': userTxns.length });
  console.log(`[payments] get_transactions user=${userId} count=${userTxns.length}`);
  res.json({ transactions: userTxns.slice(-50) });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: stripeHealthy ? 'ok' : 'degraded',
    service: 'payments',
    stripe_healthy: stripeHealthy,
    transaction_count: transactions.length,
  });
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`[payments] listening on :${PORT}`);
});
