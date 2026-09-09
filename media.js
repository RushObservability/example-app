const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');

const { metricsMiddleware } = require('./metrics');

const tracer = trace.getTracer('media');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulated S3/storage state
let storageHealthy = true;
let cdnHealthy = true;

setInterval(() => {
  if (Math.random() < 0.03) {
    storageHealthy = false;
    console.error('[media] S3 storage degraded');
    setTimeout(() => { storageHealthy = true; console.log('[media] S3 storage recovered'); }, 8000 + Math.random() * 12000);
  }
}, 20000);

setInterval(() => {
  if (Math.random() < 0.02) {
    cdnHealthy = false;
    console.error('[media] CDN purge failing');
    setTimeout(() => { cdnHealthy = true; }, 5000 + Math.random() * 8000);
  }
}, 25000);

// In-memory media store
const mediaFiles = [];

const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf', 'audio/mpeg'];
const ALLOWED_IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// POST /media/upload
app.post('/media/upload', async (req, res) => {
  const span = trace.getActiveSpan();
  const { user_id, filename, content_type, size_bytes } = req.body;
  const mime = content_type || MIME_TYPES[Math.floor(Math.random() * MIME_TYPES.length)];
  const size = size_bytes || Math.floor(Math.random() * 10000000);

  span.setAttributes({
    'media.user_id': user_id,
    'media.filename': filename || 'untitled',
    'media.content_type': mime,
    'media.size_bytes': size,
    'media.storage': 's3',
  });

  console.log(`[media] upload request user=${user_id} file=${filename || 'untitled'} type=${mime} size=${size}`);

  // Validate file size
  if (size > 50 * 1024 * 1024) {
    span.setAttributes({ 'media.rejected': true, 'media.reason': 'file_too_large' });
    console.warn(`[media] upload rejected: file too large size=${size} user=${user_id}`);
    res.status(413).json({ error: 'File too large', max_size: '50MB' });
    return;
  }

  // Validate content type
  if (mime === 'application/x-executable' || mime === 'application/x-msdownload') {
    span.setAttributes({ 'media.rejected': true, 'media.reason': 'forbidden_type' });
    console.warn(`[media] upload rejected: forbidden type=${mime} user=${user_id}`);
    res.status(415).json({ error: 'File type not allowed' });
    return;
  }

  // Virus scan (child span)
  const scanResult = await tracer.startActiveSpan('virus.scan', async (scanSpan) => {
    scanSpan.setAttributes({ 'scan.engine': 'clamav', 'scan.filename': filename || 'untitled', 'scan.size_bytes': size });

    const scanDuration = 50 + Math.random() * 200;
    await sleep(scanDuration);
    scanSpan.setAttributes({ 'scan.duration_ms': Math.round(scanDuration) });

    // Virus detected (very rare)
    if (Math.random() < 0.01) {
      scanSpan.setAttributes({ 'scan.result': 'infected', 'scan.threat': 'Trojan.GenericKD' });
      scanSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'virus detected' });
      console.error(`[media] virus detected in upload from user=${user_id}`);
      scanSpan.end();
      return { ok: false };
    }

    scanSpan.setAttributes({ 'scan.result': 'clean' });
    scanSpan.end();
    return { ok: true };
  });

  if (!scanResult.ok) {
    span.setAttributes({ 'media.scan_result': 'infected' });
    res.status(422).json({ error: 'File failed security scan' });
    return;
  }
  span.setAttributes({ 'media.scan_result': 'clean' });

  // S3 upload (child span)
  const uploadResult = await tracer.startActiveSpan('s3.upload', async (s3Span) => {
    s3Span.setAttributes({ 's3.bucket': 'media-uploads', 's3.operation': 'PutObject', 's3.content_type': mime, 's3.size_bytes': size });

    if (!storageHealthy) {
      const err = new Error('S3 PutObject failed: service unavailable');
      s3Span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      s3Span.recordException(err);
      console.error(`[media] S3 upload failed: storage unavailable`);
      s3Span.end();
      return { ok: false, status: 503, error: 'Storage service unavailable' };
    }

    const uploadDuration = 100 + Math.random() * (size / 100000);
    await sleep(Math.min(uploadDuration, 3000));
    s3Span.setAttributes({ 's3.duration_ms': Math.round(uploadDuration) });

    // S3 upload error
    if (Math.random() < 0.04) {
      const err = new Error('S3 PutObject: InternalError');
      s3Span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      s3Span.recordException(err);
      console.error(`[media] S3 PutObject failed`);
      s3Span.end();
      return { ok: false, status: 500, error: 'Storage upload failed' };
    }

    // S3 timeout
    if (Math.random() < 0.03) {
      await sleep(5000);
      const err = new Error('S3 PutObject timeout');
      s3Span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      s3Span.recordException(err);
      console.error(`[media] S3 upload timeout`);
      s3Span.end();
      return { ok: false, status: 504, error: 'Storage upload timeout' };
    }

    s3Span.setAttributes({ 's3.status': 'success' });
    s3Span.end();
    return { ok: true };
  });

  if (!uploadResult.ok) {
    res.status(uploadResult.status).json({ error: uploadResult.error });
    return;
  }

  const mediaId = uuidv4();
  const s3Key = `uploads/${user_id}/${mediaId}/${filename || 'file'}`;

  // Generate thumbnail for images (child span)
  let thumbnailUrl = null;
  if (ALLOWED_IMAGES.includes(mime)) {
    thumbnailUrl = await tracer.startActiveSpan('thumbnail.generate', async (thumbSpan) => {
      thumbSpan.setAttributes({ 'thumbnail.source_type': mime, 'thumbnail.media_id': mediaId });

      const thumbDuration = 30 + Math.random() * 150;
      await sleep(thumbDuration);
      thumbSpan.setAttributes({ 'thumbnail.duration_ms': Math.round(thumbDuration) });

      // Thumbnail generation failure
      if (Math.random() < 0.05) {
        thumbSpan.setAttributes({ 'thumbnail.error': 'processing_failed' });
        thumbSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'thumbnail processing failed' });
        console.warn(`[media] thumbnail generation failed for ${mediaId}`);
        thumbSpan.end();
        return null; // Non-critical, continue
      }

      thumbSpan.setAttributes({ 'thumbnail.generated': true });
      thumbSpan.end();
      return `https://cdn.example.com/thumbs/${mediaId}_thumb.jpg`;
    });
  }

  const media = {
    id: mediaId,
    user_id,
    filename: filename || 'untitled',
    content_type: mime,
    size_bytes: size,
    s3_key: s3Key,
    url: `https://cdn.example.com/${s3Key}`,
    thumbnail_url: thumbnailUrl,
    created_at: new Date().toISOString(),
  };
  mediaFiles.push(media);

  // CDN invalidation (child span)
  await tracer.startActiveSpan('cdn.invalidate', async (cdnSpan) => {
    cdnSpan.setAttributes({ 'cdn.provider': 'cloudfront', 'cdn.path': s3Key });

    if (cdnHealthy) {
      await sleep(10 + Math.random() * 30);
      cdnSpan.setAttributes({ 'cdn.status': 'success' });
    } else {
      cdnSpan.setAttributes({ 'cdn.status': 'failed', 'cdn.error': 'service_degraded' });
      cdnSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'CDN service degraded' });
      console.warn(`[media] CDN invalidation failed for ${mediaId}`);
    }
    cdnSpan.end();
  });

  span.setAttributes({ 'media.id': mediaId, 'media.s3_key': s3Key });
  console.log(`[media] upload complete: ${mediaId} type=${mime} size=${size}`);
  res.status(201).json(media);
});

// GET /media/:id
app.get('/media/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const mediaId = req.params.id;

  span.setAttributes({ 'media.id': mediaId });

  // Check cache (child span)
  const cached = await tracer.startActiveSpan('cache.get', async (cacheSpan) => {
    cacheSpan.setAttributes({ 'cache.system': 'redis', 'cache.key': `media:${mediaId}` });

    console.log(`[media] cache lookup media=${mediaId}`);
    const cacheDuration = 2 + Math.random() * 8;
    await sleep(cacheDuration);
    cacheSpan.setAttributes({ 'cache.duration_ms': Math.round(cacheDuration) });

    const hit = Math.random() > 0.5;
    cacheSpan.setAttributes({ 'cache.hit': hit });
    cacheSpan.end();
    return hit;
  });

  const media = mediaFiles.find(m => m.id === mediaId);
  if (!media) {
    span.setAttributes({ 'media.found': false });
    console.log(`[media] media not found id=${mediaId}`);
    res.status(404).json({ error: 'Media not found' });
    return;
  }

  span.setAttributes({ 'media.found': true, 'media.content_type': media.content_type });

  // Simulate signed URL generation (child span)
  await tracer.startActiveSpan('s3.presign', async (signSpan) => {
    signSpan.setAttributes({ 's3.operation': 'GetObject', 's3.key': media.s3_key });

    const signDuration = 5 + Math.random() * 15;
    await sleep(signDuration);
    signSpan.setAttributes({ 's3.duration_ms': Math.round(signDuration), 's3.expires_in': 3600 });
    signSpan.end();
  });

  console.log(`[media] get_media success id=${mediaId} type=${media.content_type} cached=${cached}`);
  res.json({ media: { ...media, signed_url: `${media.url}?token=${uuidv4().slice(0, 8)}&expires=${Date.now() + 3600000}` } });
});

// DELETE /media/:id
app.delete('/media/:id', async (req, res) => {
  const span = trace.getActiveSpan();
  const mediaId = req.params.id;

  span.setAttributes({ 'media.id': mediaId });

  console.log(`[media] delete request media=${mediaId}`);

  const idx = mediaFiles.findIndex(m => m.id === mediaId);
  if (idx === -1) {
    console.log(`[media] delete failed: media not found id=${mediaId}`);
    res.status(404).json({ error: 'Media not found' });
    return;
  }

  // S3 delete (child span)
  const deleteResult = await tracer.startActiveSpan('s3.delete', async (s3Span) => {
    s3Span.setAttributes({ 's3.operation': 'DeleteObject', 's3.key': mediaFiles[idx].s3_key });

    const deleteDuration = 20 + Math.random() * 80;
    await sleep(deleteDuration);
    s3Span.setAttributes({ 's3.duration_ms': Math.round(deleteDuration) });

    if (Math.random() < 0.04) {
      const err = new Error('S3 DeleteObject: AccessDenied');
      s3Span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      s3Span.recordException(err);
      console.error(`[media] S3 delete failed for ${mediaId}`);
      s3Span.end();
      return { ok: false };
    }

    s3Span.setAttributes({ 's3.status': 'success' });
    s3Span.end();
    return { ok: true };
  });

  if (!deleteResult.ok) {
    res.status(500).json({ error: 'Failed to delete from storage' });
    return;
  }

  mediaFiles.splice(idx, 1);
  console.log(`[media] deleted: ${mediaId}`);
  res.json({ deleted: true });
});

// POST /media/transform
app.post('/media/transform', async (req, res) => {
  const span = trace.getActiveSpan();
  const { media_id, operations } = req.body;

  span.setAttributes({
    'transform.media_id': media_id,
    'transform.operations': JSON.stringify(operations || []),
  });

  console.log(`[media] transform request media=${media_id} operations=${JSON.stringify(operations || [])}`);

  const media = mediaFiles.find(m => m.id === media_id);
  if (!media) {
    console.log(`[media] transform failed: media not found id=${media_id}`);
    res.status(404).json({ error: 'Media not found' });
    return;
  }

  if (!ALLOWED_IMAGES.includes(media.content_type)) {
    console.warn(`[media] transform rejected: not an image type=${media.content_type} id=${media_id}`);
    res.status(422).json({ error: 'Only images can be transformed' });
    return;
  }

  // Image processing (child span)
  const processResult = await tracer.startActiveSpan('image.process', async (imgSpan) => {
    imgSpan.setAttributes({
      'image.operations': JSON.stringify(operations || []),
      'image.source_type': media.content_type,
      'image.processor': 'imagemagick',
    });

    const processDuration = 200 + Math.random() * 1500;
    await sleep(processDuration);
    imgSpan.setAttributes({ 'image.duration_ms': Math.round(processDuration) });

    // Processing timeout
    if (processDuration > 1500 || Math.random() < 0.05) {
      const err = new Error('ImageMagick process killed: timeout');
      imgSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      imgSpan.recordException(err);
      console.error(`[media] transform timeout for ${media_id}`);
      imgSpan.end();
      return { ok: false, status: 504, error: 'Image processing timeout' };
    }

    // OOM during processing
    if (Math.random() < 0.03) {
      const err = new Error('ImageMagick: memory allocation failed');
      imgSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      imgSpan.recordException(err);
      console.error(`[media] transform OOM for ${media_id}`);
      imgSpan.end();
      return { ok: false, status: 500, error: 'Image processing failed: out of memory' };
    }

    imgSpan.setAttributes({ 'image.status': 'success' });
    imgSpan.end();
    return { ok: true, duration: Math.round(processDuration) };
  });

  if (!processResult.ok) {
    res.status(processResult.status).json({ error: processResult.error });
    return;
  }

  const transformedUrl = `${media.url}?transform=${uuidv4().slice(0, 8)}`;
  span.setAttributes({ 'transform.status': 'success' });
  console.log(`[media] transform complete: ${media_id}`);
  res.json({ url: transformedUrl, original_id: media_id, process_ms: processResult.duration });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: storageHealthy && cdnHealthy ? 'ok' : 'degraded',
    service: 'media',
    storage_healthy: storageHealthy,
    cdn_healthy: cdnHealthy,
    media_count: mediaFiles.length,
  });
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`[media] listening on :${PORT}`);
});
