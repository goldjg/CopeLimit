# CopeLimit — Architecture

This document describes the design decisions, data flows, and component boundaries of the CopeLimit project.

---

## Table of contents

1. [System overview](#system-overview)
2. [Frontend (React PWA)](#frontend-react-pwa)
3. [Backend (Netlify Functions)](#backend-netlify-functions)
4. [Library layer](#library-layer)
5. [Data flows](#data-flows)
   - [GitHub OAuth flow](#github-oauth-flow)
   - [Usage fetch flow](#usage-fetch-flow)
   - [iOS widget onboarding — Fast Setup](#ios-widget-onboarding--fast-setup)
   - [iOS widget usage fetch](#ios-widget-usage-fetch)
6. [Storage design](#storage-design)
   - [Blob record tiers](#blob-record-tiers)
7. [Security model](#security-model)
8. [Provider system](#provider-system)
9. [iOS Scriptable scripts](#ios-scriptable-scripts)
10. [Multi-context model (Horizon 2)](#multi-context-model-horizon-2)
11. [Billing state model](#billing-state-model)

---

## System overview

```
┌────────────────────────────────────────────────────────────┐
│  Client                                                    │
│                                                            │
│  ┌──────────────────┐     ┌──────────────────────────────┐ │
│  │  React PWA        │     │  Scriptable iOS Widget       │ │
│  │  (Vite + React)   │     │  CopeLimitWidget.js          │ │
│  └────────┬─────────┘     └──────────────┬───────────────┘ │
│           │ HTTPS                         │ HTTPS           │
└───────────┼───────────────────────────────┼─────────────────┘
            │                               │
            ▼                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Netlify                                                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CDN: dist/ (static Vite build)                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Functions (netlify/functions/)                        │  │
│  │                                                        │  │
│  │  auth-start        auth-callback      auth-logout      │  │
│  │  me                usage                               │  │
│  │  widget-token      widget-usage                        │  │
│  │  onboarding-session  onboarding-exchange               │  │
│  └───────────────────────────┬────────────────────────────┘  │
│                               │                              │
│  ┌────────────────────────────▼────────────────────────────┐  │
│  │  Netlify Blobs                                          │  │
│  │  widget-tokens         (Tier 1 — AES-256-GCM encrypted)    │  │
│  │  onboarding-sessions   (Tier 1 — AES-256-GCM encrypted)    │  │
│  │  provider-captures     (Tier 2/3 — sanitized telemetry)    │  │
│  │  usage-contexts        (Tier 1 — planned, Horizon 2)       │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
            │
            │ HTTPS
            ▼
┌──────────────────────────────┐
│  GitHub API                  │
│  api.github.com/copilot_      │
│  internal/user                │
│  login/oauth/...             │
└──────────────────────────────┘
```

---

## Frontend (React PWA)

The frontend is a single-page React application built with Vite. It is served as a static site from the `dist/` directory.

### Key components

| File | Purpose |
|---|---|
| `src/main.tsx` | Root `App` component, usage fetch, PWA install prompt, service worker registration |
| `src/WidgetTokenSection.tsx` | Widget token lifecycle UI, iOS onboarding state machine |
| `src/widget-onboarding.ts` | Platform-agnostic onboarding types and pure helper functions (unit-tested) |
| `src/styles.css` | Application styles |

### PWA features

- **Service worker** (`public/sw.js`): cache-first app shell with network-first navigation. Cache name is versioned (`copelimit-YYYY-MM-DD`) so deployments automatically purge stale assets.
- **Web app manifest** (`public/manifest.webmanifest`): enables Add to Home Screen on iOS and Chrome's `beforeinstallprompt` on Android/desktop.
- **Offline page** (`public/offline.html`): shown when a navigation request fails and the index is not cached.

---

## Backend (Netlify Functions)

All functions live in `netlify/functions/` and are TypeScript compiled by Netlify at deploy time. They are exposed via `netlify.toml` redirect rules under `/api/`.

| Function | Method(s) | Auth | Description |
|---|---|---|---|
| `auth-start` | GET | None | Start GitHub OAuth (sets CSRF cookie) |
| `auth-callback` | GET | None | Complete OAuth; issue session cookie |
| `auth-logout` | GET | None | Clear session cookie |
| `me` | GET | Optional | Return public user info from session |
| `usage` | GET | Provider-dependent | Return normalised Copilot quota |
| `widget-token` | GET/POST/DELETE | Session | Manage widget bearer tokens |
| `widget-usage` | GET | Widget token | Fetch quota for iOS widget |
| `onboarding-session` | POST | Session | Issue bootstrap token for iOS setup |
| `onboarding-exchange` | POST | Bootstrap token | Exchange bootstrap → widget token |

---

## Library layer

Shared code lives in `netlify/functions/lib/`:

| Module | Purpose |
|---|---|
| `copilot.ts` | Core `Usage` type, `normaliseUsage`, `warningLevel`, field readers |
| `session.ts` | HMAC-signed + optional AES-GCM session cookie helpers |
| `blob-crypto.ts` | AES-256-GCM encrypt/decrypt for Netlify Blobs |
| `widget-token.ts` | Opaque token generation, HMAC hashing, TTL helpers |
| `widget-store.ts` | Netlify Blobs CRUD for widget token records |
| `onboarding-store.ts` | Netlify Blobs CRUD for bootstrap token records |
| `capture-types.ts` | Types for the optional telemetry capture subsystem |
| `capture-config.ts` | Env var parsing for capture configuration |
| `capture-sanitize.ts` | Field allow-listing + sensitive value redaction |
| `capture-store.ts` | Blobs persistence for sanitised provider captures |

---

## Data flows

### GitHub OAuth flow

```
Browser                auth-start              GitHub                auth-callback
   │                       │                       │                       │
   │──GET /api/auth/start──►│                       │                       │
   │                       │──generate state──►     │                       │
   │◄──302 + oauth_state cookie──────────────────── │                       │
   │──redirect to GitHub────────────────────────────►                       │
   │◄──redirect to /api/auth/callback?code=...──────────────────────────────│
   │                                               auth-callback            │
   │                                                   │                    │
   │                                                   │──exchange code──►  │
   │                                                   │◄──access_token──   │
   │                                                   │──GET /user──────►  │
   │                                                   │◄──user info──────  │
   │◄──302 / + session cookie───────────────────────────────────────────────│
```

### Usage fetch flow

```
Browser                    usage function              GitHub API
   │                            │                          │
   │──GET /api/usage────────────►                          │
   │                            │ (provider=github-copilot-internal)
   │                            │──verify session cookie   │
   │                            │──GET /copilot_internal/user──────────►│
   │                            │◄──raw JSON────────────────────────────│
   │                            │──normaliseUsage()        │
   │                            │──maybeCapture() [async, fire-and-forget]
   │◄──200 Usage JSON───────────│
```

### iOS widget onboarding — Fast Setup

```
PWA (browser)      onboarding-session   Shortcuts app   CopeLimitInstall.js   onboarding-exchange
      │                    │                  │                  │                    │
      │──POST /session─────►                  │                  │                    │
      │◄──bootstrapToken───│                  │                  │                    │
      │──build payload JSON │                  │                  │                    │
      │──write to clipboard │                  │                  │                    │
      │──redirect to shortcuts://run-shortcut──►                  │                    │
      │                                        │──read clipboard──►                   │
      │                                        │──run script──────►                   │
      │                                        │                  │──POST /exchange────►
      │                                        │                  │◄──widgetToken──────│
      │                                        │                  │──Keychain.set()    │
      │◄──redirect /?shortcut=complete─────────────────────────────                   │
      │──verify token status (GET /api/widget-token)              │                    │
```

### iOS widget usage fetch

```
Scriptable (iOS)     widget-usage function    widget-store     GitHub API
       │                     │                    │               │
       │──GET /api/widget-usage                   │               │
       │  Authorization: Bearer <token>           │               │
       │─────────────────────►                    │               │
       │                     │──hashToken()       │               │
       │                     │──resolveWidgetToken──►             │
       │                     │◄──tokenRecord──────│               │
       │                     │──GET /copilot_internal/user──────► │
       │                     │◄──quota data───────────────────── │
       │                     │──normaliseUsage()  │               │
       │◄──200 Usage JSON────│                    │               │
```

---

## Storage design

### Blob store: `widget-tokens`

```
token/<sha256-hex>            ← Encrypted WidgetTokenRecord
user/<userId>                 ← Encrypted WidgetUserIndex
```

The user index allows `GET /api/widget-token` (token status) and `DELETE /api/widget-token` (revoke) to operate without knowing the hash — they look up the user index first.

### Blob store: `onboarding-sessions`

```
bt/<sha256-hex>               ← Encrypted BootstrapTokenRecord (15-min TTL)
onboarding-user/<userId>      ← Encrypted BootstrapUserIndex
```

Bootstrap tokens are deleted immediately on first use (single-use guarantee) and lazily cleaned up after expiry.

### Blob store: `provider-captures` (optional telemetry)

```
<provider>/<userId>/<YYYY-MM-DD>/<ISO-timestamp>.json  ← ProviderCapture
<provider>/<userId>/<YYYY-MM-DD>/_index.json           ← CaptureIndex (daily counter)
```

Old captures are deleted lazily when a new capture is written for the same provider/user prefix.

### Blob record tiers

Blob records are classified into tiers that determine their encryption
requirements:

| Tier | Description | Examples | Encryption |
|---|---|---|---|
| **Tier 1** | Sensitive credential records | `widget-tokens`, `onboarding-sessions`, `usage-contexts` (planned) | AES-256-GCM required via `BLOB_ENCRYPTION_KEY`. Must not be written unencrypted. |
| **Tier 2** | Sanitized append-only telemetry | `provider-captures/<provider>/<userId>/<date>/<ts>.json` | App-level encryption not required. Records contain only allowlisted, redacted fields. |
| **Tier 3** | Mutable provider-capture control blobs | `provider-captures/<provider>/<userId>/<date>/_index.json` | Recoverable and non-blocking. Loss does not affect live usage display. |
| **Tier 4** | Legacy plaintext migration | Tier 1 records written before encryption was introduced | Migrated automatically on first read. Applies to Tier 1 records only. |

### Encryption (Tier 1)

AES-256-GCM parameters used for all Tier 1 records:

- 12-byte random IV (nonce) per record
- 16-byte GCM authentication tag
- Format: `<iv_hex>:<ciphertext_hex>:<tag_hex>`
- Key: `BLOB_ENCRYPTION_KEY` (64-char hex = 32 bytes)

---

## Security model

### Session cookies

```
Cookie: session=<base64-payload>.<hmac-sha256>
```

- Payload is `JSON.stringify(SessionPayload)` or `"e:" + AES-256-GCM(JSON.stringify(SessionPayload))`.
- The `e:` prefix distinguishes encrypted from plaintext payloads for zero-downtime key rotation.
- `HttpOnly`, `SameSite=Lax`; `Secure` when deployed to HTTPS.

### Widget tokens

1. `generateOpaqueWidgetToken()` → 32 random bytes → base64url string (43 chars).
2. Only the HMAC-SHA256 hash is stored in Netlify Blobs.
3. The raw token is returned in the `POST /api/widget-token` response body **once** and never stored.

### Bootstrap tokens (iOS onboarding)

- Same generation mechanism as widget tokens.
- Single-use: consumed atomically on the first valid `POST /api/onboarding/exchange` call.
- 15-minute TTL (configurable via `ONBOARDING_BOOTSTRAP_TTL_SECONDS`).
- One active token per user — issuing a new one revokes the previous one.

### CSRF protection

OAuth state is a 16-byte random hex value stored in an `HttpOnly` cookie and compared to the callback `state` parameter using string equality (not timing-safe, but pre-token so safe against timing attacks in this context).

### Open-redirect protection

`CopeLimitInstall.js` validates `callbackUrl` against `BASE_URL` before any `Safari.open()` call to prevent the on-device script from being used as an open redirect.

---

## Provider system

The `COPELIMIT_PROVIDER` environment variable selects which data source is used by the `usage` function.

### `mock`

Returns static values from `MOCK_USED`, `MOCK_QUOTA`, `MOCK_RESET_AT` env vars. Useful for development and staging environments.

### `github-copilot-internal`

Calls `https://api.github.com/copilot_internal/user` using the GitHub OAuth access token from the session cookie. This is an unofficial internal API that provides per-user quota data. The API response shape is parsed with multi-path fallback logic to handle schema variations across API versions.

### `copilot-local`

Calls a local [`copilot-api`](https://github.com/nicepkg/copilot-api) proxy running at `http://127.0.0.1:4141` (configurable). This is an unofficial local proxy that also provides quota data. Useful for running CopeLimit entirely locally without deploying to Netlify.

### `unsupported` / `github`

Returns a zeroed `Usage` record with `source: "unsupported"` and an explanatory note. Used as a graceful fallback when real quota data is not available.

---

## iOS Scriptable scripts

Both scripts are served from `public/scriptable/` with `Cache-Control: no-cache, no-store` to ensure devices always fetch the latest version.

### `CopeLimitWidget.js`

Home-screen widget that:
1. Reads the widget token from `Keychain.get("copelimit_widget_token")`.
2. Calls `GET /api/widget-usage` with `Authorization: Bearer <token>`.
3. Renders a `ListWidget` with remaining quota, usage bar, reset date, and source label.

### `CopeLimitInstall.js`

Token installation script that:
1. Parses the bootstrap token from `Script.parameter()` (JSON from Shortcut clipboard) or `args.queryParameters.bt` (direct Scriptable deep link).
2. Calls `POST /api/onboarding/exchange` with the bootstrap token.
3. Stores the returned widget token in `Keychain.set("copelimit_widget_token", widgetToken)`.
4. Redirects back to the PWA callback URL.

---

## Multi-context model (Horizon 2)

This section documents the domain model and planned storage layout for
Horizon 2 multi-account / multi-context support. **No code implementing
this model exists yet.** This section establishes the canonical
terminology and design constraints that implementation PRs must follow.

### Glossary

| Term | Definition |
|---|---|
| **GitHub account** | A GitHub principal identified by a unique `login` and numeric `userId`. May be personal, an enterprise-managed user (EMU), or a service account. |
| **Authenticated identity** | The GitHub account that completed the OAuth flow in the current browser session. One per browser session; carries one `accessToken`. |
| **Copilot billing entity** | The GitHub entity (personal account, org, or enterprise) that holds the Copilot subscription and quota. A single authenticated identity may relate to more than one billing entity. |
| **Usage context** | The primary unit CopeLimit stores and displays. A pairing of (a) a resolvable credential path and (b) a billing entity. Carries `mode`, last-known usage snapshot, account-type hint, auth status, and capture support status. One authenticated identity may have one or more usage contexts. |
| **Widget-selected context** | The single `UsageContext` the Scriptable widget is configured to poll. No aggregation in Horizon 2. |
| **Context type** | An enumerated hint: `personal`, `org`, `enterprise`, or `unknown`. Used for display and evidence routing; not used to gate logic. |
| **Auth status** | Pollability state of a context: `active`, `expired`, `auth_unsupported`, or `unknown`. |
| **Capture support status** | Whether provider-response capture is available for a context: `supported`, `unsupported`, `opted_out`, or `pending_evidence`. |

### Domain model

#### UsageContext — display/billing-context abstraction

`UsageContext` is the display and billing-context abstraction. It carries
**no credential material**:

```typescript
type ContextType = 'personal' | 'org' | 'enterprise' | 'unknown';
type AuthStatus = 'active' | 'expired' | 'auth_unsupported' | 'unknown';
type CaptureSupportStatus = 'supported' | 'unsupported' | 'opted_out' | 'pending_evidence';

type UsageContext = {
  contextId: string;           // Stable opaque identifier (UUID)
  login: string;               // GitHub login of the owning authenticated identity
  userId: number;              // Numeric GitHub user ID
  billingEntity: string;       // Billing entity login (may differ for org/enterprise)
  contextType: ContextType;
  authStatus: AuthStatus;
  captureSupportStatus: CaptureSupportStatus;
  provider: string;            // e.g. 'github-copilot-internal'
  lastMode?: Mode;             // Last observed billing mode
  lastUsageSnapshot?: UsageSnapshot; // Last observed usage (no credential data)
  isDefault: boolean;
  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
  notes: string[];
};
```

#### Credential material — separate concern

GitHub access tokens associated with a usage context are **credential
material** with stricter handling requirements than context metadata:

- Must never be exposed to the browser or the iOS widget.
- Must always be stored AES-256-GCM encrypted (Tier 1).
- Modelled separately from the display/billing-context abstraction above.

```typescript
type UsageContextCredential = {
  contextId: string;            // Foreign key to UsageContext
  githubAccessToken: string;    // The GitHub OAuth access token
  credentialIssuedAt: string;   // ISO 8601
  credentialExpiresAt?: string; // ISO 8601, if known
};
```

**Implementation choice vs. conceptual requirement:** The initial Horizon 2
implementation may co-locate `UsageContext` metadata and its
`UsageContextCredential` in a single AES-256-GCM-encrypted (Tier 1) blob
record as a storage convenience. This is an **implementation choice**, not
a conceptual requirement. The domain model treats them as distinct
concerns; credential material can be split into a separate record key in a
later iteration without changing the conceptual model or the storage tier.

#### UsageSnapshot

A snapshot of observed usage stored inside `UsageContext`. Contains no
credential data:

```typescript
type UsageSnapshot = {
  used: number;
  quota: number;
  remaining: number;
  percentUsed: number;
  resetAt: string;   // ISO 8601
  mode: Mode;
  warningLevel: WarningLevel;
  capturedAt: string; // ISO 8601
};
```

### Planned blob store: `usage-contexts`

```
context/<contextId>           ← Encrypted UsageContextRecord  (Tier 1)
user/<userId>/index           ← Encrypted UsageContextUserIndex (Tier 1)
```

`UsageContextRecord` co-locates `UsageContext` metadata and its
`UsageContextCredential` in a single encrypted Tier 1 blob. The credential
fields are annotated as a distinct concern within the record.

`UsageContextUserIndex` holds the ordered list of `contextId` values for a
user and which one is the default.

### Relationship to existing types

| Existing type | Relationship |
|---|---|
| `Usage` (copilot.ts) | Remains the wire shape returned by `/api/usage` and `/api/widget-usage`. Not changed. |
| `SessionPayload` (session.ts) | Continues to hold the single authenticated identity's credentials for the active session. Not changed. |
| `WidgetTokenRecord` (widget-store.ts) | Gains an optional `contextId?: string` field (Horizon 2, PR 5). When absent, behaviour is unchanged. |
| `UsageContext` | New type. Stored in `usage-contexts` blob store. Derived from `SessionPayload` at context registration time. |

### Key invariants

- `UsageContext` is the primary stored object. CopeLimit stores **usage
  contexts**, not accounts.
- Credential material must be stored separately from — or clearly annotated
  as distinct from — the display/billing-context metadata.
- **Cross-context contamination guard:** when resolving a widget token to a
  context, validate that `UsageContext.userId === WidgetTokenRecord.userId`
  before proceeding.
- Adding a second context via OAuth must not overwrite the primary session
  cookie. The callback must inspect a sentinel parameter (e.g.
  `?add_context=true`) to distinguish context-addition from fresh login.
- Unsupported/unknown context states (`auth_unsupported`) must be visible
  in the UI and diagnosable, not silently hidden.
- Evidence capture for unsupported contexts is opt-in and sanitized.

### Horizon 2 non-goals

- No FinOps / GitHub AI usage report ingestion.
- No exact model-level cost attribution.
- No enterprise API calls until a safe normalization path is established
  from real observed payloads.
- No widget aggregate view (one selected context only in Horizon 2).
- No new paid infrastructure or new database.

---

## Billing state model

This section documents the `BillingPhase` design derived from newly
observed fields in the `copilot_internal/user` API response. **No code
implementing this model exists yet.** This section establishes the
canonical terminology and detection logic for the implementation PR
tracked in `.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml`.

### Motivation

GitHub's transition from premium requests to AI Credits (effective
1 June 2026) introduced a two-tier quota model:

1. **Included credits** — a fixed monthly allocation (e.g. 7,000 AI
   Credits for Copilot Pro) that resets each billing cycle.
2. **Budget-backed credits** — additional usage drawn against a
   spend budget when included credits are exhausted, if the user has
   configured one.

The current `Usage` type has no way to express which tier is active, whether
a budget is configured but not yet consumed, or whether usage is unlimited.
The `BillingPhase` model fills this gap.

### Newly observed API fields

All fields live at
`quota_snapshots.premium_interactions.*` in the
`copilot_internal/user` response body (alongside the existing
`entitlement`, `remaining`, and `reset_date` fields):

| Field | Type | Description |
|---|---|---|
| `token_based_billing` | `boolean` | Already tracked; signals AI Credits mode. |
| `overage_count` | `number` | Credits consumed beyond the included quota (budget-backed credits used so far this period). |
| `overage_entitlement` | `number` | Budget allocation in credit-equivalent units (e.g. $50 budget expressed as credit headroom). |
| `overage_permitted` | `boolean` | `true` when the user has enabled additional/budget-backed usage; `false` or absent when not. |
| `unlimited` | `boolean` | `true` when usage is unlimited (no quota cap). |
| `has_quota` | `boolean` | `false` when the account has no quota at all (hard stop). |

**Trust boundary note:** all of these fields originate from the
`copilot_internal/user` external response and must be treated as
low-trust. None may drive a repository write target without validation.
The API shape may change without notice.

### BillingPhase state model

```typescript
/**
 * The billing phase captures where in the credit/budget lifecycle the
 * current usage falls.
 *
 * Detection priority (first match wins):
 *  1. unlimited        — unlimited === true
 *  2. credits_available — remaining > 0
 *  3. budget_active    — overage_count > 0 && overage_permitted === true
 *  4. budget_available — remaining === 0 && overage_permitted === true && overage_count === 0
 *  5. hard_stop        — has_quota === false && unlimited !== true
 *  6. credits_exhausted — remaining === 0 && overage_permitted !== true
 */
type BillingPhase =
  | 'credits_available'   // Included credits remaining; budget not yet needed
  | 'credits_exhausted'   // Included credits = 0; no budget configured or enabled
  | 'budget_available'    // Included credits = 0; budget enabled; no overage consumed yet
  | 'budget_active'       // Budget spending in progress (overage_count > 0)
  | 'unlimited'           // Unlimited usage (unlimited === true)
  | 'hard_stop';          // No quota, no budget, no unlimited (has_quota === false)
```

### Phase transition diagram

```
                        ┌──────────────┐
                        │   unlimited  │  (unlimited === true)
                        └──────────────┘

          ┌──────────────────────────────────────────────────────┐
          │                 has_quota === true                   │
          │                                                      │
          ▼                                                      │
  ┌──────────────────┐  credits     ┌───────────────────────┐   │
  │ credits_available│──exhausted──►│                       │   │
  │  remaining > 0   │             │  overage_permitted?    │   │
  └──────────────────┘             └───────────┬───────────┘   │
                                              │                 │
                               ┌──────────────┴──────────────┐ │
                            true (budget)              false   │ │
                               │                        │      │ │
                               ▼                        ▼      │ │
                  ┌────────────────────┐  ┌─────────────────┐  │ │
                  │  budget_available  │  │credits_exhausted│  │ │
                  │  overage_count = 0 │  │ (soft stop)     │  │ │
                  └────────┬───────────┘  └─────────────────┘  │ │
                           │ overage_count > 0                  │ │
                           ▼                                    │ │
                  ┌────────────────────┐                        │ │
                  │   budget_active    │                        │ │
                  │  drawing on budget │                        │ │
                  └────────────────────┘                        │ │
                                                                │ │
          ┌──────────────────────────────────────────────────────┘ │
          │  has_quota === false                                    │
          ▼                                                         │
  ┌──────────────────┐                                             │
  │    hard_stop     │◄────────────────────────────────────────────┘
  └──────────────────┘
```

### Phase summary table

| Phase | Detection condition | UI wording (suggested) | Warning level |
|---|---|---|---|
| `credits_available` | `remaining > 0` | "X AI credits remaining (Y of Z)" | derived from `percentUsed` |
| `credits_exhausted` | `remaining == 0`, `overage_permitted !== true` (reached only after `hard_stop` guard) | "Included credits used — no budget configured" | `over` |
| `budget_available` | `remaining == 0`, `overage_permitted === true`, `overage_count == 0` | "Included credits used — budget ready" | `over` (badge), informational |
| `budget_active` | `overage_count > 0`, `overage_permitted === true` | "Using budget: X credits used" | derived from `overage_count / overage_entitlement` |
| `unlimited` | `unlimited === true` | "Unlimited usage" | `normal` |
| `hard_stop` | `has_quota === false`, `unlimited !== true` | "No quota available" | `over` |

### Normalization implications

1. **`Usage` type extension (Horizon 1 follow-up):**
   - Add `billingPhase: BillingPhase` to the `Usage` type in `copilot.ts`.
   - Add optional `overageCount?: number` and `overageEntitlement?: number`
     for display in `budget_active` phase.
   - `normaliseUsage` should accept these optional inputs and pass them
     through; the detection function `detectBillingPhase` should live in
     `copilot.ts`.

2. **`warningLevel` semantics:** The existing percentage-based `WarningLevel`
   remains unchanged. For `budget_active` phase, `percentUsed` reflects the
   included-credits fill (will be ≥ 100 %) while `billingPhase` provides the
   richer context. No extension to `WarningLevel` is planned at this stage.

3. **`UsageSnapshot` (Horizon 2):** The `UsageSnapshot` type stored inside
   `UsageContext` should add `billingPhase?: BillingPhase` when the
   Horizon 2 multi-context implementation lands.

4. **Provider compatibility:** `BillingPhase` is a normalised abstraction.
   The `github-copilot-internal` provider will populate it from the fields
   listed above. Other providers (`mock`, `copilot-local`) should default
   to `credits_available` unless they expose equivalent field semantics.

5. **No-surprise-spend guard:** `budget_available` and `budget_active`
   phases must only be presented when `overage_permitted === true` is
   observed in the API response. CopeLimit must never surface assumed
   additional usage without data evidence.

### Current observed state (captured 2026-06-18)

```
quota_snapshots.premium_interactions:
  entitlement:        7000
  remaining:          31
  used:               6969
  overage_count:      0
  overage_entitlement: (budget-equivalent; $50/month)
  overage_permitted:  true
  unlimited:          false
  has_quota:          true
  token_based_billing: true

Derived BillingPhase: credits_available
  (remaining = 31 > 0; overage not yet consumed)

Next expected phase: budget_available
  (after remaining 31 credits are consumed)
```

### Roadmap

Implementation of this model is tracked in
`.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml`.
