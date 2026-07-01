<!-- version: 1.2.0 -->
# Current PR Contract

This contract constrains implementation scope for the active PR. Update
it when scope is explicitly amended. If a requested action falls outside
approved scope, stop and escalate before proceeding.

## Goal

Implement user-configurable live browser push alerts:
- make alert delivery run **per authenticated user** against that user's subscriptions;
- add per-user push notification preferences in the PWA with sensible defaults;
- trigger alerts on meaningful state changes (comfort/status transitions) and
  burn-rate change thresholds;
- preserve existing test-push and subscription behavior.

## Contract status

active

## Non-goals

- Changing usage normalization (`copilot.ts`, `normaliseUsage`) semantics
- Changing auth/session cookie primitives
- Changing widget token or onboarding flows
- Introducing new dependencies
- Introducing external cron/scheduler infrastructure

## Approved scope

1. Push notification backend flow (Netlify Functions + lib):
   - add per-user preference persistence for push alerts;
   - add live per-user send logic in `/api/usage` (non-blocking, fail-safe);
   - keep sends bounded to the authenticated user's own subscriptions.
2. PWA notification settings UI:
   - expose preference controls for status-change alerts and burn-rate-change thresholds;
   - apply sensible defaults and persist via API.
3. Routing/docs/tests updates required to support the above.
4. `.github/carl/current-pr-contract.md` (this file).

## Forbidden scope

- Any weakening of auth/session verification
- Any storage of secrets/tokens in client-visible payloads
- Any broad unrelated refactors
- Any dependency/tooling changes unrelated to push preference/live-alert behavior

## Architectural constraints

- Existing `push-subscriptions` records remain user-scoped by `userId`.
- Live send logic must be non-blocking for `/api/usage` responses.
- Preference persistence must be per-user and default-safe.
- Alert triggers must build from existing `comfortStatus`, `alertDecision`, and burn-rate projection signals (no duplicate business logic forks).

## Security constraints

- No secret exposure in push payloads or logs.
- No cross-user subscription access or send fan-out.
- No new privileged trust boundary expansion.

## Files expected to change

- `netlify/functions/usage.ts`
- `netlify/functions/push-subscribe.ts` (if response shape is extended)
- `netlify/functions/push-preferences.ts` (new)
- `netlify/functions/lib/push-subscription-store.ts` and/or new push preference/state helper(s)
- `netlify/functions/lib/push-subscription-types.ts` (if needed)
- `src/PushNotificationSection.tsx`
- `src/styles.css`
- `netlify.toml`
- `README.md`
- tests under `netlify/functions/lib/__tests__/` and/or `src/__tests__/`
- `.github/carl/current-pr-contract.md`

## Tests / validation

- `npm test`
- `npm run build`
- `npm run lint` — expected pre-existing TS5107 (non-blocking baseline)

Acceptance checks:
- Preferences are saved and loaded per authenticated user.
- Status-change alerts can be enabled/disabled and follow configured behavior.
- Burn-rate change alerts trigger when configured threshold is exceeded.
- Live send path uses only the current authenticated user's subscriptions.
- `/api/usage` remains successful even if push send/storage operations fail.

## Stop conditions

- Any requirement to change session/auth primitives
- Any requirement for global background scheduling outside current app pattern
- Any need to persist or expose sensitive credentials in new structures

## Escalation triggers

- If "live" is interpreted as mandatory out-of-band background delivery while user is offline.
- If preference model needs multi-device/per-subscription overrides beyond per-user scope.

## Context reset notes

When this PR is merged:
- Close this contract (set status: closed).
- Promote stable push-alert preference and live-delivery assumptions to durable docs/memory.
