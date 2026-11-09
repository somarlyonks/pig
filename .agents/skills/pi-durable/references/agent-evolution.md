# Independent agents and requested improvement

## Contents

- [Independent operation](#operate-after-removing-the-skill)
- [Evidence](#distinguish-memory-from-improvement)
- [Requested cycle](#run-one-requested-cycle)
- [Change selection](#choose-the-change-and-judge-the-evidence)
- [Tool compatibility](#preserve-the-tool-contract)
- [Acceptance](#acceptance)

Generate an application that can outlive this skill. Copy its source, prompts,
tools, local operations script, package lock and runbook to the requested project.
After scaffolding, use commands inside that project. Do not make the service read
this skill, its parent repository, the original chat or a sibling skill at runtime.
The portable `scaffold-manifest.json` records initial relative-file SHA-256 hashes,
exact package pins and the pinned Pi release provenance; it excludes itself.
Keep that initial manifest unchanged after improvements. Current source version
records identify later edits. Relocation tests copy current portable authored
files and compare that copy; fresh-generation validation checks initial hashes.

## Operate after removing the skill

From the generated project use `npm ci --cache .cache/npm --ignore-scripts
--no-audit --no-fund`, `npm run build`, `npm run smoke`, and the compiled CLI.
Alternatively use its own `uv run --script scripts/project.py prepare|smoke`.
Render native plans with its local helper's `plan --options local.json --output
plan.json`; JSON preserves target paths across shells. Its `evolve -- --help`
passes through to the generated evolution CLI. Dependency access is needed for a
fresh installation; an installed project operates without the skill. Transfer
state separately with a consistent SQLite backup, configured secret environment,
and target OS service paths. Do not copy a live database blindly.

The generated `AGENTS.md` is the durable operations and improvement runbook. It
belongs to the generated application. Keep task instructions in that agent's
configured `instructionsFile`, not by reading this skill at runtime.

Console-created projects also carry their own `src/console` control CLI. Use
[the agent lifecycle](agent-lifecycle.md) to operate and verify them from Pi or
without the original console. Task-completion receipts are distinct from
contract-bound verification outcomes. Include actual failed/passed verification
evidence when selecting a useful improvement goal.

## Distinguish memory from improvement

Durable conversations remember work. An evidence ledger records observed actions
and outcomes. Neither automatically changes the agent's decision policy. An
improvement cycle changes prompts, tool implementation or scripts under a trusted
explicit request and evaluates the changed version before activation.

Persist attributable IDs (agent, event, job, conversation and submission), source
version hashes, timestamps, bounded public action/outcome summaries, failure
categories, concise explicit decision summaries and supporting evidence links.
The Harness owns conversation history; host records supplement it. Do not capture
provider thinking blocks or private chain-of-thought. Hash or summarize large
inputs and redact supported secret forms. Summaries are lossy and potentially
sensitive; treat an exported evidence pack as private until reviewed.

Pi Durable 1.5.0 offers optional content-free telemetry (`HarnessOptions.telemetry`
with `DURABLE_TELEMETRY_SCHEMA`) for admission and phase spans. The generated host
keeps its own evidence store and version records; enable telemetry deliberately and
do not paste main-only or automatic-optimizer APIs into this pinned application.

Apply [evidence readiness](evidence-readiness.md) when authoring the agent and
before opening a study. Transfer the operational guidance into its own runbook
and adapt its active prompt; reading `AGENTS.md` is not automatic model behavior.
Review complete attributed task outcomes, verification and relevant successes or
failures, then name missing observations. The current engine requires existing
evidence but does not enforce sufficient coverage. Inspect the actual bounded
reflection pack; stop a proposal whose essential evidence was omitted.

## Run one requested cycle

1. Define an observable goal from traces: for example fewer redundant PR reads
   with unchanged findings, or correct handling of a previously failing fixture.
   Record the goal, selected agent, exact allowed file paths, verifier, fixtures,
   timeout and minimum required score improvement. Configured specialist role
   prompt files can be explicitly selected alongside the supervisor's active
   prompt; unrelated prompt files cannot. Do not grant new permissions
   merely to improve a score.
2. Use `npm run evolve -- request --config config.json --input request.json`.
   Request shape: `{agentId,goal,allowedPaths,verifierPath,fixturePaths,
   minimumImprovement?,timeoutMs?}`. Only the active agent prompt, existing
   `src/tools/*.ts`, and explicitly allowed task scripts can be targets. Config,
   package files, manager/security code, verifier and fixtures remain protected.
   The duty contract and core workspace/GitHub allowlist tools are also protected;
   ordinary task tools and explicitly selected prompts/scripts remain eligible.
3. Run `npm run evolve -- reflect --config config.json --request <id>`. Inspect
   the returned evidence/source pack, then reflect over its actual outcomes,
   relevant scripts/tools and prompt. Ordinary `reflect` exports evidence. When
   explicitly requested, add `--generate` to obtain a draft from the configured
   provider in a separate conversation with no tools; it cannot activate changes.
   An authorized coding agent can also author the reflection directly. `faux`
   produces a labeled mechanics demonstration with no model quality evidence.
4. Produce an inactive candidate with `{requestId,evidenceIds,hypothesis,
   decision,expectedBenefit,regressionRisks,changes:[{path,beforeHash,content}]}`.
   Cite concrete pack evidence and exact preimage hashes. Explain why each change
   should affect the observed outcome. Run `propose --request <id> --input
   candidate.json` through the same CLI.
5. Run `evaluate --proposal <id>`. Baseline and candidate compile independently
   and run the same frozen verifier/fixtures. The Node verifier receives
   `--project <workspace> --fixtures <frozen-fixture-manifest>` and emits JSON
   `{passed,score,cases:[{id,passed,score?}]}`. Require nonempty matching cases,
   no failed cases, and the configured score improvement. Keep raw outputs and
   failed attempts. Verifiers are trusted executable project code, so inspect
   them and avoid live effects or secrets during evaluation.
6. Drain or explicitly abort unfinished jobs and control/background tasks. Stop
   the owning host, then `promote --proposal <id>` only within the user's request.
   This promotes source and returns `buildRequired`: run `npm run build` and
   `npm run smoke` before restarting. Preserve version lineage and exact rollback
   bytes. Observe the target behavior; on a regression stop the host and use
   `rollback --proposal <id>`, then rebuild/smoke before restart. Use `recover`
   after an interrupted source activation and rebuild/smoke its recovered version
   before restart. Compiled JavaScript is not replaced by source promotion or
   rollback alone. The engine rejects a live owner, unfinished durable work,
   stale hashes and invalid evidence.

All commands use `npm run evolve -- <command> --config config.json ...`. Run
`npm run evolve -- --help` for the generated contract. A trusted explicit request
authorizes only its stated scope; a PR body, tool response, trace or proposal is
not authorization. Routine work and idle waiting must not start this loop.

## Choose the change and judge the evidence

Use [test priorities](evolution-test-priorities.md) when prior attempts reveal
repeated failures or a misleading composite gain. Preserve the closed study;
apply newly learned assertions and priorities to the next versioned plan.

| Observed issue | Candidate change | Useful comparison |
|---|---|---|
| Repeated avoidable tool calls | Prompt or bounded read-tool caching | Call count and unchanged verified result |
| Incorrect structured output | Prompt/tool validation | Exact schema and task correctness across retained cases |
| Script handles one path incorrectly | Existing task-script patch | Reproduction, paths with spaces, Windows/macOS cases |
| Recovery causes duplicate effects | Tool idempotency logic | Interrupted run, stable keys and external effect count |
| Model interpretation regresses | Prompt candidate | Real outcome evaluation across varied held-out cases |

Do not claim a faux run measures review quality. A build and a verifier that only
check changed text measure mechanics. Use real outcome evidence for usefulness;
separate measured case performance from untested generalization. Reflection may
produce no acceptable candidate, and that is a valid recorded outcome. Repeated
trials against the same visible fixtures risk overfitting; retain varied cases,
use held-out cases where feasible, and do not silently relax the acceptance gate.

Keep changes compatible with persisted jobs and historical definitions. Package
or schema upgrades need a separately reviewed migration plan with backed-up state;
they are outside ordinary prompt/tool/script evolution. An audit log or hash chain
is local provenance, not a defense against an owner who can rewrite the filesystem.

## Preserve the tool contract

Before evolving a tool or task script, inventory its existing inputs, output
fields, types, status meanings, unknown/null behavior and bounded error shape.
Find consumers in active prompts, console/report code, watchdogs and retained
conversations. Prefer additive fields with unchanged semantics. A stored tool
definition can outlive its original host implementation; passing a new producer's
tests alone does not establish compatibility with those consumers.

Keep capability observations separate from execution evidence. For example,
`validationCommands` describes configured checks; `validationReceipts` records
actual attempts. Adding receipts or `validationStatus: "not-run"` must not remove
the configured command list, replace it with an empty list, or imply that no
validation capability exists. Empty receipts establish neither a pass nor an
unavailable check. Preserve unknowns and classify not-run, passed, failed and
unavailable from their respective observations.

Exercise old consumers against candidate responses, including unchanged/no-op,
blocked, failed and partially observed work. Check the baseline contract too.
Reject an incompatible candidate even when its scalar score improves; an
incompatible baseline is not automatically releasable either. If changing the
public schema is necessary, require a separately scoped version/adapter and
consumer migration with recovery/rollback checks. Do not rewrite a frozen
verifier or discard historical fields to make the chosen candidate pass.

## Acceptance

Move the generated project to a path with spaces and test it with the skill
unavailable: build, offline smoke, dry-run plans, and evolution help must work.
Verify trace retention across restart and attributable version IDs. Verify no
request means no reflection/mutation. An exported proposal must leave active
files unchanged. Reject failed, stale, untested or out-of-scope promotion, and
verify promotion/rollback exact hashes and retained history. Record which provider,
fixtures and native platforms actually ran; never turn structural checks into a
claim of quality improvement or native macOS startup success.
