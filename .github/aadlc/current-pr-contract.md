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

Document the `BillingPhase` state model derived from newly observed
`copilot_internal/user` API fields (`overage_count`, `overage_entitlement`,
`overage_permitted`, `unlimited`, `has_quota`). Update durable artefacts to
capture the transition from included credits to budget-backed usage and
create a roadmap plan for the implementation follow-up. No application code
changes.

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
- No changes to `invariants.yml` beyond adding a single new invariant for
  overage guard.

## Carry-forward rules

All invariants in `invariants.yml` are durable and carry forward beyond
this PR. The `no-surprise-spend` invariant is particularly relevant: any
future implementation must gate additional/budget-backed display on
`overage_permitted === true`.

## Approved scope

- `ARCHITECTURE.md` — add a "Billing state model" section documenting the
  new API fields and `BillingPhase` design. Update TOC.
- `.github/aadlc/memory.md` — update field findings with the newly observed
  overage/budget fields; resolve the open question on additional usage;
  update "Last updated" date.
- `.github/aadlc/invariants.yml` — add one new invariant:
  `overage-permitted-gate`.
- `.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml` — new plan
  file for the implementation follow-up PR.
- `.github/aadlc/current-pr-contract.md` — this file.

## Intentional amendments

None. This PR does not amend any existing invariants, trust boundaries, or
architectural constraints. It adds one new invariant and introduces a new
type concept (`BillingPhase`) as a design artefact only.

## Forbidden scope

- `src/**` — no frontend code changes.
- `netlify/functions/**` — no backend or library code changes.
- `public/scriptable/**` — no iOS widget script changes.
- `package.json`, `package-lock.json`, `tsconfig.json`, `netlify.toml`
- Any runtime-affecting file.

## Architectural constraints

- `ARCHITECTURE.md` changes must use the existing section / heading style.
- New plan file must use schema `aadlc.plan.v0.2` (matching existing plans).
- `memory.md` changes must follow the existing cache structure; do not
  restructure sections or remove durable entries.

## Security constraints

No secrets, credentials, or tokens may appear in documentation changes.
The new fields documented (`overage_count`, etc.) are numeric/boolean
metadata only.

## Files expected to change

- `ARCHITECTURE.md`
- `.github/aadlc/memory.md`
- `.github/aadlc/invariants.yml`
- `.github/aadlc/plans/horizon-1-pr2-billing-phase.plan.yml` (new file)
- `.github/aadlc/current-pr-contract.md` (this file)

## Tests / validation

Documentation-only PR. No automated test gates apply. Manual review should
confirm:

- All `BillingPhase` states are clearly defined with detection conditions.
- The `memory.md` open question on additional usage is closed with the
  observed evidence.
- The new plan file schema is valid per `plan-schema-v0.2.yml`.

## Stop conditions

- Any request to modify application code (`src/`, `netlify/functions/`,
  `public/scriptable/`).
- Any request to add npm dependencies.

## Escalation triggers

- If additional undocumented fields are observed beyond those listed in the
  problem statement — record them but do not widen the plan scope without
  user confirmation.

## Context reset notes

On merge, reset `current-pr-contract.md` to the blank template. The
`BillingPhase` state model is promoted to durable architectural truth in
`ARCHITECTURE.md` and `memory.md`. The new plan file
`horizon-1-pr2-billing-phase.plan.yml` governs the follow-up
implementation PR.
