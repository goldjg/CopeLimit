<!-- version: 1.2.0 -->
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
- Storage: Netlify Blobs, AES-256-GCM encrypted at rest via
  `BLOB_ENCRYPTION_KEY`.
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
- All Netlify Blob records must remain AES-256-GCM encrypted via
  `BLOB_ENCRYPTION_KEY`. Records must not be written unencrypted.
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
- **Pay-as-you-go:** Additional / pay-as-you-go usage may be disabled
  and should not be assumed enabled. CopeLimit should not surface
  assumed additional usage without data support.
- **Onboarding session verification** uses `GET /api/onboarding/status`
  for a specific onboarding session ID, not generic widget-token active
  status.

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
- Are the numeric values in `premium_interactions.entitlement` and
  `remaining` now expressed in AI Credit units (e.g. integers up to
  ~7,000) rather than premium request units (e.g. integers up to ~500)?
- Is additional/pay-as-you-go usage data exposed anywhere in the
  `copilot_internal/user` response under the new billing model? If so,
  what is the field path and how should CopeLimit present it?
- Should the `mock` provider's default values be updated from
  `MOCK_USED=321 / MOCK_QUOTA=500` (premium request scale) to values
  representative of AI Credits (e.g. `MOCK_QUOTA=7000`)?

## Last updated

2026-06-01 by ai-credits-billing-mode-detection PR agent
