<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Implement the fuel-tank visual fix and behavior update:
- **Bugfix (widget-only):** ensure the fuel tank renders on the large Scriptable widget.
- **Behavior change (widget + PWA):** render the tank as a real gauge where top is
  capacity (quota or budget, depending on billing phase), bottom is `0`, and the
  current value trends downward toward `0`.
- Distinguish quota vs budget tank mode visually when API billing fields provide
  enough context.

## Contract status

active

## Non-goals

- Changing usage normalisation or API response shape
- Changing widget refresh cadence behaviour
- Changing onboarding, token storage, or settings persistence
- Adding dependencies, storage, or new backend endpoints

## Carry-forward rules

- Billing-phase and overage fields from normalized usage remain the source of
  truth for selecting quota-vs-budget tank mode.
- Missing or incomplete budget fields must degrade safely to quota-mode
  rendering (non-fatal).
- Tank rendering remains presentational-only and must not change fetch/auth/
  token logic.

## Approved scope

1. `public/scriptable/CopeLimitWidget.js`
   - fix large-widget tank rendering bug
   - implement real-gauge semantics (top=capacity, bottom=0, downward toward 0)
   - apply visual distinction for quota vs budget mode
2. `src/BurnTrailChart.tsx`
   - apply matching gauge semantics for PWA chart rendering
   - apply quota-vs-budget visual distinction
3. `src/chart-geometry.ts`
   - add minimal geometry support needed for downward-to-zero gauge projection semantics
4. `src/main.tsx`
   - pass required billing context into PWA chart mode selection
5. `src/__tests__/chart-geometry.test.ts`
   - add/update focused assertions for new gauge semantics
6. `.github/carl/current-pr-contract.md`
   - update this contract for the expanded split scope

## Intentional amendments

- Supersedes the previously active "Last Updated label" presentation contract.
- Scope is expanded to include both widget and PWA tank behavior alignment,
  while keeping the rendering bugfix itself widget-only.

## Forbidden scope

- Modifying usage normalisation (`copilot.ts`, `normaliseUsage`)
- Modifying `widget-usage.ts` response semantics
- Modifying onboarding, token storage, or widget settings persistence
- Modifying backend auth/session/blob-store behavior
- Adding dependencies or backend storage

## Architectural constraints

- Gauge capacity must use **quota** in credit phases and **budget entitlement**
  in budget phases when available.
- Gauge value must represent remaining capacity toward zero (downward
  trajectory), not consumed-upward-only rendering.
- Quota vs budget mode must be visually distinguishable by fill/gradient/shading.
- Changes remain presentation-only; no API shape, auth, or storage changes.
- Missing budget metadata must safely fall back to quota mode.

## Security constraints

- No token, credential, or provider payload handling may change.
- No new external I/O introduced for rendering.
- Trust-boundary handling and normalized usage fields remain unchanged.

## Files expected to change

- `public/scriptable/CopeLimitWidget.js` ✅
- `src/BurnTrailChart.tsx` ✅
- `src/chart-geometry.ts` ✅
- `src/main.tsx` ✅
- `src/__tests__/chart-geometry.test.ts` ✅
- `.github/carl/current-pr-contract.md` ✅ (this file)

## Tests / validation

- `npm test`
- `npm run build`
- `npm run lint` — expected pre-existing TS5107 (non-blocking baseline)

Acceptance checks:
- Large widget fuel tank renders when trend data is present
- Widget gauge uses top=quota or top=budget based on billing phase context
- Widget gauge reads downward toward 0 remaining capacity
- PWA chart follows the same downward-to-zero gauge semantics
- Quota vs budget modes are visually distinguishable
- Missing budget fields safely fall back to quota mode rendering

## Stop conditions

- Any change that would alter usage normalisation or billing-phase derivation
- Any change that requires backend API shape changes
- Any change that affects token/credential handling
- Any scope expansion outside listed widget/PWA rendering files

## Escalation triggers

- If budget-mode semantics require backend historical fields not currently exposed
  for accurate rendering.
- If large widget layout cannot maintain readability with mode-distinguishing
  visuals.
- If PWA projection semantics conflict with the downward-to-zero gauge behavior.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Promote any durable cross-surface gauge-mode conventions to memory/docs only
  if they are stable and intentional.
- Do not delete this file until a new contract is created.
