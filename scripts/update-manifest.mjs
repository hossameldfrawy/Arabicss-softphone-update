#!/usr/bin/env node
/**
 * update-manifest.mjs — compute an installer's SHA-256, write manifest.json, and
 * (optionally) push the new manifest to the running Railway service via the secured
 * webhook. Zero dependencies (Node 18+ stdlib + global fetch). Used by release-pc.yml,
 * and runnable by hand for manual releases.
 *
 * Usage:
 *   node scripts/update-manifest.mjs \
 *     --file dist/ArabicssSoftphone_Setup_H_11.exe \
 *     --version H_11 \
 *     --url https://github.com/OWNER/REPO/releases/download/H_11/ArabicssSoftphone_Setup_H_11.exe \
 *     --mandatory true \
 *     --notes "Critical security update." \
 *     --out manifest.json \
 *     [--webhook]        # also POST to $RAILWAY_WEBHOOK_URL using $WEBHOOK_SECRET
 *
 * --file may be omitted if --sha256 <hex> is supplied directly.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

const VERSION_RE = /^H_\d+$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

function die(msg) { console.error(`update-manifest: ${msg}`); process.exit(1); }

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

async function main() {
  const a = parseArgs(process.argv);

  const version = a.version || process.env.RELEASE_VERSION;
  if (!version || !VERSION_RE.test(version)) die('--version must match H_<number> (e.g. H_11)');

  let sha256 = a.sha256;
  if (!sha256) {
    if (!a.file) die('provide --file <installer> or --sha256 <hex>');
    if (!fs.existsSync(a.file)) die(`file not found: ${a.file}`);
    sha256 = sha256File(a.file);
  }
  if (!SHA256_RE.test(sha256)) die('sha256 must be 64 hex chars');

  const url = a.url || process.env.RELEASE_URL;
  if (!url || !/^https:\/\//i.test(url)) die('--url must be an https URL');

  const mandatory = String(a.mandatory).toLowerCase() === 'true';

  const manifest = {
    latest_version: version,
    download_url: url,
    sha256: sha256.toLowerCase(),
    mandatory,
    notes: a.notes || `ArabicssSoftphone ${version}.`,
    min_supported: a['min-supported'] || version,
    published_at: new Date().toISOString()
  };

  const out = a.out || 'manifest.json';
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${out}:`);
  console.log(JSON.stringify(manifest, null, 2));

  if (a.webhook) {
    const hookUrl = process.env.RAILWAY_WEBHOOK_URL;
    const secret = process.env.WEBHOOK_SECRET;
    if (!hookUrl || !secret) die('--webhook needs $RAILWAY_WEBHOOK_URL and $WEBHOOK_SECRET');
    const res = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
      body: JSON.stringify(manifest)
    });
    const text = await res.text();
    if (!res.ok) die(`webhook POST failed: ${res.status} ${text}`);
    console.log(`webhook OK (${res.status}): ${text}`);
  }
}

main().catch((e) => die(e && e.stack || String(e)));
