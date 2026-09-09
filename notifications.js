const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const { metricsMiddleware } = require('./metrics');

const tracer = trace.getTracer('notifications');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulated provider states
let smtpHealthy = true;
let webhookHealthy = true;

// Periodically simulate provider outages
setInterval(() => {
  if (Math.random() < 0.04) {
    smtpHealthy = false;
    console.error('[notifications] SMTP provider went down');
    setTimeout(() => { smtpHealthy = true; console.log('[notifications] SMTP provider recovered'); }, 8000 + Math.random() * 15000);
  }
}, 15000);

setInterval(() => {
  if (Math.random() < 0.03) {
    webhookHealthy = false;
    console.error('[notifications] webhook delivery failing');
    setTimeout(() => { webhookHealthy = true; }, 5000 + Math.random() * 10000);
  }
}, 20000);

// Notification channels
const CHANNELS = ['email', 'slack', 'webhook', 'push'];

// POST /notify
app.post('/notify', async (req, res) => {
  const span = trace.getActiveSpan();
  const { event, user, article, article_id } = req.body;

  const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];

  span.setAttributes({
    'notification.event': event,
    'notification.user_id': user?.id,
    'notification.user_email': user?.email,
    'notification.article_id': article?.id || article_id,
    'notification.channel': channel,
    'notification.priority': event === 'article_deleted' ? 'high' : 'normal',
  });

  // Simulate processing delay
  const baseDelay = 10 + Math.random() * 50;
  await sleep(baseDelay);

  // Route to channel-specific handler (each creates a child span)
  try {
    switch (channel) {
      case 'email':
        await sendEmail(user, event, article);
        break;
      case 'slack':
        await sendSlack(user, event, article);
        break;
      case 'webhook':
        await sendWebhook(event, article);
        break;
      case 'push':
        await sendPush(user, event);
        break;
    }

    // Queue publish for analytics (child span)
    await publishAnalytics(event, channel, user);

    res.json({ status: 'notified', channel, email_sent: channel === 'email' });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.error });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      res.status(500).json({ error: 'Notification delivery failed' });
    }
  }
});

// Email delivery — child span
async function sendEmail(user, event, article) {
  return await tracer.startActiveSpan('email.send', async (span) => {
    const emailDuration = 30 + Math.random() * 120;
    console.log(`[notifications] sending email to=${user?.email} subject="New: ${article?.title || event}"`);

    await sleep(emailDuration);

    span.setAttributes({
      'email.provider': 'sendgrid',
      'email.to': user?.email,
      'email.duration_ms': Math.round(emailDuration),
    });

    // SMTP provider down (503)
    if (!smtpHealthy) {
      const err = new Error('SMTP provider unavailable');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'email.status': 'failed', 'email.error': 'provider_down' });
      console.error(`[notifications] email failed: SMTP down to=${user?.email}`);
      span.end();
      throw { status: 503, error: 'Email provider temporarily unavailable' };
    }

    // Simulate SMTP connection refused (500)
    if (Math.random() < 0.06) {
      const err = new Error('SMTP connection refused');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'email.status': 'failed', 'email.error': 'connection_refused' });
      console.error(`[notifications] email failed: SMTP connection refused to=${user?.email}`);
      span.end();
      throw { status: 500, error: 'Email delivery failed' };
    }

    // Simulate invalid recipient (422)
    if (user?.email?.includes('grace@') && Math.random() < 0.4) {
      span.setAttributes({ 'email.status': 'bounced', 'email.error': 'mailbox_full' });
      console.warn(`[notifications] email bounced: mailbox full to=${user?.email}`);
      span.end();
      throw { status: 422, error: 'Email bounced: mailbox full' };
    }

    // Simulate rate limit from email provider (429)
    if (Math.random() < 0.03) {
      span.setAttributes({ 'email.status': 'rate_limited', 'email.error': 'provider_rate_limit' });
      console.warn(`[notifications] email rate limited by provider`);
      span.end();
      throw { status: 429, error: 'Email provider rate limit exceeded' };
    }

    console.log(`[notifications] email sent to=${user?.email}`);
    span.setAttributes({ 'email.status': 'sent' });
    span.end();
  });
}

// Slack delivery — child span
async function sendSlack(user, event, article) {
  return await tracer.startActiveSpan('slack.post', async (span) => {
    const slackDuration = 50 + Math.random() * 200;
    console.log(`[notifications] posting to slack channel=#notifications event=${event}`);

    await sleep(slackDuration);

    span.setAttributes({
      'slack.channel': '#notifications',
      'slack.duration_ms': Math.round(slackDuration),
    });

    // Simulate Slack API errors (502)
    if (Math.random() < 0.05) {
      const err = new Error('Slack API returned 502');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'slack.status': 'failed', 'slack.error': 'api_error' });
      console.error(`[notifications] slack post failed: API 502`);
      span.end();
      throw { status: 502, error: 'Slack API error' };
    }

    // Simulate Slack rate limit (429)
    if (Math.random() < 0.04) {
      span.setAttributes({ 'slack.status': 'rate_limited' });
      console.warn(`[notifications] slack rate limited`);
      span.end();
      throw { status: 429, error: 'Slack rate limit exceeded' };
    }

    console.log(`[notifications] slack message posted`);
    span.setAttributes({ 'slack.status': 'posted' });
    span.end();
  });
}

// Webhook delivery — child span
async function sendWebhook(event, article) {
  return await tracer.startActiveSpan('webhook.deliver', async (span) => {
    const webhookUrl = 'https://hooks.example.com/events';
    const webhookDuration = 20 + Math.random() * 300;

    console.log(`[notifications] firing webhook url=${webhookUrl} event=${event}`);
    await sleep(webhookDuration);

    span.setAttributes({
      'webhook.url': webhookUrl,
      'webhook.duration_ms': Math.round(webhookDuration),
    });

    // Webhook endpoint down (502)
    if (!webhookHealthy || Math.random() < 0.07) {
      const err = new Error('Webhook endpoint unreachable');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'webhook.status': 'failed', 'webhook.error': 'endpoint_unreachable' });
      console.error(`[notifications] webhook failed: endpoint unreachable`);
      span.end();
      throw { status: 502, error: 'Webhook endpoint unreachable' };
    }

    // Simulate timeout (504)
    if (Math.random() < 0.04) {
      await sleep(5000);
      const err = new Error('Webhook delivery timeout');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'webhook.status': 'timeout' });
      console.error(`[notifications] webhook timeout after 5s`);
      span.end();
      throw { status: 504, error: 'Webhook delivery timeout' };
    }

    // Simulate webhook returning 4xx
    if (Math.random() < 0.03) {
      span.setAttributes({ 'webhook.status': 'rejected', 'webhook.response_code': 400 });
      console.warn(`[notifications] webhook rejected: bad payload`);
      span.end();
      throw { status: 400, error: 'Webhook rejected payload' };
    }

    console.log(`[notifications] webhook delivered`);
    span.setAttributes({ 'webhook.status': 'delivered' });
    span.end();
  });
}

// Push notification — child span
async function sendPush(user, event) {
  return await tracer.startActiveSpan('push.send', async (span) => {
    const pushDuration = 15 + Math.random() * 80;
    console.log(`[notifications] sending push to user=${user?.id} event=${event}`);

    await sleep(pushDuration);

    span.setAttributes({
      'push.provider': 'firebase',
      'push.user_id': user?.id,
      'push.duration_ms': Math.round(pushDuration),
    });

    // Simulate device token expired (410)
    if (Math.random() < 0.08) {
      span.setAttributes({ 'push.status': 'token_expired' });
      console.warn(`[notifications] push token expired for user=${user?.id}`);
      span.end();
      throw { status: 410, error: 'Push token expired' };
    }

    // Simulate Firebase error (500)
    if (Math.random() < 0.04) {
      const err = new Error('Firebase messaging error');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.setAttributes({ 'push.status': 'failed' });
      console.error(`[notifications] push failed: Firebase error`);
      span.end();
      throw { status: 500, error: 'Push notification failed' };
    }

    console.log(`[notifications] push sent to user=${user?.id}`);
    span.setAttributes({ 'push.status': 'sent' });
    span.end();
  });
}

// Analytics queue publish — child span
async function publishAnalytics(event, channel, user) {
  return await tracer.startActiveSpan('queue.publish', async (span) => {
    const queueDuration = 2 + Math.random() * 8;
    console.log(`[notifications] publishing to queue=analytics.events event=${event} channel=${channel}`);

    await sleep(queueDuration);

    span.setAttributes({
      'queue.system': 'rabbitmq',
      'queue.name': 'analytics.events',
      'queue.duration_ms': Math.round(queueDuration),
      'queue.event': event,
    });

    // Simulate queue connection issue (non-critical, just log)
    if (Math.random() < 0.03) {
      span.setAttributes({ 'queue.error': 'connection_timeout' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'queue connection timeout' });
      console.warn(`[notifications] queue publish failed: connection timeout`);
    }

    span.end();
  });
}

// GET /channels — List notification channels
app.get('/channels', (req, res) => {
  const span = trace.getActiveSpan();
  span.setAttributes({ 'channels.count': CHANNELS.length });
  res.json({ channels: CHANNELS });
});

// GET /health
app.get('/health', (req, res) => {
  const degraded = !smtpHealthy || !webhookHealthy;
  res.json({
    status: degraded ? 'degraded' : 'ok',
    service: 'notifications',
    smtp_healthy: smtpHealthy,
    webhook_healthy: webhookHealthy,
  });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[notifications] listening on :${PORT}`);
});
