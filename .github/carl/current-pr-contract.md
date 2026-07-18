<!-- version: 1.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Add clear date/time context to the CopeLimit PWA and Scriptable widget burn-trail/fuel-tank charts so users can understand when usage happened, where reset boundaries occur, and when projected exhaustion is expected.

## Contract status

active

## Non-goals

- Changing burn-rate projection logic
- Changing widget status colour logic
- Changing comfort-status logic
- Introducing new dependencies
- Broad visual redesign outside the chart/date-context surfaces
- Changing auth/session cookie primitives

## Approved scope

1. PWA chart/date-context improvements:
   - `src/BurnTrailChart.tsx`
   - `src/chart-geometry.ts`
   - related chart/date formatting utilities in `src/`
2. Scriptable/iOS widget chart/date-context improvements:
   - `public/scriptable/CopeLimitWidget.js`
3. Shared chart/date formatting support and tests:
   - `netlify/functions/lib/chart-data.ts` only if a narrow shared helper is required for chart semantics
   - `src/__tests__/**/*.test.ts` or existing chart-related test files
   - `public/scriptable/CopeLimitWidget.js` test coverage only if the repository already has a suitable pattern
4. `.github/carl/current-pr-contract.md` (this file).

## Forbidden scope

- Any server-side history/storage redesign beyond narrow chart-data semantics
- Any broad unrelated refactors
- Any dependency/tooling changes unrelated to chart/date-context work
- Any weakening of chart safety guarantees such as NaN/Infinity output

## Architectural constraints

- Preserve the existing lightweight SVG/PWA rendering approach.
- Preserve the existing widget rendering approach and keep the large widget glanceable.
- Visible labels must remain concise and human-readable; no raw ISO timestamps in UI.
- Chart output must not produce `NaN` or `Infinity` geometry values.
- Existing month/quarter/year summary behavior must remain intact where previously shown.

## Security constraints

- No secret exposure in tooltip or label content.
- No new trusted data sources or credential handling paths.

## Files expected to change

- `src/BurnTrailChart.tsx`
- `src/chart-geometry.ts`
- `public/scriptable/CopeLimitWidget.js`
- relevant tests under `src/__tests__` or adjacent chart tests
- `.github/carl/current-pr-contract.md`

## Tests / validation

- `npm test`
- `npm run build`
- `npm run lint` — expected pre-existing TS5107 (non-blocking baseline)

Acceptance checks:
- PWA fuel tank chart shows concise start/end and reset/projection date context without raw ISO timestamps.
- Large Scriptable widget shows at least chart start/latest-update/reset/projection context when space allows.
- Dates remain readable and do not introduce chart clutter or invalid geometry.
- Existing chart semantics and summary behavior remain intact.

## Stop conditions

- Any requirement to change burn-rate projection logic or billing semantics
- Any requirement to change widget status colour logic or comfort-status logic
- Any requirement to add heavy charting dependencies or broad visual redesign
- Any requirement to broaden scope beyond PWA/widget chart date-context work

## Escalation triggers

- If the charting layer would need a major structural rewrite to support the requested labels.
- If date formatting requirements would require changing the existing lightweight SVG/widget rendering approach in a significant way.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Promote any stable chart/date-context behaviour to durable docs/memory.
