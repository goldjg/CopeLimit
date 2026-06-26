<!-- version: 1.1.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Allow users to configure a desired widget refresh cadence from the PWA
settings area, persist it via the existing widget-tokens blob store, expose
it in the widget-usage API response, and have the Scriptable iOS widget
consume it to set `widget.refreshAfterDate`. Present as a hint, not a
guaranteed interval.

## Contract status

active

## Non-goals

- WebPush / VAPID / notification sending / alert delivery / alert scheduling
- Changing usage / projection / comfort / alert logic
- Changing chart rendering
- Arbitrary user-provided minute values (only the five recognized cadences plus null/manual)
- Adding a new database, blob store, or large dependency

## Carry-forward rules

- `desiredRefreshMinutes` in the widget-usage response is always present
  (never omitted); it is `null` when no preference is set. Future PRs
  must preserve this field in the response shape.
- The `settings/<userId>` blob key pattern is durable for the `widget-tokens`
  store. Do not change it without migrating existing records.

## Approved scope

1. `netlify/functions/lib/widget-store.ts` — Add `VALID_REFRESH_CADENCES`,
   `WidgetRefreshCadence`, `WidgetUserSettings` types; `settingsKey()` helper;
   `parseWidgetRefreshCadence()`, `getWidgetUserSettings()`,
   `setWidgetUserSettings()` exports.
2. `netlify/functions/widget-settings.ts` — New `GET/PATCH /api/widget-settings`
   function (session-cookie auth, same pattern as widget-token.ts).
3. `netlify/functions/widget-usage.ts` — Add `desiredRefreshMinutes` field to
   response body; import and call `getWidgetUserSettings`.
4. `public/scriptable/CopeLimitWidget.js` — Add `widget.refreshAfterDate` logic
   after widget is built, before `Script.setWidget`.
5. `src/WidgetTokenSection.tsx` — Add refresh cadence UI section, state vars,
   and load/save effects.
6. `src/styles.css` — Add `.widgetRefreshSettings` and related CSS classes.
7. `netlify.toml` — Add `/api/widget-settings` redirect.
8. `netlify/functions/lib/__tests__/widget-settings-store.test.ts` — Tests for
   `parseWidgetRefreshCadence`.
9. `ARCHITECTURE.md` — Update widget-tokens blob store layout table.
10. `.github/carl/memory.md` — Add stable facts from this PR.
11. `.github/carl/current-pr-contract.md` — This file (retroactive contract).

## Intentional amendments

None. This PR adds new capabilities without altering existing behaviour.

## Forbidden scope

- Modifying usage normalisation (`copilot.ts`, `normaliseUsage`)
- Modifying chart rendering (`chart-data.ts`, `BurnTrailChart.tsx`, `chart-geometry.ts`)
- Modifying alert or comfort logic
- Adding non-null assertion bypass or weakening type safety
- Changing the Tier 1 encryption mechanism for blob records
- Exposing `githubAccessToken` to any client-visible response
- Storing raw user-provided cadence strings without validation

## Architectural constraints

- Widget user settings must use the existing `widget-tokens` blob store and the
  `readStoredRecord` / `writeStoredRecord` encrypted helpers — no new store.
- `parseWidgetRefreshCadence` must be a pure function with no side effects.
- The `desiredRefreshMinutes` field in the widget-usage response must always be
  present (either a recognized value or null). It must never throw.
- The Scriptable widget's refresh date logic must be wrapped in try/catch and
  must not affect widget rendering or crash on any input.

## Security constraints

- `GET/PATCH /api/widget-settings` requires a valid session cookie (same
  `requireSession()` pattern as `widget-token.ts`).
- `parseWidgetRefreshCadence` must reject all values outside the recognized
  set — no arbitrary user-provided integers may be stored or returned.
- Widget user settings records are stored encrypted (Tier 1, AES-256-GCM via
  `BLOB_ENCRYPTION_KEY`) — same as all other `widget-tokens` records.
- `githubAccessToken` must not appear in the widget-settings response at any time.

## Files expected to change

- `netlify/functions/lib/widget-store.ts` ✅
- `netlify/functions/widget-settings.ts` ✅ (new)
- `netlify/functions/widget-usage.ts` ✅
- `public/scriptable/CopeLimitWidget.js` ✅
- `src/WidgetTokenSection.tsx` ✅
- `src/styles.css` ✅
- `netlify.toml` ✅
- `netlify/functions/lib/__tests__/widget-settings-store.test.ts` ✅ (new)
- `ARCHITECTURE.md` ✅
- `.github/carl/memory.md` ✅
- `.github/carl/current-pr-contract.md` ✅ (this file)

## Tests / validation

- `npm test` — all tests must pass (596 tests as of this PR)
- `npm run build` — TypeScript compilation + Vite bundle must pass
- `npm run lint` — expected to fail on pre-existing TS5107; not a blocking gate

Acceptance checks:
- `parseWidgetRefreshCadence(null)` → null
- `parseWidgetRefreshCadence('manual')` → null
- `parseWidgetRefreshCadence(30)` → 30
- `parseWidgetRefreshCadence('garbage')` → null (no throw)
- `parseWidgetRefreshCadence([30])` → null (non-primitive rejected)
- Widget-usage response always includes `desiredRefreshMinutes`

## Stop conditions

- Any change that would alter usage normalisation, billing state, or chart rendering
- Any change that would expose `githubAccessToken` to a client response
- Any change that would store an unvalidated cadence value

## Escalation triggers

- If the existing `readStoredRecord` / `writeStoredRecord` pattern does not
  support `WidgetUserSettings` cleanly, escalate rather than introducing a new
  encryption path.
- If `widget.refreshAfterDate` is absent from the Scriptable API and the try/catch
  pattern is insufficient, escalate before attempting workarounds.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Promote carry-forward rules to durable invariants in `invariants.yml` if
  the response shape must be preserved by future PRs.
- Do not delete this file until a new contract is created.
