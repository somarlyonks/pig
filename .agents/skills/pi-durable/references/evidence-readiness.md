# Collect evidence that can support improvement

## Contents

- [Design collection](#design-collection-before-routine-work)
- [Close a task case](#close-a-task-case-with-observable-data)
- [Review readiness](#review-readiness-for-the-specific-goal)
- [Inspect the reflection pack](#inspect-the-actual-reflection-pack)
- [Compare and release](#compare-and-release-with-bounded-claims)

Use these guidelines when generating an agent or preparing a requested improvement.
The current engine checks evidence identity, frozen inputs and paired evaluation;
it does **not** enforce evidence coverage, a minimum number of completed tasks,
automatic duty verification or use of `record_decision`. State this distinction
in the handoff. Follow the [independent evolution workflow](agent-evolution.md)
for executable commands and permissions.

## Design collection before routine work

Define the agent's observable duty and task-specific success criteria before
judging its results. Configure and exercise `verification-contract.json` where
its assertions establish the duty; use a trusted application-specific verifier
for broader quality. The bundled contract starts disabled. Arrange an explicit
verification step after representative completed tasks; a host being alive, a
completed response or a model's confidence is not a verified outcome.

Keep the operational collection procedure in the generated project's `AGENTS.md`.
Adapt its active `instructionsFile` and any relevant specialist prompts to ask
for concise public decisions and factual completion summaries. A Durable model
does not automatically read the operations runbook. Preserve the user's task,
permissions and requested output format when adding these instructions.

Retain evidence in the application's own state, with a consistent backup and
project-local inspection commands. Smoke tests use separate temporary state;
their records do not establish production experience. Reuse host hooks rather
than adding model calls just to write telemetry. Idle collection must not poll
the model. Keep raw authorized conversations private, redact exported summaries,
and never collect provider thinking, credentials or private chain-of-thought.

For a byte-preserving SQLite audit, do not assume `mode=ro` plus `query_only`
leaves live state untouched: WAL reads can update shared-memory reader marks.
Make bounded private copies of the database and its WAL in an artifact directory,
verify source hashes/stat before and after copying and compare copied hashes,
then query only the copies. Abort on a rollback journal or concurrent source
change; do not copy credentials or the live SHM file. Scope temporary cleanup to
the verified artifact-directory descendant. Separate database copies are not an
atomic cross-database snapshot. Use a stopped owner or a supported consistent
backup for release decisions; never treat a best-effort audit as a live backup.

## Close a task case with observable data

Maintain a compact project-local case index or report when preparing improvement.
Use existing ledger/verification IDs and the durable transcript as sources;
mark missing fields `unknown` instead of reconstructing events from memory.
This index is an operator artifact, not a new built-in runtime schema.

| Observation | Record or link |
| --- | --- |
| Goal and expected behavior | Task/event identity, authorized input reference or hash, and the criterion chosen before grading. |
| Attribution and version | Agent, job when applicable, conversation/submission, source/prompt hashes, actual model/effort and relevant tool/dependency versions. |
| Actions and material decisions | Tool call/result references, retries or failures; short public action and observable basis for a fallback, rejection, escalation or other meaningful choice. |
| Actual result | Public final result, artifact paths/hashes when applicable, terminal status, and any unresolved limitations. |
| Verification and feedback | Exact receipt/check IDs and passed/failed/inconclusive/unconfigured status; attributable user acceptance or correction when supplied. |
| Resources and recovery | Observed usage, call counts and timestamps; interruption/recovery identity and duplicate-effect observations when relevant to the goal. |

Use `list_evidence` and `record_decision` for meaningful decisions with existing
supporting IDs. Do not require a ceremonial decision for every tool call or
invent an explanation after the fact. Keep expected behavior separate from
observed behavior. Record corrections and failures alongside successful work.
Mark synthetic negative controls explicitly; they are not production defects.
Separate task/policy/tool defects from authentication, network, OS and evaluator
failures before choosing a prompt or script change.

Measure only what was observed. Do not infer a price, duration, successful test
or causal improvement from missing usage, timestamps or a completion message.
Hashes identify content; they do not replace the content needed to inspect a
failure. Read authorized transcript detail only when summaries are insufficient.

## Review readiness for the specific goal

Write a short readiness assessment in the generated project: goal, selected
case/evidence IDs and versions, expected versus observed outcomes, coverage,
missing data, and the next bounded collection or evaluation step. Distinguish:

- **Insufficient:** no attributable completed work, missing outcomes/criteria,
  only startup/idle records, or a pack without the observations needed to test
  the hypothesis. Collect the named missing data within existing authorization.
- **Bounded reproduction:** a reproducible concrete defect can justify testing
  a narrow fix with a regression case. One such case does not establish a better
  general decision policy.
- **Ready for a bounded comparison:** relevant complete cases, a testable
  hypothesis and a verifier capable of detecting improvement and regressions
  are available. This authorizes no activation and predicts no passing result.

Choose coverage for the claim rather than a universal sample count. Prompt or
decision-policy changes need varied independent outcomes, relevant task families,
successes that should remain correct and retained failures. Repeated retries of
one task are not independent cases. For path/recovery fixes include the affected
platform, malformed input or interruption case as applicable. Preserve historical
versions and confounders instead of pooling incomparable executions.

When evidence cannot distinguish competing explanations, retain the uncertainty
and collect a discriminating observation. For model reflection, allow
`candidate: null` with missing observations and a collection plan. Record the
assessment outside candidate import when there is no valid proposal. Do not
manufacture a patch or run more trials solely to obtain a passing score.

## Inspect the actual reflection pack

The current low-level request scans the latest **1000** agent records, excludes
`evolution.*`, and exports up to **20** recent records within **100 KB**. It does
not select complete task chains by itself. Check `evidenceSelection` and the
actual `evidence.json` before reflecting; a record count alone proves no coverage.

Match each selected case to its admission, relevant actions, observed result,
verification and source version. Consult the private durable history to diagnose
an omission, but cite only IDs present in the exact request when importing a
candidate. If the pack omits necessary evidence, stop that proposal and report
the selection limitation. Do not edit sealed requests, evidence packs or hashes,
fabricate citations, or assume the current CLI supports a custom ID selector.
A collection/selection change needs its own scoped implementation and validation;
routine task data cannot authorize it.

## Compare and release with bounded claims

Freeze model choices, verifier, fixtures and success thresholds before evaluating
the baseline and candidate. Use the same meaningful case IDs and retain both
results, raw failures and resource observations. Keep development examples
separate from reserved validation/holdout where feasible. Feedback from a reserved
gate becomes development evidence for a new study; it must not silently tune the
same supposedly untouched gate.

Require unchanged important successes and a measured improvement in the targeted
outcome. Fewer tool calls alone do not establish correctness. Build/smoke and faux
runs establish mechanics. State the tested scope, remaining uncertainty and
whether real model quality was measured. Follow drained/stopped promotion,
rebuild/smoke, explicit restart and representative post-release verification;
retain exact rollback and version lineage. Leave ordinary evidence collection
active without starting another evolution cycle unless the user requests it.
