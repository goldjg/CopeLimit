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

Document findings from a new Copilot quota capture where `remaining = -473`
(raw API value), `entitlement = 7000`, normalized remaining = 0, and the
GitHub billing page shows `$0 / $50` budget consumed. Investigate and record:

1. Whether negative `remaining` should be preserved before normalization.
2. Whether `effectiveUsed` can exceed quota.
3. Whether overage consumption can be derived from raw `remaining`.
4. Whether `budget_active` can be detected when `overage_count = 0` but
   `remaining < 0`.

Update roadmap and durable artefacts only. No application code changes.

## Contract status

active

## Non-goals

- No changes to TypeScript application code in `src/`, `netlify/functions/`,
  or `public/scriptable/`.
- No new npm dependencies.
- No changes to `tsconfig.json`, `package.json`, `netlify.toml`, or
  `vitest.config.ts`.
- No new tests (documentation-only PR; tests are scoped to the follow-up
  implementation plan).

## Carry-forward rules

All invariants in `invariants.yml` are durable and carry forward beyond
this PR. The `no-surprise-spend` and `overage-permitted-gate` invariants
are particularly relevant. The BillingPhase detection priority established
in `ARCHITECTURE.md` is amended by this PR to account for `rawRemaining < 0`.

## Approved scope

- `ARCHITECTURE.md` — update "Current observed state" with the new capture;
  add a "Negative remaining: detection gap and proposed fix" subsection;
  amend detection priority 3 to include `rawRemaining < 0`; add a
  "Additional telemetry" subsection.
- `.github/aadlc/memory.md` — update field findings with new observed state;
  update BillingPhase detection priority; add new open questions; update
  "Last updated".
- `.github/aadlc/invariants.yml` — add two new invariants:
  `negative-remaining-is-real-overage` and `budget-active-negative-remaining`.
- `.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml` — amend
  detection priority 3 comment; add `rawRemaining` parameter to
  `detectBillingPhase`; add contract assertions for negative-remaining case.
- `.github/aadlc/current-pr-contract.md` — this file.

## Intentional amendments

This PR amends the `BillingPhase` detection priority established in the
previous billing-phase documentation PR. Specifically, detection priority 3
(`budget_active`) is extended to also fire when `rawRemaining < 0 &&
overage_permitted === true`, in addition to the existing `overage_count > 0`
condition. This amendment is justified by the newly observed state where
`remaining = -473` indicates active overage consumption even when
`overage_count = 0` (settlement lag).

## Forbidden scope

- `src/**` — no frontend code changes.
- `netlify/functions/**` — no backend or library code changes.
- `public/scriptable/**` — no iOS widget script changes.
- `package.json`, `package-lock.json`, `tsconfig.json`, `netlify.toml`
- Any runtime-affecting file.

## Architectural constraints

- `ARCHITECTURE.md` changes must use the existing section / heading style.
- Plan file changes must stay within the existing `aadlc.plan.v0.2` schema.
- `memory.md` changes must follow the existing cache structure; do not
  restructure sections or remove durable entries.

## Security constraints

No secrets, credentials, or tokens may appear in documentation changes.
The observed fields (`remaining`, `entitlement`) are numeric metadata only.

## Files expected to change

- `ARCHITECTURE.md`
- `.github/aadlc/memory.md`
- `.github/aadlc/invariants.yml`
- `.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml`
- `.github/aadlc/current-pr-contract.md` (this file)

## Tests / validation

Documentation-only PR. No automated test gates apply. Manual review should
confirm:

- The negative-remaining detection gap is clearly documented with example
  values.
- The amended detection priority 3 is consistent across ARCHITECTURE.md,
  memory.md, and the plan file.
- New invariants are precise and actionable.

## Stop conditions

- Any request to modify application code (`src/`, `netlify/functions/`,
  `public/scriptable/`).
- Any request to add npm dependencies.

## Escalation triggers

- If additional undocumented fields are observed beyond those implied by
  the problem statement — record them but do not widen the plan scope
  without user confirmation.

## Context reset notes

On merge, reset `current-pr-contract.md` to the blank template. The amended
`BillingPhase` detection priority and the two new invariants are promoted to
durable architectural truth. The updated `horizon-1-pr2-billing-phase.plan.yml`
governs the follow-up implementation PR including the rawRemaining parameter.
