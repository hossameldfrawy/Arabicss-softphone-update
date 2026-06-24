# Arabicss-softphone-update

Secure auto-update backend + release pipeline for the **ArabicssSoftphone** Windows PC/laptop
softphone (C++/Qt). This repository is **intentionally isolated** from the main application
source — it holds only the update manifest service, the release automation, and the deploy
docs. No PC app source, no mobile/Flutter anything.

## What this does

```
                              (1) HTTPS GET /api/version  + X-Arabicss-Token
   ┌───────────────────┐      ─────────────────────────────────────────────►   ┌──────────────────────┐
   │  ArabicssSoftphone │                                                        │  Railway micro-backend│
   │  (Windows, C++/Qt) │   ◄─────────────────────────────────────────────      │  server.js (this repo)│
   │  boot-time gate    │      { latest_version, download_url, sha256,           └──────────┬───────────┘
   └─────────┬─────────┘         mandatory }                                                │
             │                                                                  (3) POST /api/manifest
             │ (2) if isNewerH(latest, local) && mandatory:                        X-Webhook-Secret
             │     app-modal gate → download to %TEMP% → verify SHA-256 →                    ▲
             │     run installer /S → self-terminate → relaunch new build                    │
             ▼                                                                                │
   ┌───────────────────┐      git tag H_11 / dispatch    ┌───────────────────────────────────┴───┐
   │   GitHub Release   │   ◄──────────────────────────  │ .github/workflows/release-pc.yml        │
   │  Setup_H_11.exe    │      build → release → hash →   │ (build* → release → manifest → webhook) │
   └───────────────────┘      manifest → webhook         └─────────────────────────────────────────┘
```

## Version scheme — strict `H_<number>`

The softphone's hardcoded baseline is **`H_10`**. Every subsequent build increments the
number: `H_11`, `H_12`, … Comparison is purely numeric on the integer after `H_`
(`H_10` < `H_11` < `H_100`). There is no dotted semver. The client refuses to act on any
`latest_version` that is not strictly newer than its own baseline, so a stale or rolled-back
manifest can never trigger a downgrade.

## The manifest

`GET /api/version` (authenticated) returns:

```json
{
  "latest_version": "H_11",
  "download_url": "https://github.com/hossameldfrawy/Arabicss-softphone-update/releases/download/H_11/ArabicssSoftphone_Setup_H_11.exe",
  "sha256": "<64 hex chars of the installer>",
  "mandatory": true,
  "notes": "Critical security update.",
  "min_supported": "H_10"
}
```

`manifest.json` (committed) is the durable source of truth. The release pipeline rewrites it
on every release and also pushes it to the live service via the webhook for instant publish.

## Endpoints

| Method | Path            | Auth                          | Purpose                                  |
|--------|-----------------|-------------------------------|------------------------------------------|
| GET    | `/healthz`      | none                          | Liveness probe.                          |
| GET    | `/api/version`  | `X-Arabicss-Token`            | The manifest the softphone gate reads.   |
| POST   | `/api/manifest` | `X-Webhook-Secret`            | Release pipeline publishes a new manifest.|

## Security model (stated honestly)

- **TLS** is terminated at Railway's edge; the integrity of the *download* is guaranteed
  end-to-end by the **SHA-256 in the manifest** — the client will not execute any installer
  whose hash does not match. Sign the installer with Authenticode for full chain-of-custody.
- `UPDATE_API_TOKEN` (the client token) is a **throttle, not a true secret** — it ships inside
  every client binary. Treat it as anti-scraping, never as the MitM defense.
- `WEBHOOK_SECRET` **is** a real secret; it lives only in Railway + GitHub Actions and is never
  shipped to a client. Both header checks are constant-time.
- **Fail-open by design:** if the softphone cannot reach this service at startup (outage, proxy,
  offline), it starts normally. The gate only ever engages on a *successfully fetched* manifest
  that reports a newer **mandatory** version — a backend outage can never lock out the fleet.

## Quick start (local)

```bash
cp .env.example .env        # set UPDATE_API_TOKEN + WEBHOOK_SECRET
npm start                   # no dependencies to install
curl -s localhost:8080/healthz
curl -s -H "X-Arabicss-Token: <token>" localhost:8080/api/version
```

## Deploy + release

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for: deploying to Railway, setting the four
secrets/variables, enabling branch protection, the one `gh auth refresh -s workflow` step,
and cutting an `H_<n>` release.

## License

The backend and tooling in this repo are MIT (see `LICENSE`). The softphone they update is
derived from YATE and is GPL — see `NOTICE`.
