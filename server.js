'use strict';
/**
 * Arabicss-softphone-update — secure version-manifest micro-backend.
 *
 * A deliberately tiny, ZERO-DEPENDENCY Node.js service (no npm install step, so it
 * cannot be poisoned by a transitive dependency) optimised for Railway.com. It serves
 * the authenticated JSON update manifest consumed by the Windows C++/Qt softphone's
 * boot-time version gate, and exposes a secured webhook the release pipeline calls to
 * flip the published version the instant a new GitHub Release is cut.
 *
 * Endpoints
 *   GET  /healthz       -> liveness probe (no auth)            {status,version}
 *   GET  /api/version   -> the update manifest (CLIENT auth)   requires X-Arabicss-Token
 *   POST /api/manifest  -> update the manifest (WEBHOOK auth)  requires X-Webhook-Secret
 *
 * Security model (honest):
 *   - HTTPS is terminated by Railway's edge; this process speaks plain HTTP behind it.
 *   - The client token (UPDATE_API_TOKEN) gates casual scraping. It is NOT a true secret —
 *     it ships inside every client binary — so it is a throttle, not the MitM defense.
 *   - The REAL integrity guarantee is end-to-end: the manifest carries the installer's
 *     SHA-256, and the client refuses to run any download whose hash does not match. Pair
 *     that with an Authenticode-signed installer for full chain-of-custody.
 *   - The webhook secret (WEBHOOK_SECRET) is a genuine server-side secret; never ship it
 *     to a client. Both comparisons are constant-time.
 *
 * Durability: the committed manifest.json is the source of truth (CI commits it, Railway
 * redeploys). The webhook writes a manifest.runtime.json override for INSTANT publishing
 * between deploys; Railway's filesystem is ephemeral, so that override is intentionally
 * transient and is reconciled by the next deploy's committed manifest.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.UPDATE_API_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(__dirname, 'manifest.json');
const RUNTIME_PATH = process.env.RUNTIME_MANIFEST_PATH || path.join(__dirname, 'manifest.runtime.json');
const MAX_BODY = 16 * 1024; // 16 KB cap on the webhook body

const VERSION_RE = /^H_\d+$/;            // strict H_<number> scheme (H_10, H_11, ...)
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

function nowIso() { return new Date().toISOString(); }
function log(...a) { console.log(`[${nowIso()}]`, ...a); }

// Constant-time string compare that never throws and is length-safe.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison to avoid trivially leaking length via timing.
    try { crypto.timingSafeEqual(ba, ba); } catch (_) {}
    return false;
  }
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

// Tolerate a UTF-8 BOM (Windows editors / PowerShell Set-Content add one) before JSON.parse.
function parseJsonLoose(text) {
  if (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF)
    text = text.slice(1);
  return JSON.parse(text);
}

function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (typeof m.latest_version !== 'string' || !VERSION_RE.test(m.latest_version))
    errs.push('latest_version must match H_<number> (e.g. H_11)');
  if (typeof m.download_url !== 'string' || !/^https:\/\//i.test(m.download_url))
    errs.push('download_url must be an https URL');
  if (typeof m.sha256 !== 'string' || !SHA256_RE.test(m.sha256))
    errs.push('sha256 must be 64 hex chars');
  if (typeof m.mandatory !== 'boolean')
    errs.push('mandatory must be a boolean');
  return errs;
}

function loadManifest() {
  // Prefer a webhook-written runtime override, else the committed manifest.json.
  for (const p of [RUNTIME_PATH, MANIFEST_PATH]) {
    try {
      if (fs.existsSync(p)) {
        const m = parseJsonLoose(fs.readFileSync(p, 'utf8'));
        const errs = validateManifest(m);
        if (errs.length) { log(`WARN ${p} invalid: ${errs.join('; ')}`); continue; }
        log(`loaded manifest from ${path.basename(p)} -> ${m.latest_version} (mandatory=${m.mandatory})`);
        return m;
      }
    } catch (e) { log(`WARN failed reading ${p}: ${e.message}`); }
  }
  log('WARN no valid manifest found; serving safe no-update default H_10');
  return {
    latest_version: 'H_10',
    download_url: 'https://github.com/hossameldfrawy/Arabicss-softphone-update/releases/download/H_10/ArabicssSoftphone_Setup_H_10.exe',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    mandatory: false,
    notes: 'Fallback baseline manifest (no manifest file present).',
    min_supported: 'H_10'
  };
}

let manifest = loadManifest();

function send(res, code, obj, extra) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  const finish = (err, data) => { if (!done) { done = true; cb(err, data); } };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { finish(new Error('body too large')); try { req.destroy(); } catch (_) {} return; }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => finish(e));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (_) { return send(res, 400, { error: 'bad request' }); }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // ---- liveness (no auth) ----
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    return send(res, 200, {
      status: 'ok',
      service: 'arabicss-softphone-update',
      version: manifest.latest_version,
      mandatory: manifest.mandatory,
      auth_required: !!TOKEN,
      webhook_enabled: !!WEBHOOK_SECRET
    });
  }

  // ---- the manifest the softphone gate reads (client token) ----
  if (req.method === 'GET' && pathname === '/api/version') {
    if (TOKEN && !safeEqual(req.headers['x-arabicss-token'], TOKEN)) {
      log(`401 /api/version from ${req.socket.remoteAddress} (bad/absent token)`);
      return send(res, 401, { error: 'unauthorized' });
    }
    return send(res, 200, manifest);
  }

  // ---- secured webhook the release pipeline calls (server secret) ----
  if (req.method === 'POST' && pathname === '/api/manifest') {
    if (!WEBHOOK_SECRET) return send(res, 503, { error: 'webhook disabled: WEBHOOK_SECRET unset' });
    if (!safeEqual(req.headers['x-webhook-secret'], WEBHOOK_SECRET)) {
      log(`401 /api/manifest from ${req.socket.remoteAddress} (bad webhook secret)`);
      return send(res, 401, { error: 'unauthorized' });
    }
    return readBody(req, (err, raw) => {
      if (err) return send(res, 413, { error: err.message });
      let next;
      try { next = parseJsonLoose(raw || '{}'); } catch (_) { return send(res, 400, { error: 'invalid json' }); }
      const errs = validateManifest(next);
      if (errs.length) return send(res, 422, { error: 'validation failed', details: errs });
      next.published_at = nowIso();
      try {
        fs.writeFileSync(RUNTIME_PATH, JSON.stringify(next, null, 2));
      } catch (e) {
        log(`WARN could not persist runtime override: ${e.message}`); // still serve from memory
      }
      manifest = next;
      log(`manifest updated via webhook -> ${manifest.latest_version} (mandatory=${manifest.mandatory})`);
      return send(res, 200, { ok: true, manifest });
    });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log(`arabicss-softphone-update listening on ${HOST}:${PORT}`);
  log(`  client auth ${TOKEN ? 'ENFORCED' : 'OPEN (UPDATE_API_TOKEN unset)'} | webhook ${WEBHOOK_SECRET ? 'ENABLED' : 'DISABLED'}`);
  log(`  serving version ${manifest.latest_version} (mandatory=${manifest.mandatory})`);
});

// Never let an unhandled error take the service down silently.
process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));
