# Deploy & release runbook

This is the exact, ordered set of steps to take `Arabicss-softphone-update` from an empty
repo to a live update service that gates the Windows softphone. Steps marked **[you]** need a
human (interactive auth / an external dashboard); everything else is automated.

## 0. Secrets & variables you will create

| Name                    | Where                         | What it is                                                              |
|-------------------------|-------------------------------|------------------------------------------------------------------------|
| `UPDATE_API_TOKEN`      | Railway var **+** GH secret   | Client read token. Sent by the softphone as `X-Arabicss-Token`.        |
| `WEBHOOK_SECRET`        | Railway var **+** GH secret   | Server-only secret for `POST /api/manifest`. Never shipped to clients. |
| `RAILWAY_WEBHOOK_URL`   | GH **variable**               | `https://<your-app>.up.railway.app/api/manifest`                       |
| `MAIN_APP_REPO`         | GH **variable** (optional)    | `owner/repo` of the private main-app source, only if building in CI.   |
| `MAIN_APP_DEPLOY_KEY`   | GH secret (optional)          | SSH deploy key for that private repo.                                   |
| `ARABICSS_UPDATE_URL`   | GH **variable** (optional)    | Endpoint baked into the client at CI build time.                       |

Generate strong tokens:

```bash
openssl rand -hex 32      # run twice: one for UPDATE_API_TOKEN, one for WEBHOOK_SECRET
```

## 1. Deploy to Railway **[you]**

1. Push this repo to GitHub (see §3) or connect the repo directly in the Railway dashboard.
2. In Railway: **New Project → Deploy from GitHub repo →** select `Arabicss-softphone-update`.
   Nixpacks auto-detects Node and runs `node server.js` (also defined in `railway.json` /
   `Procfile`). No build step, no dependencies.
3. Add service **Variables**: `UPDATE_API_TOKEN`, `WEBHOOK_SECRET`. (`PORT` is injected by
   Railway automatically.)
4. Generate a public domain (Settings → Networking → Generate Domain). That gives you
   `https://<your-app>.up.railway.app`. The health check at `/healthz` should go green.

Verify:

```bash
curl -s https://<your-app>.up.railway.app/healthz
curl -s -H "X-Arabicss-Token: $UPDATE_API_TOKEN" https://<your-app>.up.railway.app/api/version
```

## 2. Add the GitHub Actions secrets/variables **[you]**

```bash
gh secret  set UPDATE_API_TOKEN   --repo hossameldfrawy/Arabicss-softphone-update
gh secret  set WEBHOOK_SECRET     --repo hossameldfrawy/Arabicss-softphone-update
gh variable set RAILWAY_WEBHOOK_URL --repo hossameldfrawy/Arabicss-softphone-update \
  --body "https://<your-app>.up.railway.app/api/manifest"
# optional, only if you want CI to compile the .exe from the private main-app repo:
gh variable set MAIN_APP_REPO     --repo hossameldfrawy/Arabicss-softphone-update --body "owner/main-app-repo"
gh secret  set MAIN_APP_DEPLOY_KEY --repo hossameldfrawy/Arabicss-softphone-update < deploy_key
```

## 3. Push + the one workflow-scope step **[you]**

The active `gh` account is authenticated with `repo` scope but **not** `workflow`, so the
first push that contains `.github/workflows/release-pc.yml` is rejected by GitHub. Grant it
once:

```bash
gh auth refresh -h github.com -s workflow      # opens a browser once
git push -u origin main
```

(If you prefer not to refresh, push every other file first and add the workflow through the
GitHub web UI, which carries the scope implicitly.)

## 4. Enable branch protection **[you]**

Branch protection / rulesets on **private** repos require GitHub Pro/Team. With a paid plan:

```bash
gh api -X PUT repos/hossameldfrawy/Arabicss-softphone-update/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_pull_request_reviews.required_approving_review_count=1 \
  -F enforce_admins=true \
  -F required_status_checks=null \
  -F restrictions=null
```

On GitHub Free for a private repo this returns `403 Upgrade`. Either make the repo public, or
upgrade the plan, then run the command above. (The repo is created private per spec.)

## 5. Cut a release

Two supported paths:

**A. Pure release-automation (recommended to start):** build the installer locally with the
existing `windows\installer\build-arabicss-setup.ps1`, then:

```bash
# tag drives the version; H_<number> only
git tag H_11 && git push origin H_11
# the release job will FAIL fast asking for the .exe — so instead trigger manually with the
# file, OR create the release first and attach ArabicssSoftphone_Setup_H_11.exe, then:
gh workflow run release-pc.yml -f version=H_11 -f mandatory=true -f notes="Critical security update."
```

The `release` job hashes the installer, writes + commits `manifest.json`, publishes the GitHub
Release, and POSTs the webhook so Railway serves `H_11` instantly.

**B. Build in CI (advanced):** set `MAIN_APP_REPO` + `MAIN_APP_DEPLOY_KEY`. The `build` job
checks out the main app, installs Qt6 + MSVC, compiles `Libyate;_updater;Qt4Client`, and packs
the installer. The Yate Qt6 build is heavy and historically fragile (serial, v145 toolset,
must kill any running `yate-qt4.exe` before linking) — treat the `build` job as a scaffold to
tune against your runner, not a guaranteed-green turnkey. Path A is the safe default.

## 6. Rolling back

Set `manifest.json` `latest_version` back to a prior `H_<n>` and `mandatory:false`, or POST the
webhook with the old manifest. The client never downgrades, so lowering `latest_version` simply
stops prompting; it does not push the old build to anyone.
