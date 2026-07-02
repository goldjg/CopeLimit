<!-- version: 1.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Implement missing iOS PWA notification capability for CopeLimit:
- ensure the installed iOS Home Screen PWA is recognised as notification-capable where iOS supports Web Push;
- keep manifest, service worker, and standalone app configuration aligned with iOS PWA requirements;
- improve client-side capability detection and guidance so iOS Safari tab contexts do not present a broken subscribe flow;
- preserve existing server-side subscription storage, test-push behavior, and alert preference behavior unless client compatibility requires a narrow adjustment.

## Contract status

active

## Non-goals

- Changing usage normalization (`copilot.ts`, `normaliseUsage`) semantics
- Changing auth/session cookie primitives
- Changing server-side alert-decision, scheduling, or background cron behavior
- Changing VAPID keys or exposing secret material
- Broad UI redesign outside the notification capability/settings area
- Introducing new dependencies

## Approved scope

1. PWA shell and manifest surfaces required for iOS Web Push compatibility:
   - `public/manifest.webmanifest`
   - `index.html`
   - `public/sw.js`
   - related static icon references already in the repository
2. Notification client capability detection and subscribe UX:
   - `src/push-notifications.ts`
   - `src/PushNotificationSection.tsx`
   - `src/styles.css`
   - `src/main.tsx` only if a narrow notification-capability integration is required
3. Tests and docs required to support the above:
   - `src/__tests__/push-notifications.test.ts`
   - `README.md`
4. `.github/carl/current-pr-contract.md` (this file).

## Forbidden scope

- Any weakening of auth/session verification
- Any storage of secrets/tokens in client-visible payloads
- Any server-side subscription storage redesign unless required for narrow iOS compatibility
- Any broad unrelated refactors
- Any dependency/tooling changes unrelated to iOS PWA notification capability

## Architectural constraints

- Existing `push-subscriptions` records remain user-scoped by `userId`.
- Notification permission must remain behind an explicit user action.
- iOS Safari tab contexts must not be represented as notification-capable when Home Screen installation / standalone mode is required.
- Capability diagnostics must not expose VAPID private keys or subscription secrets.
- Service worker changes must preserve existing push delivery and offline navigation behavior.

## Security constraints

- No secret exposure in push payloads, diagnostics, or logs.
- No cross-user subscription access or send fan-out.
- No new privileged trust boundary expansion.
- Development-only diagnostics in the service worker must be safe and must not leak subscription payload contents or secrets.

## Files expected to change

- `public/manifest.webmanifest`
- `index.html`
- `public/sw.js`
- `src/push-notifications.ts`
- `src/PushNotificationSection.tsx`
- `src/styles.css`
- `src/__tests__/push-notifications.test.ts`
- `README.md`
- `.github/carl/current-pr-contract.md`

## Tests / validation

- `npm test`
- `npm run build`
- `npm run lint` — expected pre-existing TS5107 (non-blocking baseline)

Acceptance checks:
- iOS non-standalone contexts show install guidance instead of a broken subscribe flow.
- Standalone/capable contexts can reach the explicit subscribe action.
- Capability diagnostics explain unsupported states without exposing secrets.
- Service worker still handles `push` and `notificationclick` correctly.
- Existing subscription and test-notification behavior remains intact.

## Stop conditions

- Any requirement to change session/auth primitives
- Any requirement to change server-side scheduling / background delivery architecture
- Any need to persist or expose sensitive credentials in new structures
- Any requirement to broaden scope beyond client/PWA compatibility and documentation

## Escalation triggers

- If iOS compatibility appears to require server-side subscription schema changes.
- If Safari/Home Screen behavior differs in a way that would require separate user-visible flows beyond narrow iOS guidance and diagnostics.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Promote any stable iOS PWA notification capability assumptions to durable docs/memory.
