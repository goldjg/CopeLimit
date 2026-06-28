<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Add a small `Last Updated:` label to each Scriptable widget size so the
widget shows the date and time of the most recent usage update without
changing usage, chart, or billing behaviour.

## Contract status

active

## Non-goals

- Changing usage normalisation or API response shape
- Changing widget refresh cadence behaviour
- Changing burn-trail chart rendering
- Changing PWA onboarding or settings UI
- Adding dependencies, storage, or new backend endpoints

## Carry-forward rules

- The widget's `updatedAt` field remains the source for the displayed
  last-updated timestamp.
- The `Last Updated:` label must remain non-fatal: missing or invalid
  timestamps must not break widget rendering.

## Approved scope

1. `public/scriptable/CopeLimitWidget.js` — Add a small `Last Updated:`
   label to the small, medium, and large widget layouts using the existing
   `updatedAt` field.
2. `.github/carl/current-pr-contract.md` — Amend the active contract to
   reflect this scoped widget presentation change.

## Intentional amendments

- Supersedes the previously active widget refresh-cadence contract for this
  task. The active implementation scope is now limited to widget
  presentation only.

## Forbidden scope

- Modifying usage normalisation (`copilot.ts`, `normaliseUsage`)
- Modifying `widget-usage.ts` response semantics
- Modifying chart rendering (`chart-data.ts`, `BurnTrailChart.tsx`, `chart-geometry.ts`)
- Modifying onboarding, token storage, or widget settings persistence
- Adding dependencies or backend storage

## Architectural constraints

- The label must derive from the existing `usage.updatedAt` field already
  returned to the widget.
- The new formatting/rendering helpers in `CopeLimitWidget.js` must remain
  presentation-only and must not change widget fetch logic or chart logic.
- Missing or invalid timestamps must degrade gracefully without throwing.

## Security constraints

- No token, credential, or provider payload handling may change.
- The displayed timestamp must come only from the existing normalized usage
  object and must not trigger additional I/O.

## Files expected to change

- `public/scriptable/CopeLimitWidget.js` ✅
- `.github/carl/current-pr-contract.md` ✅ (this file)

## Tests / validation

- `npm test` — run if dependencies are available; currently blocked in this
  environment until project dependencies are installed
- `npm run build` — run if dependencies are available; currently blocked in
  this environment until project dependencies are installed
- `npm run lint` — expected to fail on pre-existing TS5107; not a blocking gate

Acceptance checks:
- Small widget shows a small `Last Updated:` label with date and time
- Medium widget shows a small `Last Updated:` label with date and time
- Large widget shows a small `Last Updated:` label with date and time
- Missing or invalid `updatedAt` does not break widget rendering

## Stop conditions

- Any change that would alter usage normalisation, billing state, or chart rendering
- Any change that would require backend API shape changes for this presentation tweak
- Any change that would affect token or credential handling

## Escalation triggers

- If the small or medium widget cannot fit the label without materially
  degrading readability, escalate before redesigning the layout.
- If Scriptable date formatting support behaves inconsistently enough to
  require broader compatibility workarounds, escalate before widening scope.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Do not promote this presentation tweak to durable memory unless a stable
  cross-widget formatting convention emerges.
- Do not delete this file until a new contract is created.
