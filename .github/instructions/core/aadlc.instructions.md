<!-- version: 1.4.0 -->
# AADLCv2 Cognition Governance Pack

Defines the AADLCv2 governance model that coordinates shaping, planning, execution, validation, and context reset.

-   **Delegated cognition is a governed resource.** Treat agent cognition as accountable project capacity, not ambient background activity.
-   **Separate work phases deliberately.** Keep shaping, planning, execution, validation, and context reset distinct to reduce hidden branching.
-   **Use the minimum sufficient reasoning depth.** Increase depth only when uncertainty, novelty, or risk warrants the additional cost.
-   **Preserve primary engineering goals.** Correctness, security, maintainability, and testability remain primary objectives across all phases.
-   **Reduce ambiguity before expensive or autonomous execution.** Clarify uncertain requirements before broad changes, high-impact tool use, or autonomous execution steps.
-   **Constrain execution with a PR contract.** Use `.github/aadlc/current-pr-contract.md` to define approved scope, constraints, and escalation triggers.
-   **Plan contract assertions before implementation.** For non-trivial work, identify contract-critical behaviors, choose 3-5 contract assertions, and map acceptance criteria to direct tests before execution begins.
-   **Reuse durable knowledge.** Use `.github/aadlc/memory.md` as a durable architectural truth cache to avoid repeated semantic rediscovery.
-   **Enforce tool-permission tiers.** Apply tiered tool governance via `.github/aadlc/tool-policy.yml` and `tool-permission-tiers.instructions.md`.
-   **Use prompt-as-code for substantial tasks.** Store long or boundary-sensitive task contracts in `.github/aadlc/plans/` so prompts are version-controlled, diffable, and line-addressable.
-   **Prefer committed plan files for substantial work.** Use committed plan files for long, nested, boundary-sensitive, or model-comparison tasks, preferably `.github/aadlc/plans/prN-short-description.md`.
-   **Read the plan before implementation.** For substantial work, the agent should read the plan file and respond in Plan-only mode before implementation.
-   **Archive temporary root plans before merge.** A temporary `PLAN.md` is acceptable on a feature branch, but it should be removed or archived before merge.
-   **Stop prompt ping-pong early.** If more than one corrective prompt is required to understand the PR contract, reset the session or switch models instead of continuing to patch a failing mental frame.
-   **Validate contract, implementation, and tests together.** During validation, compare the approved contract against the implementation and tests, reject tests that encode drift, and verify exact schema and failure semantics whenever the contract specifies them.

-   **Emit manifests only for governed runs.** When operating under an active AADLC PR contract — or when the user explicitly requests a run summary — emit a compact `AADLCRunManifest` JSON block in the final response. Do not require this for every trivial interaction.
-   **Keep manifests output-first and low-churn.** In Horizon 3 MVP, prefer final-response summaries that can be pasted/imported later. Do not require repo-committed run artefacts by default.
-   **Use checkpoint-backed language precisely.** Treat `observed` attribution as checkpoint-backed. Track overlapping or mixed activity as separate contamination status, not as a replacement confidence label.
-   **Do not invent attribution evidence.** If checkpoint IDs, timestamps, model choice, or PR references are unknown, omit them or mark them unknown. Never fabricate exact costs or exact model-level attribution.
-   **Keep manifest content sanitized.** Include path lists, command names, phase labels, validation summaries, explicit non-goals, and caveats. Do not include tokens, cookies, encryption keys, raw provider payloads, raw usage reports, file contents, or command output.

## Plan-as-Code: .plan.yml Execution Contracts

-   **Treat `.plan.yml` as an executable contract when present.** For governed work, do not treat `.plan.yml` files as passive reference docs.
-   **Discover plans before substantial work.** Before broad implementation, validation, or approval-gated actions, check whether a relevant `.plan.yml` contract exists.
-   **Prefer explicit plan references first.** If the user prompt, active PR contract, or task context names a `planId` or specific plan file, read that `.plan.yml` first.
-   **Otherwise scan committed plan contracts.** If no plan is explicitly named, inspect `.github/aadlc/plans/*.plan.yml` and determine whether an active contract applies.
-   **Filter plan discovery by status.** Treat `status: active` as execution-eligible by default and treat other statuses as non-executable unless the user explicitly says otherwise.
-   **Use the single active plan when exactly one applies.** If exactly one relevant active `.plan.yml` is found, it governs the run.
-   **Fall back conservatively when no active plan applies.** If no active `.plan.yml` applies, continue under the legacy PR contract and instruction-pack rules without inventing missing plan constraints.
-   **Treat `.plan.yml` as authoritative over legacy `.md` plans.** When both exist for the same work, use `.plan.yml` for execution boundaries and treat `.md` as supplementary narrative context.
-   **Do not execute draft plans without approval.** If `status: draft`, stop, summarize the intended work, and ask the user for explicit approval before execution.
-   **Execute active plans within declared scope.** If `status: active`, proceed only within the contract's stated permissions, scope, and gates.
-   **Treat closed or superseded plans as historical only.** If `status: closed` or `status: superseded`, do not execute under that plan unless the user explicitly says it is being used as historical context.
-   **Stop on unknown schema versions.** If `schemaVersion` is unknown or unsupported, stop and ask instead of guessing field meanings or widening scope.
-   **Stop on missing required fields.** If required contract fields are missing, stop and ask, and identify the missing fields clearly.
-   **Interpret allowed scope narrowly.** Treat `allowedFiles` as the editable scope for mutations; files outside that scope are not mutable unless the contract explicitly allows it.
-   **Let forbidden paths win.** If a path matches both `allowedFiles` and `forbiddenFiles`, treat it as forbidden with no exception.
-   **Let forbidden change types win.** If a change type is simultaneously allowed and forbidden, treat it as forbidden.
-   **Do not silently widen scope.** If the intended change exceeds declared scope, stop and ask before touching additional files, folders, or change types.
-   **Honor hard outside-scope bans.** If the plan indicates edits outside declared scope are not allowed, treat that as a hard stop rather than a hint.
-   **Treat multiple active plans as a conflict until reconciled conservatively.** Never pick the most permissive active plan by default.
-   **Intersect allowed scope when multiple active plans apply.** If multiple active plans plausibly govern the same run, use the intersection of allowed scopes where practical; if that is ambiguous or empty, stop and ask.
-   **Union forbidden scope when multiple active plans apply.** When multiple active plans apply, treat forbidden files and forbidden change types as the union of all prohibitions.
-   **Union approval gates when multiple active plans apply.** If multiple active plans apply, honor the combined set of approval-gated actions.
-   **Use the most restrictive tool permissions across active plans.** Resolve tool-permission conflicts conservatively rather than selecting the broader permission set.
-   **Stop before approval-gated actions.** Before any action listed in `approvalGates.requireUserApprovalBefore`, state the gate, describe the intended action, and wait for explicit user approval.
-   **Treat commit and PR creation as implicit gates.** Even if not listed in the schema, do not commit changes or create a PR without explicit user approval.
-   **Recommend explicit commit/PR gates in authored plans.** Schema authors should still include commit and PR creation gates explicitly even though the instruction pack treats them as implicit safeguards.
-   **Handle unknown approval-gate semantics conservatively.** If a gate name is present but its trigger is unclear, stop and ask instead of assuming it is satisfied.
-   **Keep docs-only validation proportional.** For docs-only or governance-only changes, do not run `npm test` or `npm run build` when dependencies are absent and the plan does not require them.
-   **Report required validation honestly.** In the final response, list validation checks required by the plan, whether each was run, and whether it passed, failed, or was skipped.
-   **Separate non-blocking known failures from regressions.** If the plan declares known non-blocking validation failures, report them as known caveats rather than new regressions.
-   **Emit an explicit compliance summary for governed runs.** Any run governed by an active `.plan.yml` must include a final section with the exact heading `## Plan Compliance Summary`.
-   **Include contract adherence details in the compliance summary.** The `## Plan Compliance Summary` section should state `planId`, `schemaVersion`, status used for execution, files changed, whether all changes stayed within allowed scope, whether forbidden files were touched, change types applied, approval gates triggered and resolved, validation run and results, known non-blocking failures, whether `nonGoals` were respected, and any scope widening.
-   **Keep plan compliance distinct from run telemetry.** The `## Plan Compliance Summary` is contractual scope-adherence reporting; `AADLCRunManifest` is observational execution telemetry.
-   **Emit both compliance and manifest blocks when both apply.** If a governed run also requires `AADLCRunManifest`, emit both instead of replacing one with the other.
