<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

Use this contract to distinguish active PR constraints, completed PR
constraints, durable invariants, and intentional amendments. Completed
PR constraints are historical evidence unless they are explicitly
promoted to durable invariants.

## Goal

Add fuel-gauge "burn-trail" charts to the PWA and the iOS Scriptable
widget, driven by the existing usage-history ledger, and then bring the
AADLC durable artefacts and documentation up to date with the change.

The chart layer:

1. A shared, pure normaliser (`netlify/functions/lib/chart-data.ts`) that
   turns `UsageHistorySnapshot[]` into a finite, clamped, reset-flagged
   `ChartPoint[]` series consumed by both surfaces.
2. PWA rendering via `src/chart-geometry.ts` (pure geometry) and
   `src/BurnTrailChart.tsx` (SVG component), wired into `src/main.tsx`.
3. Widget rendering via `createBurnTrailImage` in
   `public/scriptable/CopeLimitWidget.js`, using `widgetExtras.quotaCeiling`.

## Contract status

active

## Non-goals

- No changes to history storage, burn-rate/projection, comfort-status, or
  alert logic — the chart layer derives only from existing fields.
- No new npm dependencies (charts are hand-rolled SVG / Scriptable drawing).
- No changes to authentication, authorization, or secret handling.
- No raw provider payloads exposed to chart consumers.

## Carry-forward rules

All invariants in `invariants.yml` are durable and carry forward beyond
this PR. The newly added `chart-data-derived-only` invariant governs the
chart layer. The `negative-remaining-is-real-overage`,
`budget-active-negative-remaining`, and `github-token-never-exposed`
invariants remain in force unchanged.

## Approved scope

- `netlify/functions/lib/chart-data.ts` — shared chart normaliser.
- `src/chart-geometry.ts`, `src/BurnTrailChart.tsx`, `src/main.tsx` — PWA
  chart rendering and wiring.
- `public/scriptable/CopeLimitWidget.js` — widget mini-chart rendering.
- `ARCHITECTURE.md` — document the chart layer (library, frontend, widget).
- `README.md` — note the burn-trail chart feature.
- `.github/aadlc/memory.md` — add durable burn-trail chart facts; update
  "Last updated".
- `.github/aadlc/invariants.yml` — add `chart-data-derived-only`; repair the
  corrupted `budget-active-negative-remaining` / token invariant entry.
- `.github/aadlc/current-pr-contract.md` — this file.

## Intentional amendments

This PR repairs a malformed entry in `invariants.yml` where the
`budget-active-negative-remaining` invariant and the
"GitHub access token never exposed" invariant had been merged, leaving the
token invariant without an `id`. The token invariant is restored under the
explicit id `github-token-never-exposed`. No invariant rule text is weakened.

## Forbidden scope

- Any change to history storage keys, retention, or dedup semantics.
- Any change to burn-rate/projection, comfort-status, or alert thresholds.
- `package.json`, `package-lock.json`, `tsconfig.json`, `netlify.toml`,
  `vitest.config.ts`.
- Any new secret, credential, or token in source or documentation.

## Architectural constraints

- `chart-data.ts` must remain a pure function with no I/O.
- Chart output must never contain `NaN` or `Infinity`; negatives are
  dropped or clamped.
- PWA and widget reset detection must share the same `RESET_DROP_RATIO`
  semantics so the visual metaphor stays consistent across surfaces.
- `ARCHITECTURE.md` and `memory.md` changes must follow the existing
  section / cache structure; do not restructure or remove durable entries.

## Security constraints

No secrets, credentials, or tokens may appear in code or documentation
changes. The chart layer consumes only sanitized, derived usage-history
fields; no raw provider payloads are surfaced.

## Files expected to change

- `netlify/functions/lib/chart-data.ts`
- `src/chart-geometry.ts`
- `src/BurnTrailChart.tsx`
- `src/main.tsx`
- `public/scriptable/CopeLimitWidget.js`
- `ARCHITECTURE.md`
- `README.md`
- `.github/aadlc/memory.md`
- `.github/aadlc/invariants.yml`
- `.github/aadlc/current-pr-contract.md` (this file)

## Tests / validation

`npm test` (Vitest) and `npm run build` must pass. Chart normalisation has
unit coverage; documentation changes have no automated gate. Manual review
should confirm:

- Chart data is derived-only and never emits non-finite values.
- Reset detection is consistent between the PWA and widget.
- Documentation accurately describes the new chart layer.

## Stop conditions

- Any request to change history storage, projection, comfort-status, or
  alert logic under cover of "chart work".
- Any request to add npm dependencies for rendering.

## Escalation triggers

- If a chart requirement appears to need a new persisted field, record it as
  an open question and stop before widening the ledger schema.

## Context reset notes

On merge, reset `current-pr-contract.md` to the blank template. The
`chart-data-derived-only` invariant and the repaired
`github-token-never-exposed` invariant are promoted to durable
architectural truth.
