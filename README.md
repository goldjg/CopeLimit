# CopeLimit

**CopeLimit** is a GitHub Copilot quota dashboard and iOS Scriptable widget, deployed as a Netlify PWA with serverless functions.

> "Your Copilot usage panic meter."

**Cost model:** `1 AI credit = $0.01` (derived estimate). Credits remain the source of truth.

## Features

- 📊 **Live quota meter** — shows used / remaining / quota with a colour-coded warning level
- 🔐 **GitHub OAuth login** — server-side session cookies; tokens never exposed to the browser
- 📱 **PWA** — installable on iOS (Add to Home Screen) and Android (`beforeinstallprompt`)
- 🍎 **iOS Scriptable widget** — home-screen widget with Fast Setup via iOS Shortcuts
- 🔔 **Web push notifications** — optional browser push alerts via the Web Push / VAPID standard
- 🔒 **Blob encryption** — all sensitive records in Netlify Blobs are AES-256-GCM encrypted at rest
- 📡 **Provider-agnostic** — supports `github-copilot-internal`, `copilot-local`, and `mock` providers
- 📜 **Usage history ledger** — optional timestamped snapshot persistence with deduplication, delta calculation, and configurable retention
- 📈 **Burn-trail charts** — fuel-gauge usage charts on the PWA and the iOS widget, derived from the history ledger with quota-reset detection

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Providers](#providers)
3. [Environment variables](#environment-variables)
4. [API reference](#api-reference)
5. [iOS widget setup](#ios-widget-setup)
6. [Local development](#local-development)
7. [Building and testing](#building-and-testing)
8. [Security model](#security-model)

---

## Architecture overview

```
Browser / iOS Widget
        │
        │ HTTPS
        ▼
Netlify CDN (dist/ — Vite-built React PWA)
        │
        │ Netlify redirects (/api/*)
        ▼
Netlify Functions (netlify/functions/*.ts)
        │
        ├── auth-start          GitHub OAuth initiation
        ├── auth-callback       GitHub OAuth completion + session cookie
        ├── auth-logout         Session cookie deletion
        ├── me                  Current user info
        ├── usage               Copilot quota (provider-dispatched)
        ├── history             Usage history snapshots (session-authenticated)
        ├── widget-token        Widget bearer token CRUD
        ├── widget-usage        Widget-token-authenticated quota endpoint
        ├── push-subscribe      WebPush subscription CRUD (GET/POST/DELETE)
        ├── push-send-test      Send a test push notification to all subscriptions
        ├── onboarding-session  Bootstrap token issuance (iOS setup)
        └── onboarding-exchange Bootstrap-to-widget-token exchange (iOS setup)
                │
                ▼
        Netlify Blobs (encrypted at rest)
        ├── widget-tokens       Per-user widget token records
        ├── onboarding-sessions Bootstrap token records (15-min TTL)
        ├── push-subscriptions  Per-user WebPush subscription records
        └── usage-history       Timestamped usage snapshots (optional ledger)
                │
                ▼
        GitHub API (api.github.com/copilot_internal/user)
```

For a detailed design document see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Providers

The data source is controlled by the `COPELIMIT_PROVIDER` environment variable.

| Value | Description | Auth required |
|---|---|---|
| `mock` *(default)* | Static values from `MOCK_*` env vars | No |
| `github-copilot-internal` | Live data from `api.github.com/copilot_internal/user` | GitHub OAuth (session cookie) |
| `copilot-local` | Unofficial local [`copilot-api`](https://github.com/nicepkg/copilot-api) proxy | No |
| `github` / `unsupported` | Returns zeroed unsupported usage with an explanation | No |

---

## Environment variables

### Authentication & sessions

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | **Yes** | Strong random string used to HMAC-sign session cookies |
| `SESSION_ENCRYPTION_KEY` | **Recommended in production** | 64-char lowercase hex (32 bytes) for AES-256-GCM session encryption. Generate with `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` | Yes (for OAuth) | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes (for OAuth) | GitHub OAuth App client secret |

### Storage

| Variable | Required | Description |
|---|---|---|
| `BLOB_ENCRYPTION_KEY` | **Yes** | 64-char lowercase hex (32 bytes) for encrypting Netlify Blobs records. Generate with `openssl rand -hex 32` |

### Provider selection

| Variable | Required | Description |
|---|---|---|
| `COPELIMIT_PROVIDER` | Yes | Provider key: `mock`, `github-copilot-internal`, `copilot-local`, `unsupported` |
| `COPILOT_API_URL` | For `copilot-local` | Override local proxy URL (default: `http://127.0.0.1:4141`) |
| `GITHUB_LOGIN` | Optional | Fallback GitHub login for `copilot-local` billing entity label |

### Mock provider

| Variable | Default | Description |
|---|---|---|
| `MOCK_USED` | `321` | Number of premium requests used |
| `MOCK_QUOTA` | `500` | Quota limit |
| `MOCK_RESET_AT` | Start of next month | ISO 8601 quota reset timestamp |

### Widget tokens

| Variable | Default | Description |
|---|---|---|
| `WIDGET_TOKEN_TTL_DAYS` | `90` | Widget bearer token lifetime in days |
| `WIDGET_TOKEN_HASH_SECRET` | falls back to `SESSION_SECRET` | HMAC-SHA256 secret for hashing widget tokens |
| `ONBOARDING_BOOTSTRAP_TTL_SECONDS` | `900` (15 min) | Bootstrap token TTL for iOS onboarding |

### Optional telemetry capture

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_PROVIDER_RESPONSES` | `false` | Enable sanitised provider response capture |
| `PROVIDER_CAPTURE_RETENTION_DAYS` | `30` | Days to retain capture records |
| `PROVIDER_CAPTURE_MAX_PER_DAY` | `10` | Max captures stored per user per day |
| `PROVIDER_CAPTURE_INCLUDE_NORMALIZED` | `true` | Include normalised usage in captures |

### Usage history ledger

| Variable | Default | Description |
|---|---|---|
| `USAGE_HISTORY_ENABLED` | `false` | Enable timestamped usage snapshot persistence |
| `USAGE_HISTORY_RETENTION_DAYS` | `90` | Days to retain history entries (lazy cleanup on next write) |
| `USAGE_HISTORY_MAX_PER_DAY` | `48` | Max snapshots stored per user per UTC day (~every 30 min) |

### Web push notifications

Push notifications require three VAPID environment variables. When any is absent, push endpoints return a `503` or report `vapidPublicKey: null`; the rest of the app is unaffected.

| Variable | Required | Description |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Yes (for push) | Base64url-encoded VAPID public key — served to browsers for subscription |
| `VAPID_PRIVATE_KEY` | Yes (for push) | Base64url-encoded VAPID private key — **never sent to clients** |
| `VAPID_SUBJECT` | Yes (for push) | VAPID contact URI: `mailto:admin@example.com` or `https://your-domain.com` |

Generate a VAPID key pair with the `web-push` CLI:

```sh
npx web-push generate-vapid-keys
```

#### iOS notifications

- iOS Web Push only works for **installed Home Screen web apps**. Safari browser tabs do not provide the same notification flow.
- Install CopeLimit with **Share → Add to Home Screen**, then open the installed app before enabling notifications.
- Notification permission remains behind an explicit user action inside the PWA.
- After a successful subscription on iOS, CopeLimit should appear in **Settings → Notifications**.
- iOS may throttle or delay delivery even when subscription succeeds.

---

## API reference

All endpoints are served as Netlify Functions via the `/api/` prefix (see `netlify.toml`).

### `GET /api/me`

Returns the current authenticated user or `{ authenticated: false }`.

**Response (authenticated)**
```json
{ "authenticated": true, "login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/..." }
```

---

### `GET /api/usage`

Returns normalised Copilot quota data from the configured provider.

**Response**
```json
{
  "mode": "premium_requests",
  "used": 321,
  "quota": 500,
  "remaining": 179,
  "percentUsed": 64,
  "resetAt": "2026-06-01T00:00:00.000Z",
  "billingEntity": "octocat",
  "source": "github-copilot-internal",
  "warningLevel": "normal",
  "updatedAt": "2026-05-07T21:00:00.000Z",
  "notes": [],
  "billingPhase": "credits_available",
  "includedQuotaCostUsd": 32.1,
  "totalUsedCostUsd": 32.1,
  "overageCostUsd": 0,
  "overageBudgetCostUsd": 0,
  "budgetRemainingCostUsd": 0,
  "estimatedRemainingBudgetCostUsd": 0
}
```

`warningLevel` is one of: `normal` (< 75 %), `warm` (≥ 75 %), `hot` (≥ 90 %), `over` (≥ 100 %).

`billingPhase` is one of:

| Value | Description |
|---|---|
| `credits_available` | Included credits remain; budget not yet needed. |
| `credits_exhausted` | Credits at zero; no budget configured. |
| `budget_available` | Credits exhausted; budget enabled but not yet consumed. |
| `budget_active` | Budget spending in progress (`overageCount > 0` or `rawRemaining < 0`). |
| `unlimited` | Unlimited usage. |
| `hard_stop` | No quota, no budget, no unlimited. |

When `billingPhase` is `budget_active`, the response may include:

| Field | Description |
|---|---|
| `overageCount` | Budget-backed credits consumed beyond the included quota. |
| `overageEntitlement` | Configured budget allocation in credit-equivalent units. |
| `derivedOverageCredits` | Estimated overage from negative `rawRemaining` (settlement-lag window). |

USD fields are **derived estimates** (`1 credit = $0.01`) and kept secondary to credits:

| Field | Description |
|---|---|
| `includedQuotaCostUsd` | Estimated USD value of included credits consumed (`min(used, quota)`). |
| `totalUsedCostUsd` | Estimated USD value of total credits consumed (`used`). |
| `overageCostUsd` | Estimated USD value of overage credits consumed. |
| `overageBudgetCostUsd` | Estimated USD value of configured overage budget. |
| `budgetRemainingCostUsd` | Estimated USD budget remaining from settled counters. |
| `estimatedRemainingBudgetCostUsd` | Estimated USD budget remaining using derived overage during settlement lag. |
| `projectedCostAtResetUsd` | Optional projected USD total at reset (when available). |

---

### `GET /api/history`

Returns usage history snapshots for the authenticated user, ordered newest-first. Requires a valid session cookie; returns `401` when unauthenticated.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer ≥ 0 | Return at most this many snapshots. |
| `from` | `YYYY-MM-DD` | Earliest UTC date to include (inclusive). |
| `to` | `YYYY-MM-DD` | Latest UTC date to include (inclusive). |
| `summary` | `true` | Include derived burn-rate metrics in the response. |

**Response (without `?summary=true`)**
```json
{
  "snapshots": [
    {
      "capturedAt": "2026-06-15T10:00:00.000Z",
      "used": 3000,
      "quota": 7000,
      "remaining": 4000,
      "billingPhase": "credits_available"
    }
  ],
  "count": 1
}
```

**Response (with `?summary=true`)**
```json
{
  "snapshots": [...],
  "count": 5,
  "summary": {
    "deltaUsed": 1500,
    "creditsPerHour": 125.0,
    "creditsPerDay": 3000.0,
    "averageBurnRate": 130.0,
    "burnRateCostPerHourUsd": 1.25,
    "averageBurnRateCostPerHourUsd": 1.30,
    "burnCostPerDayUsd": 30.0,
    "snapshotCount": 5,
    "oldestAt": "2026-06-15T02:00:00.000Z",
    "newestAt": "2026-06-15T14:00:00.000Z"
  }
}
```

Derived metrics:

| Field | Description |
|---|---|
| `deltaUsed` | Net credits consumed (sum of positive per-interval deltas; quota resets excluded). |
| `creditsPerHour` | Overall burn rate: `deltaUsed / windowHours`. `null` if fewer than 2 snapshots. |
| `creditsPerDay` | `creditsPerHour × 24`. `null` if fewer than 2 snapshots. |
| `averageBurnRate` | Mean of per-interval burn rates. `null` if no qualifying intervals. |
| `snapshotCount` | Number of snapshots in the returned window. |
| `oldestAt` | ISO timestamp of the oldest snapshot. `null` if empty. |
| `newestAt` | ISO timestamp of the newest snapshot. `null` if empty. |

Snapshots contain no raw provider payloads, no `billingEntity`, and no credential data.

---

### `GET /api/auth/start`

Initiates GitHub OAuth. Redirects to GitHub's authorisation endpoint with a CSRF state cookie.

---

### `GET /api/auth/callback`

GitHub OAuth callback. Exchanges the code for a token, fetches user info, sets a session cookie, and redirects to `/`.

---

### `GET /api/auth/logout`

Clears the session cookie and redirects to `/`.

---

### Widget token management (session-authenticated)

#### `GET /api/widget-token`

Returns the token status without revealing the raw token.

**Response**
```json
{ "ttlDays": 90, "hasActiveToken": true, "expiresAt": "2026-08-05T00:00:00.000Z" }
```

#### `POST /api/widget-token`

Issues a new widget token (revokes any existing one). The raw token is returned **once only**.

**Response**
```json
{
  "token": "<opaque-bearer-token>",
  "expiresAt": "2026-08-05T00:00:00.000Z",
  "ttlDays": 90,
  "login": "octocat",
  "replacedExisting": false
}
```

#### `DELETE /api/widget-token`

Revokes the active widget token.

**Response**
```json
{ "revoked": true }
```

---

### `GET /api/widget-usage`

Widget-token-authenticated usage endpoint called by the Scriptable iOS widget.

**Authentication**: `Authorization: Bearer <token>` or `X-Widget-Token: <token>` header.

**Response**: same shape as `/api/usage`.

When called with `?extras=1` (large widget), `widgetExtras` can include:

| Field | Description |
|---|---|
| `burnRate` | Burn rate in credits/hour. |
| `burnRateCostPerHourUsd` | Burn rate in derived USD/hour. |
| `sparkline` | Up to 14 `used` values, oldest-first, for trend rendering. |

---

### Push notification endpoints (session-authenticated)

#### `GET /api/push/subscribe`

Returns the VAPID public key and subscription status for the authenticated user.

**Response**
```json
{
  "vapidPublicKey": "<base64url-key or null>",
  "subscriptionCount": 1,
  "hasSubscriptions": true
}
```

`vapidPublicKey` is `null` when `VAPID_PUBLIC_KEY` is not configured. The client should show a "notifications not available" state in that case.

#### `POST /api/push/subscribe`

Registers (or updates) a push subscription for the authenticated user.

**Request body**
```json
{
  "endpoint": "https://push.example.com/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "userAgent": "Mozilla/5.0 ...",
  "source": "copelimit-pwa"
}
```

**Response**
```json
{ "registered": true, "createdAt": "2026-06-25T20:00:00.000Z" }
```

#### `DELETE /api/push/subscribe`

Unregisters a push subscription by endpoint.

**Request body**
```json
{ "endpoint": "https://push.example.com/..." }
```

**Response**
```json
{ "unregistered": true }
```

---

#### `POST /api/push/test`

Sends a test push notification to all registered subscriptions for the authenticated user. Useful for verifying that VAPID keys and delivery are configured correctly end-to-end.

**Response (200 — at least one delivery succeeded)**
```json
{ "sent": true, "successCount": 1, "failCount": 0 }
```

**Error responses**

| Status | Condition |
|---|---|
| `401` | No valid session cookie |
| `404` | No push subscriptions registered for this user |
| `503` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, or `VAPID_SUBJECT` not configured |
| `500` | All deliveries failed (provider error or expired subscription) |
| `405` | Method not allowed |

---

### iOS onboarding endpoints

#### `POST /api/onboarding/session`

Issues a 15-minute single-use bootstrap token for the iOS setup flow. Requires a session cookie.

**Response**
```json
{ "onboardingSessionId": "<session-id>", "bootstrapToken": "<token>", "expiresAt": "...", "ttlSeconds": 900 }
```

#### `POST /api/onboarding/exchange`

Exchanges a bootstrap token for a long-lived widget token. Called by `CopeLimitInstall.js` on-device.

**Request body**
```json
{ "bootstrapToken": "<token>" }
```

**Response**
```json
{ "widgetToken": "<token>", "expiresAt": "...", "ttlDays": 90, "login": "octocat" }
```

#### `GET /api/onboarding/status?sessionId=<session-id>`

Returns completion status for a specific onboarding session owned by the authenticated user.

**Response**
```json
{ "sessionId": "<session-id>", "completed": true, "completedAt": "...", "scriptableConfigured": true }
```

---

## iOS widget setup

The iOS widget requires [Scriptable](https://scriptable.app).

### Fast Setup (recommended)

1. Open the CopeLimit PWA on your iPhone or iPad (install it first via **Share → Add to Home Screen**).
2. Sign in with GitHub.
3. Tap **Set Up Widget →** in the Widget Token section.
4. Tap **Set Up Widget →** again to install the `CopeLimitInstaller` Shortcut if prompted.
5. Follow the on-screen prompts — the Shortcut installs/updates `CopeLimit` and `CopeLimitInstall` scripts.
6. Back in the PWA, tap **Configure token in Scriptable** to run `CopeLimitInstall`.
7. Add a Scriptable widget to your home screen and select `CopeLimit`.

### Manual Setup

1. Copy `CopeLimitWidget.js` from the PWA into Scriptable (name it `CopeLimit`).
2. Copy `CopeLimitInstall.js` from the PWA into Scriptable (name it `CopeLimitInstall`).
3. From the PWA tap **Connect via Scriptable** to run the installer.
4. Add a Scriptable widget and select `CopeLimit`.

---

## Local development

### Prerequisites

- Node.js 20+
- Netlify CLI (`npm install -g netlify-cli`)

### Setup

```sh
git clone https://github.com/goldjg/CopeLimit
cd CopeLimit
npm install
```

Create a `.env` file (or configure Netlify environment variables):

```env
COPELIMIT_PROVIDER=mock
SESSION_SECRET=your-random-string-here
# For hosted provider:
# COPELIMIT_PROVIDER=github-copilot-internal
# GITHUB_CLIENT_ID=your-client-id
# GITHUB_CLIENT_SECRET=your-client-secret
# SESSION_ENCRYPTION_KEY=$(openssl rand -hex 32)
# BLOB_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

### Run locally

```sh
netlify dev
```

This starts the Vite dev server and Netlify Functions on `http://localhost:8888`.

---

## Building and testing

```sh
# Type-check and build (output to dist/)
npm run build

# Run all tests (Vitest)
npm test

# Lint (note: currently fails on TS5107 for moduleResolution: Node)
npm run lint
```

Tests cover the backend library (`netlify/functions/lib/__tests__/`) and frontend utilities (`src/**/*.test.ts`).

---

## Security model

- **Session cookies** are HMAC-SHA256 signed. When `SESSION_ENCRYPTION_KEY` is set the payload is AES-256-GCM encrypted before signing.
- **Widget tokens** are opaque random 32-byte values stored as HMAC-SHA256 hashes. The raw token is shown once and never stored.
- **Bootstrap tokens** (iOS onboarding) are single-use, 15-minute TTL tokens destroyed on first use.
- **Blob records** are AES-256-GCM encrypted at rest via `BLOB_ENCRYPTION_KEY`.
- **GitHub access tokens** are stored only in encrypted session cookies and encrypted Blob records; they are never logged or returned to the browser.
- **CSRF protection** — OAuth state parameter validated against a `HttpOnly` cookie.
- **Redirect validation** — Shortcut callback URLs are validated to ensure they share the same origin as the PWA.
- **Key isolation** — `BLOB_ENCRYPTION_KEY` and `SESSION_ENCRYPTION_KEY` are independent keys with separate purposes.
- **VAPID private key** — `VAPID_PRIVATE_KEY` is used server-side only and is never returned to the browser; only the public key is served to clients.

For self-hosted deployments, rotate both keys immediately if they are believed compromised. Existing sessions and widget tokens will become invalid (users will need to sign in again and re-generate their widget token).
