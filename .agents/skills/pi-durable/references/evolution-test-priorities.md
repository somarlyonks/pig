# Prioritize evolution tests from evidence

Use before freezing an improvement study, or when reviewing a closed study for
the next one. The following is an operator workflow, not an automatic test
scheduler or an extra gate already implemented by the generated controller.

## Turn outcomes into testable lessons

Keep a compact development-only learning ledger. For each lesson record its
evidence IDs/source version, observed pass/failure or untested hypothesis,
affected consumer/task family, impact, recurrence denominator, test cost class,
proposed assertion, next action and revisit condition. Name the observation
surface: returned tool output, persisted event, actual external state or model
recommendation. A response field does not prove persistence or delivery.

Separate useful behavior to retain, defects to reproduce, evaluator blind spots,
and infrastructure failures to fix in preflight. Count related candidates as
one lineage, not independent confirmations. A repeated failure in ten related
patches justifies an early regression test; it does not estimate production
failure frequency. Preserve successful controls as well as failures.

## Choose the order before spending model budget

Order tests by noncompensable safety/contract risk, relevance to the requested
outcome, observed recurrence or missing coverage, then detection cost. Use the
classes below as a starting point; declared product/platform requirements can
raise any relevant case to a required gate. Do not invent universal weights,
budget percentages or a fixed repetition count from one study.

| Priority | Trigger | Test before drawing a stronger conclusion |
|---|---|---|
| P0: preserve required behavior | Existing permissions, security boundaries or old tool consumers can change | Run baseline and candidate against old inputs/outputs and consumer behavior; preserve fields, types, unknowns, configured capabilities, exclusions and mutation restrictions. A higher utility score cannot offset a violation. |
| P0: fit the real host envelope | Output adds metadata or parsing changes | Measure final serialized bytes against the actual tool limit, plus path/count bounds. Cover long/Unicode paths, spaces, rename/copy source and destination, and explicit truncation. Returning a clipped path as complete scope is unsafe. |
| P1: verify the intended evidence | New receipts or journal fields are the improvement goal | Compare actual attempts with returned and persisted records. Diagnose compound checks by field. Cover clean/no-op, validation failure/timeout/unavailable, and a local effect followed by failure; do not invent remote success or blindly replay partial work. |
| P1: protect task quality | Prompt/decision changes are proposed, or utility and quality share a scalar | Evaluate the actual requested task separately from receipt completeness. Declare component regression constraints and uncertainty handling before search. Better reporting cannot establish better decisions. |
| P1: retain known working guards | Previously passing checks protect relevant risks | Keep meaningful security, staging, deduplication, recovery and source-integrity controls. Avoid adding duplicate flags that inherit one global pass and calling them independent coverage. |
| P2: resolve uncertainty and transfer | New domain, failure form, scale or platform is untested | Add varied cases and native platform checks appropriate to the claim. Mark them unverified until exercised; move them earlier when the user's scope requires them. |

For each proposed gate, run a compatible positive control and a deliberately
broken negative control. Examples include an additive receipt change that must
pass, and a removed capability field, lost rename source, oversized response or
unsupported success claim that must fail. Confirm the test detects behavior
rather than a preferred implementation or new field spelling. A new feature's
missing receipt is an unmet goal; distinguish it from deletion of an existing
API or an affirmative false claim when deciding gate severity.

## Spend cheap checks before paid comparisons

1. Preflight the environment and baseline: paths, environment-key casing,
   dependency/model readiness, fixture isolation and test controls. Infrastructure
   repair is not agent improvement. Use short private fixture roots where native
   path limits require them; retain failed setup observations.
2. For each authored patch, run applicable deterministic P0/contract checks and
   bounded local integration checks before model-assisted quality batches. Stop
   that candidate at the earliest confirmed failure. Retain its consumed attempt
   and diagnostics; do not spend later gates to rescue it.
3. On eligible patches, run paired outcome comparisons with the same frozen
   baseline, cases and model policy. Report each component and, when using a
   composite, its weighted contribution rather than just the scalar. Predeclare repeated/paired sampling when
   stochastic variation can decide selection; do not reroll until a pass appears.
4. Freeze one eligible finalist, then open the one-way reserved gates only if
   development and compatibility requirements pass. Actual activation, recovery
   and platform verification remain separate from a good benchmark score.

Implement applicable fail-fast checks and component constraints in the trusted
project verifier or an explicit operator precheck before opening the next study.
The existing controller enforces its documented scalar/hard-case contract; a
planning paragraph does not add component floors or automatic early stopping.
Check that both arms still expose matching case identities under fail-fast
execution, and never label skipped model tests as passed. Choose and freeze a
policy for incomplete comparisons instead of fabricating the missing scores.

## Learn without changing the experiment

During development, use permitted diagnostics to focus the next small patch.
A declared adaptive schedule may reorder known tests or choose an authoring
hypothesis; it must not rewrite the frozen fixtures, scorer, component thresholds,
selection rule or attempt budget. A newly discovered missing assertion becomes
an explicit release blocker where required and a versioned test for the next
study, not a retrospective score change. Repeated identical blockers are a
reason to use a predeclared stop/revisit rule, not to reclaim consumed attempts.

Keep validation/holdout cases, answers and feedback out of the optimizer's
learning ledger. If a reserved gate has been opened and drives a change, end
that study and use fresh independent cases for the new claim. Preserve immutable
old receipts and record the new test-plan version and its evidence provenance.

Judge the learning by whether a cheap test now rejects a known bad patch, a
compatible patch can still pass, and a later varied outcome test supports the
requested benefit. Receipt coverage, one observed successful push, compilation,
an alive service and extra trace volume each support their own limited claims.
Do not rank mutation operators from one noisy child comparison or treat a
composite gain as general improvement of the agent.
