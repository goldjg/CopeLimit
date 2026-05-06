# CopeLimit

A tiny Copilot usage meter for people who want to know how close they are to the wall before they hit it.

CopeLimit is an MVP for showing GitHub Copilot premium request / future AI credit usage in a lightweight dashboard and an iOS widget-friendly JSON shape.

## Why this exists

GitHub Copilot usage is moving target territory. Premium requests exist today, GitHub has announced a move toward AI Credits from 1 June 2026, and the exact availability of user-level quota data through public APIs may vary by plan, role, and billing model.

So CopeLimit is deliberately designed around a provider abstraction:

- `mock` provider for development and UI work
- `github` provider placeholder for authenticated billing/usage API integration where available
- `github-copilot-internal` provider for hosted Netlify usage via `https://api.github.com/copilot_internal/user`
- `copilot-local` provider that reads usage from a local `copilot-api` proxy (`http://127.0.0.1:4141`)
- a stable public JSON shape for Scriptable, Shortcuts, widgets, and the PWA

## MVP shape

```text
GitHub usage source / mock provider
        ↓
Netlify Function: /.netlify/functions/usage
        ↓
React PWA dashboard
        ↓
Scriptable iOS widget
```

## Quick start

```bash
npm install
npm run dev
```

By default the app uses mock data.

Set:

```bash
COPELIMIT_PROVIDER=mock
```

For hosted Copilot usage on Netlify, set:

```bash
COPELIMIT_PROVIDER=github-copilot-internal
SESSION_SECRET=...                 # strong random string
SESSION_ENCRYPTION_KEY=...         # 64-char lowercase hex (openssl rand -hex 32)
BLOB_ENCRYPTION_KEY=...            # 64-char lowercase hex (openssl rand -hex 32)
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Notes:
- `SESSION_ENCRYPTION_KEY` is required in production to encrypt the signed session payload containing OAuth access tokens.
- The key must be 64 lowercase hex characters (32 bytes). Generate with `openssl rand -hex 32`.
- `BLOB_ENCRYPTION_KEY` is required to encrypt widget token records and user index entries in Netlify Blobs.
- Existing plaintext widget records are migrated automatically when first read after rollout.
- After enabling `copilot` OAuth scope, existing users must sign out and sign in again to refresh token scopes.

When a reliable public GitHub API source is available for your account type, switch to:

```bash
COPELIMIT_PROVIDER=github
GITHUB_TOKEN=...
GITHUB_LOGIN=goldjg
```

For local Copilot usage via the reverse-engineered `copilot-api` proxy:

```bash
npx copilot-api
# In another shell:
COPELIMIT_PROVIDER=copilot-local
COPILOT_API_URL=http://127.0.0.1:4141
```

Notes:
- `copilot-local` is optional and local-only.
- CopeLimit reads `GET /usage` only and never reads or exposes `GET /token`.
- Do not run `copilot-local` in a publicly exposed deployment without strict network/access controls.

## Deploy

This is Netlify-shaped out of the box.

```bash
npm run build
```

Netlify should publish `dist` and expose the function at:

```text
/.netlify/functions/usage
```

## iOS widget

The `scriptable/CopeLimitWidget.js` script is designed for the Scriptable app on iOS.

Set:

```javascript
const COPELIMIT_URL = "https://your-site.netlify.app/.netlify/functions/usage";
```

Then add it as a Scriptable widget.

## API response shape

```json
{
  "mode": "premium_requests",
  "used": 321,
  "quota": 500,
  "remaining": 179,
  "percentUsed": 64,
  "resetAt": "2026-06-01T00:00:00.000Z",
  "billingEntity": "goldjg",
  "source": "mock",
  "warningLevel": "normal",
  "updatedAt": "2026-05-04T18:00:00.000Z",
  "notes": [
    "Mock provider active. Replace with GitHub billing/usage provider when API access is confirmed."
  ]
}
```

## Design principle

The UI is not the hard part. The hard part is treating GitHub’s usage model as unstable without making the widget brittle.

CopeLimit therefore treats usage data as an adapter problem, not a front-end problem.
