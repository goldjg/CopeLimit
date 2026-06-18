<!-- version: 1.4.0 -->
# Durable Architectural Truth Cache

This cache stores durable project truths that should persist beyond a
single task. Update it only when a stable fact, decision, invariant, or
unresolved question should carry forward.

## Project purpose

CopeLimit is a GitHub Copilot usage visibility tool — a "panic meter"
for Copilot consumption. It reads live Copilot quota data from the
GitHub Copilot internal API (`api.github.com/copilot_internal/user`),
normalises it into a stable app-facing `Usage` shape, and surfaces it
as a React PWA dashboard and an iOS Scriptable home-screen widget
deployed on Netlify.

CopeLimit exists partly to support AADLCv2 cost-observability
experiments by making Copilot consumption visible across PRs, so that
future PRs can compare cost/request behaviour against a hydrated
baseline.

## Non-goals

- CopeLimit does not provision, configure, or manage Copilot
  subscriptions, billing, or account settings.
- CopeLimit must not assume that additional or pay-as-you-go usage is
  enabled. Avoid surprise-spend assumptions and clearly distinguish
  included credits from additional usage where the data supports it.
- CopeLimit does not expose raw GitHub access tokens to the browser or
  the iOS widget (tokens are stored only in encrypted cookies and blobs).
- CopeLimit does not modify GitHub account settings or access any GitHub
  API beyond quota data and OAuth endpoints.

## Architecture summary

`.github/copilot-instructions.md` is the root operating model.
`.github/instructions/` contains modular single-concern instruction
packs. `.github/aadlc/` contains AADLCv2 governance artefacts and
templates, not instruction-pack logic.

**CopeLimit project shape:**
- Frontend: Vite + React PWA served as a Netlify static site (`dist/`).
  Key files: `src/main.tsx` (root app), `src/WidgetTokenSection.tsx`
  (iOS onboarding state machine), `src/widget-onboarding.ts`
  (platform-agnostic onboarding helpers, unit-tested).
- Backend: Netlify Functions in `netlify/functions/` (TypeScript).
  Shared library in `netlify/functions/lib/`. `copilot.ts` is the
  single source of truth for the `Usage` type and `normaliseUsage`.
- Storage: Netlify Blobs. Records follow a tiered encryption model:
  sensitive credential records (Tier 1) are AES-256-GCM encrypted via
  `BLOB_ENCRYPTION_KEY`; sanitized append-only telemetry records (Tier 2)
  do not require app-level encryption; mutable control blobs (Tier 3)
  are recoverable and non-blocking; legacy plaintext migration (Tier 4)
  applies to Tier 1 records only.
- Blob stores: `widget-tokens` (Tier 1), `onboarding-sessions` (Tier 1),
  `provider-captures` (Tier 2/3), `usage-history` (Tier 2/3).
- External: `api.github.com/copilot_internal/user` (live quota),
  GitHub OAuth for authentication.
- iOS: `public/scriptable/CopeLimitWidget.js` (home-screen widget) and
  `public/scriptable/CopeLimitInstall.js` (bootstrap token installer),
  orchestrated via iOS Shortcuts Fast Setup.

## Core invariants

- Instruction packs should remain modular and focused on a single
  concern.
- The root Copilot instructions act as the repository constitution.
- Existing language, platform, cloud, and core packs should not be
  modified as side effects of unrelated changes.
- AADLCv2 artefacts should reduce semantic rediscovery without becoming
  a per-turn session diary.
- Prompt-as-code should be used for substantial, long, or
  boundary-sensitive agent tasks.

## Trust boundaries

Full boundary table: `.github/aadlc/trust-boundaries.md`.

CopeLimit-specific boundaries:
- `copilot_internal/user` API responses are external/low-trust. They
  must not drive repository write targets without validation. The API
  shape has changed historically and may change again.
- The raw GitHub access token must never be returned to the browser or
  the iOS widget. It lives only in encrypted session cookies and
  encrypted Netlify Blob records.
- Netlify Blob records follow a tiered encryption model:
  - **Tier 1** (sensitive credential records — widget tokens, bootstrap
    tokens, session-linked access tokens): application-level AES-256-GCM
    encryption via `BLOB_ENCRYPTION_KEY` is required. These records must
    not be written unencrypted.
  - **Tier 2** (sanitized append-only telemetry — provider captures):
    application-level encryption is not required. Records contain only
    allowlisted, redacted fields.
  - **Tier 3** (mutable provider-capture control blobs — e.g.
    `_index.json`): recoverable and non-blocking. Loss does not affect
    live usage display.
  - **Tier 4** (legacy plaintext migration): applies to Tier 1 records
    only. Legacy plaintext records written before encryption was
    introduced are migrated automatically on first read.
- Bootstrap tokens (iOS onboarding) are single-use and 15-minute TTL.
  They must be consumed atomically and deleted on first use.

## Known sharp edges

- Long nested prompts in agent UIs may truncate or misparse; prefer
  committed plan files for boundary-sensitive work.
- Agents may over-anchor on completed PR contracts; distinguish durable
  invariants from historical PR constraints.
- Model availability and capability can vary; fallback models must
  preserve the active PR contract.
- Repeated corrective prompting is a failure signal; reset the session
  or switch model instead of continuing prompt ping-pong.
- `npm run lint` fails on TS5107 (deprecated
  `moduleResolution: Node` in `tsconfig.json`). Do not treat as a
  blocking gate until resolved. `npm run build` and `npm test` both pass.
- iOS standalone PWA never sees `?shortcut=complete` because Shortcuts
  and Scriptable open callbacks in Safari (not the PWA). The
  `visibilitychange` + `pageshow` event listeners in
  `WidgetTokenSection.tsx` advance onboarding state when the PWA
  regains foreground.

## Field findings

- **Billing model transition (effective 1 June 2026):** GitHub has
  transitioned from Premium Requests to AI Credits. The live GitHub
  website now displays included usage as AI Credits, e.g.
  "0 / 7,000 AI credits."
- **Legacy API fields remain:** The `copilot_internal/user` response
  may still expose `premium_interactions.entitlement`,
  `premium_interactions.remaining`, and a reset date under the
  `quota_snapshots.premium_interactions` path. These numeric values
  remain valid as a source of normalised usage data — they now
  represent AI Credits rather than premium request units.
- **Transition markers:** The API payload may include
  `token_based_billing: true` and/or
  `quota_snapshots.premium_interactions.token_based_billing: true` to
  signal that credit-based billing is active.
- **Current implementation:** `getCopilotInternalUsage` in
  `netlify/functions/usage.ts` and `getWidgetCopilotInternalUsage` in
  `netlify/functions/widget-usage.ts` now call `detectMode(body)` to
  select `mode: 'ai_credits'` when `token_based_billing` markers are
  detected, falling back to `mode: 'premium_requests'` otherwise.
- **Additional/budget-backed usage fields (observed 2026-06-18):** The
  `quota_snapshots.premium_interactions` object now exposes the following
  additional fields alongside the existing `entitlement`, `remaining`, and
  `reset_date`:
  - `overage_count` (`number`) — credits consumed beyond included quota.
    Zero when budget spending has not started; may also be zero during a
    settlement lag window even when `remaining < 0`.
  - `overage_entitlement` (`number`) — budget allocation expressed in
    credit-equivalent headroom (e.g. a $50 budget maps to a
    credit-equivalent value).
  - `overage_permitted` (`boolean`) — `true` when additional/budget-backed
    usage is enabled; `false` or absent when not.
  - `unlimited` (`boolean`) — `true` when usage is not quota-capped.
  - `has_quota` (`boolean`) — `false` when the account has no quota at all
    (hard stop condition).
- **Observed state, capture 1 (2026-06-18):** `entitlement: 7000`,
  `remaining: 31`, `overage_count: 0`, `overage_permitted: true`,
  `unlimited: false`, `has_quota: true`. Budget: $50/month configured but not
  yet consumed. `BillingPhase`: `credits_available`.
- **Observed state, capture 2 (2026-06-18 — detection gap):**
  `entitlement: 7000`, `remaining: -473` (raw API), normalized to 0,
  `overage_count: 0`, `overage_permitted: true`. GitHub billing page: $0 / $50
  consumed. Correct `BillingPhase`: `budget_active` (473 credits consumed beyond
  quota). Current detection incorrectly returns `budget_available` because
  clamping destroys the `remaining < 0` signal before `detectBillingPhase` sees
  it. **Fix required:** pass `rawRemaining` (pre-clamp) to `detectBillingPhase`
  and extend detection priority 3 to fire on `rawRemaining < 0`.
- **Settlement lag:** `remaining` tracks real-time credit consumption.
  `overage_count` tracks credits that have been settled and charged against the
  budget — a billing-cycle event. `remaining` can go negative before
  `overage_count` increments. The billing page may show $0 consumed while
  `remaining = -473`. Both signals are required to determine the true phase.
- **Derived overage credits:** `Math.max(0, -(rawRemaining))` gives the
  in-period overage estimate when `overage_count` has not yet updated. For
  capture 2: 473 credits.
- **Pay-as-you-go:** Additional / pay-as-you-go usage may be disabled
  and should not be assumed enabled. CopeLimit should not surface
  assumed additional usage without data support. The `overage_permitted`
  field is now the authoritative gate for this check.
- **Onboarding session verification** uses `GET /api/onboarding/status`
  for a specific onboarding session ID, not generic widget-token active
  status.

## BillingPhase state model

The `BillingPhase` type captures which tier of the credit/budget lifecycle is
active. It is derived from newly observed `copilot_internal/user` API fields.
`BillingPhase` is implemented in `copilot.ts`. Detection uses `rawRemaining`
(pre-clamp API value) — see `ARCHITECTURE.md` § "Negative remaining".

```typescript
type BillingPhase =
  | 'credits_available'   // rawRemaining > 0
  | 'credits_exhausted'   // rawRemaining <= 0; no budget configured
  | 'budget_available'    // rawRemaining === 0; budget enabled; overage_count = 0
  | 'budget_active'       // overage_count > 0 OR rawRemaining < 0; overage_permitted = true
  | 'unlimited'           // unlimited === true
  | 'hard_stop';          // has_quota === false && unlimited !== true
```

Detection priority (first match wins; uses `rawRemaining`, the pre-clamp value):
1. `unlimited` — `unlimited === true`
2. `credits_available` — `rawRemaining > 0`
3. `budget_active` — `(overage_count > 0 || rawRemaining < 0) && overage_permitted === true`
4. `budget_available` — `rawRemaining === 0 && overage_permitted === true && overage_count === 0`
5. `hard_stop` — `has_quota === false && unlimited !== true`
6. `credits_exhausted` — default (`rawRemaining <= 0 && overage_permitted !== true`)

**Guard invariant:** `budget_available` and `budget_active` phases must
only be presented when `overage_permitted === true` is observed in the API
response. Never surface assumed additional usage without data evidence.

**Implementation status:** `BillingPhase`, `detectBillingPhase()`, and
`readOverageFields()` are implemented in `copilot.ts`. The `rawRemaining`
parameter and detection priority 3 amendment are tracked as a required fix in
`.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml`.

Full design (phase table, transition diagram, normalization implications):
`ARCHITECTURE.md` § "Billing state model".



### Goal

Make CopeLimit useful for people who have more than one GitHub / Copilot
usage context. No FinOps / report ingestion; no exact model-level cost
attribution. Current single-account personal Pro behaviour must not break.

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

### UsageContext — display/billing-context abstraction

`UsageContext` is the display and billing-context abstraction. It carries
**no credential material**:

```typescript
type UsageContext = {
  contextId: string;           // Stable opaque identifier (UUID)
  login: string;               // GitHub login of the owning authenticated identity
  userId: number;              // Numeric GitHub user ID
  billingEntity: string;       // Billing entity login (may differ for org/enterprise)
  contextType: ContextType;    // 'personal' | 'org' | 'enterprise' | 'unknown'
  authStatus: AuthStatus;      // 'active' | 'expired' | 'auth_unsupported' | 'unknown'
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

### Credential material — separate concern

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

**Implementation choice vs. conceptual requirement:** The initial Horizon
2 implementation may co-locate `UsageContext` metadata and its
`UsageContextCredential` in a single AES-256-GCM-encrypted (Tier 1) blob
record as a storage convenience. This is an **implementation choice**, not
a conceptual requirement. The domain model treats them as distinct
concerns; credential material can be split into a separate record key in a
later iteration without changing the conceptual model or the storage tier.

### New invariants (Horizon 2)

- `UsageContext` is the primary stored object. CopeLimit stores **usage
  contexts**, not accounts.
- Credential material (`githubAccessToken`) must be stored separately
  from — or at minimum clearly annotated as distinct from — the
  display/billing-context metadata within the encrypted blob record.
- `WidgetTokenRecord` may carry an optional `contextId` to bind the
  widget token to a specific context. When absent, the widget resolves
  against the user's default context (backward-compatible).
- **Cross-context contamination guard:** when resolving a widget token to
  a context, the server must validate that `UsageContext.userId` matches
  `WidgetTokenRecord.userId` before proceeding.
- Adding a second context via OAuth must not overwrite the primary session
  cookie. The callback must inspect a sentinel parameter (e.g.
  `?add_context=true`) to distinguish context-addition from fresh login.
- Unsupported/unknown context states (`auth_unsupported`) must be visible
  in the UI and diagnosable, not silently hidden.
- Evidence capture for unsupported contexts is opt-in and sanitized via
  `capture-sanitize.ts`. The allowlist must not be broadened without
  explicit justification.
- Do not build FinOps/report ingestion, GitHub AI usage report import, or
  exact model-level cost attribution in Horizon 2.
- Do not assume enterprise/org/business usage uses the same API shape as
  personal usage.


## Horizon 3 FinOps / AADLC attribution model

### Goal

Add a bounded FinOps layer that helps answer five questions without
pretending exact attribution exists where it does not: how many AI
Credits were consumed, which repo/branch/PR/run probably consumed them,
which AADLC phase likely burned the most, how confident that
attribution is, and whether the spend was bounded, intentional, and
useful.

Core principle: the agent describes activity, CopeLimit observes balance
changes, and the FinOps layer reconciles the two with explicit
confidence labels plus separate contamination status.

### Horizon 3 glossary

| Term | Definition |
|---|---|
| **AI Credit** | A GitHub Copilot consumption unit under token-based billing. Live CopeLimit counters are treated as observed numeric balances, not exact per-action cost records. |
| **Usage checkpoint** | A point-in-time snapshot of remaining/used/quota/mode data captured from CopeLimit live state, GitHub UI, a future GitHub usage report import, or manual entry. |
| **AADLC run manifest** | A compact structured summary of one governed AADLC run. It describes what the agent did; it does not claim exact billing attribution on its own. |
| **AADLC phase event** | A labelled sub-segment inside a run (for example hydration, planning, implementation, validation, review-fix, docs). |
| **Attribution confidence** | How strong the evidence is that a delta belongs to a run or phase: `observed`, `declared`, `inferred`, or `unknown`. |
| **Contamination status** | Separate status indicating whether attribution is overlapped or otherwise mixed with other activity. Contamination is not a confidence label. |
| **Observation/timing noise** | Small ambiguity introduced by checkpoint timing, UI refresh cadence, or capture lag. This should be recorded as caveat text, not presented as evidence of extra credit consumption. |
| **Reconciliation** | Comparison between checkpoint-backed observations and future imported GitHub usage-report summaries. Conflicts should be retained and shown, not silently collapsed. |

### Canonical object model

Horizon 3 should treat the following as the canonical bounded FinOps
objects:

- `UsageCheckpoint` — first-class point-in-time observation.
- `AADLCRunManifest` — agent-declared run summary.
- `AADLCPhaseEvent` — agent-declared phase summary nested within a run.
- `AttributionRecord` — CopeLimit-derived reconciliation object linking
  checkpoint deltas to runs/phases with confidence plus contamination
  status.

A checkpoint can exist without a run. A run can exist without
checkpoints. Phase costs are only `observed` when they have their own
checkpoint backing; otherwise phase costs are `inferred` from broader
run data.

### AADLC Run Manifest v0.1 (minimum viable)

```typescript
type AADLCRunManifest = {
  schemaVersion: '0.1';
  manifestId: string;
  repo: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  runType:
    | 'planning'
    | 'implementation'
    | 'review_fix'
    | 'investigation'
    | 'debugging'
    | 'documentation'
    | 'mixed'
    | 'unknown';
  taskTitle: string;
  taskIntent: string;
  startedAt?: string;
  endedAt?: string;
  modelDeclared?: string;
  beforeCheckpointId?: string;
  afterCheckpointId?: string;
  filesRead?: string[];
  filesChanged?: string[];
  commandsRun?: string[];
  validationResults?: Array<{
    command: string;
    passed: boolean;
    notes?: string;
  }>;
  phases?: AADLCPhaseEvent[];
  explicitNonGoals?: string[];
  userSteeringEvents?: string[];
  attributionConfidenceDeclared?:
    | 'observed'
    | 'declared'
    | 'inferred'
    | 'unknown';
  contaminationStatusDeclared?:
    | 'clean'
    | 'overlapped'
    | 'external_activity'
    | 'unknown';
  notesCaveats?: string[];
  emittedAt: string;
};
```

**Required fields:** `schemaVersion`, `manifestId`, `repo`, `runType`,
`taskTitle`, `taskIntent`, `emittedAt`.

**Optional fields:** branch/PR references, timestamps, declared model,
checkpoint IDs, file/command summaries, validation summaries,
phase events, non-goals, user-steering notes, caveats.

**Explicitly forbidden fields:** raw GitHub OAuth tokens, widget tokens,
bootstrap tokens, Blob encryption keys, cookies/session identifiers, raw
provider payloads, raw GitHub usage reports, file contents, command
stdout/stderr, or any secret-bearing free text.

**Emission policy:** in Horizon 3 MVP, manifests should be emitted in the
final agent response when operating under an AADLC PR contract or when
the user explicitly requests a run summary. They should not be required
for every trivial interaction. Default path is output-only manifest
summary first, manual paste/import later, and no repo-committed run
artefact by default.

### AADLC Phase Event v0.1 (minimum viable)

```typescript
type AADLCPhaseEvent = {
  phaseId: string;
  phaseName: string;
  phaseType:
    | 'hydration'
    | 'planning'
    | 'implementation'
    | 'test_debug'
    | 'review_fix'
    | 'docs'
    | 'validation'
    | 'user_steering'
    | 'pr_creation'
    | 'unknown';
  startedAt?: string;
  endedAt?: string;
  beforeCheckpointId?: string;
  afterCheckpointId?: string;
  actions?: string[];
  filesRead?: string[];
  filesChanged?: string[];
  commandsRun?: string[];
  attributionConfidenceDeclared?:
    | 'observed'
    | 'declared'
    | 'inferred'
    | 'unknown';
  contaminationStatusDeclared?:
    | 'clean'
    | 'overlapped'
    | 'external_activity'
    | 'unknown';
  notesCaveats?: string[];
};
```

Minimum viable requirement: enough structure to distinguish planning,
implementation, test/debug, review-fix, docs, validation, and user
steering. Planning-only work may use a single phase event. Phase-level
attribution is `observed` only when phase-specific checkpoints exist;
otherwise any per-phase cost is `inferred`.

### Usage checkpoint model

```typescript
type UsageCheckpoint = {
  checkpointId: string;
  usageContextId?: string;
  source:
    | 'copelimit_live'
    | 'github_ui'
    | 'github_report'
    | 'manual'
    | 'unknown';
  remaining: number;
  used: number;
  quota: number;
  mode: 'ai_credits' | 'premium_requests' | 'unknown';
  resetAt?: string;
  capturedAt: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  freshness: 'fresh' | 'stale' | 'unknown';
  notes?: string;
};
```

Checkpoint capture priority for MVP:

1. Manual start/end checkpoints recorded from CopeLimit live state.
2. Manual checkpoints entered from GitHub UI when needed.
3. Future import/reconciliation from GitHub usage reports.

Do not assume one GitHub account equals one billing context. Preserve
optional `usageContextId` for later Horizon 2 integration.

### Attribution and contamination model

**Confidence labels:**

- `observed` — checkpoint-backed delta for the run or phase.
- `declared` — agent described the activity, but checkpoint support is
  partial or user-supplied.
- `inferred` — CopeLimit estimated a phase allocation from broader
  checkpoint-backed run data.
- `unknown` — insufficient evidence.

**Contamination status (separate from confidence):**

- `clean` — no known overlapping declared activity.
- `overlapped` — two or more runs/phases share the same checkpoint
  window.
- `external_activity` — the user reports other GitHub/agent activity in
  the same window.
- `unknown` — overlap status is not known.

A run-level delta can still be `observed` and carry contamination status
`unknown` or `external_activity` if the checkpoints are real but the
window is not fully isolated. Observation/timing noise should be
recorded in notes/caveats; it does not by itself disqualify an
attribution from being checkpoint-backed.

### Horizon 3 storage and delivery boundaries

- Prefer Netlify Blobs plus existing architecture for Horizon 3 MVP.
- FinOps records are Tier 2 sanitized append-only telemetry.
- A future mutable FinOps index blob would be Tier 3 recoverable control
  state.
- Do not require a new database for the MVP.
- Do not require agents to commit run artefacts into the repository by
  default.
- Do not broaden sanitizer allowlists.
- Do not store or log raw GitHub usage-report files; future import should
  retain only sanitized summaries plus reconciliation state.

### Horizon 3 explicit non-goals

- No all-at-once FinOps platform.
- No exact model-level billing attribution unless GitHub exposes it.
- No assumption that GitHub usage-report schema is stable.
- No multi-account implementation in Horizon 3.
- No budget enforcement in Horizon 3 MVP.
- No API/UI/storage implementation in this governance phase.
- No requirement that every trivial agent interaction emits a manifest.


## Canonical validation commands

- `npm run build` — TypeScript compilation + Vite bundle. Last known validation state: passes.
- `npm test` — Vitest unit tests covering `netlify/functions/lib/`
  backend and `src/` frontend utilities. Last known validation state: passes.
- `npm run lint` — TypeScript `--noEmit` check. Last known validation state: fails on TS5107
  (deprecated `moduleResolution: Node` in `tsconfig.json`). Not a blocking gate until tsconfig is updated.

## Current operating assumptions

Model availability is not a stable invariant. The PR contract remains
the source of truth across model fallback.

The billing model is AI Credits as of 1 June 2026. Any PR that touches
usage normalisation must reason about both `premium_requests` (legacy
fields / fallback) and `ai_credits` (token-based billing detected)
modes.

## Open questions

- Does the live `copilot_internal/user` API response now include
  `token_based_billing: true` or
  `quota_snapshots.premium_interactions.token_based_billing: true`?
  Requires a live API capture or GitHub Copilot API changelog to confirm
  the exact field name and nesting.
  **RESOLVED (2026-06-18):** Both paths have been observed. The existing
  `detectMode` implementation (checking both locations) is confirmed
  correct.
- Are the numeric values in `premium_interactions.entitlement` and
  `remaining` now expressed in AI Credit units (e.g. integers up to
  ~7,000) rather than premium request units (e.g. integers up to ~500)?
  **RESOLVED (2026-06-18):** Confirmed. Live observed values:
  `entitlement: 7000`, `remaining: 31`. AI Credit scale.
- Is additional/pay-as-you-go usage data exposed anywhere in the
  `copilot_internal/user` response under the new billing model? If so,
  what is the field path and how should CopeLimit present it?
  **RESOLVED (2026-06-18):** `quota_snapshots.premium_interactions`
  exposes `overage_count`, `overage_entitlement`, `overage_permitted`,
  `unlimited`, and `has_quota`. The `BillingPhase` state model (see
  `ARCHITECTURE.md` § "Billing state model") addresses presentation.
  Implementation tracked in `horizon-1-pr2-billing-phase.plan.yml`.
- Can `remaining` go negative in the `copilot_internal/user` API response?
  **OBSERVED (2026-06-18, capture 2):** Yes. `remaining: -473` with
  `overage_count: 0` and billing page `$0 / $50`. Indicates a settlement lag:
  real-time credit consumption outpaces billing cycle settlement. The current
  normalization (clamping to 0) loses this signal, causing `budget_active`
  detection to fail. Fix requires passing `rawRemaining` to `detectBillingPhase`.
  See `ARCHITECTURE.md` § "Negative remaining: detection gap and proposed fix".
- Is `overage_count` always in sync with `remaining` when budget consumption
  begins, or does it lag behind? **OPEN** — capture 2 shows `remaining = -473`
  with `overage_count = 0` and $0 billed, strongly suggesting lag. The magnitude
  of the lag (hours vs days vs billing cycle) is not yet known.
- What is the unit of `overage_entitlement`? Is it a raw credit integer
  (consistent with `overage_count`) or a dollar-equivalent or some other unit?
  Confirm from a live capture where `overage_count > 0`. If unit is unclear,
  store as-is and annotate with a TODO.
- Should the `mock` provider's default values be updated from
  `MOCK_USED=321 / MOCK_QUOTA=500` (premium request scale) to values
  representative of AI Credits (e.g. `MOCK_QUOTA=7000`)?
- **Multi-context (Horizon 2):** Is there a supported OAuth app flow for
  enterprise-managed users (EMUs), or are enterprise accounts limited to
  evidence capture in Horizon 2?
- **Multi-context (Horizon 2):** Should there be a maximum number of
  contexts per user (e.g. 5)?
- **Multi-context (Horizon 2):** When a user already has an active widget
  token and adds a second context, should the existing token automatically
  bind to the new default context, or remain context-agnostic until the
  user explicitly reconfigures the widget?
- **Multi-context (Horizon 2):** Should evidence-capture consent be stored
  per-user (one-time) or per-capture?
- **Horizon 3 FinOps:** Should contamination status remain a small fixed enum
  (`clean` / `overlapped` / `external_activity` / `unknown`) in the MVP, or
  should timing caveats become a separate structured field later?
- **Horizon 3 FinOps:** Should future GitHub usage-report reconciliation store
  decimal/money values separately from integer live counters rather than
  coercing them into a single number?
- **Horizon 3 FinOps:** Should manifest import remain manual-first until the
  output-only summary format proves stable across agents/models?

## Last updated

2026-06-18 by usage-history-ledger PR agent

## Usage history ledger (implemented)

`usage-history-store.ts` and `usage-history-types.ts` implement the provider-independent
usage snapshot ledger. Key facts:

- Blob store: `usage-history` (Tier 2/3).
- Key layout: `<userId>/<YYYY-MM-DD>/<ISO-timestamp>.json` (entry) and
  `<userId>/<YYYY-MM-DD>/_index.json` (daily counter, Tier 3).
- No provider dimension in key; history is provider-independent.
- Snapshot fields recorded: `capturedAt`, `used`, `quota`, `remaining`,
  `billingPhase`, `overageCount?`, `derivedOverageCredits?`.
  No `billingEntity`, no raw payloads, no credential data.
- `appendSnapshot(userId, snapshot, config)` — fire-and-forget (never rethrows).
- `getHistory(userId, options?)` — returns `UsageHistorySnapshot[]` sorted
  by `capturedAt` descending. Supports `fromDate`, `toDate`, `limit`.
- `calculateDelta(before, after)` — pure function returning `UsageHistoryDelta`.
- Default config: `enabled=false`, `retentionDays=90`, `maxPerDay=48`.
- Env vars: `USAGE_HISTORY_ENABLED`, `USAGE_HISTORY_RETENTION_DAYS`, `USAGE_HISTORY_MAX_PER_DAY`.
- 39 contract tests in `__tests__/usage-history-store.test.ts`.

## Usage history API endpoint (implemented)

`GET /api/history` in `netlify/functions/history.ts`. Facts:

- Auth: session cookie required (via `verifySession`); `401` when missing or invalid.
- User scoping: uses `session.id` (numeric GitHub user ID) as blob prefix.
- Query params: `limit` (integer ≥ 0), `from`/`to` (YYYY-MM-DD), `summary` (boolean).
- Response: `{ snapshots: UsageHistorySnapshot[], count: number, summary?: HistorySummary }`.
- Derived metrics via `computeHistorySummary` in `netlify/functions/lib/history-metrics.ts`
  (pure function, no I/O): `deltaUsed`, `creditsPerHour`, `creditsPerDay`, `averageBurnRate`.
- No raw provider payloads in snapshots; no `billingEntity`; no credential data.
- Cache-Control: `private, no-store`.
- Returns 405 for non-GET methods; 400 for bad params; 500 on unexpected store failure.
- Netlify redirect: `/api/history` → `/.netlify/functions/history` in `netlify.toml`.
- 17 contract tests in `__tests__/history-handler.test.ts`; 17 tests in `__tests__/history-metrics.test.ts`.
