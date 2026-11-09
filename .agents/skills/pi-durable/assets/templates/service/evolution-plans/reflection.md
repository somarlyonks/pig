# Explicit evolution roles and workflow

The trusted operator owns the goal, editable paths, budget, verifier and split
contract. The candidate author receives only development evidence and permitted
source. A separate curator owns independent validation and optional holdout.
This directory is a local controller, not an access-control boundary: use a
separate account, container or curated workspace when physical isolation matters.
The supplied visible fixtures demonstrate mechanics only. Replace them with
application-specific cases and genuinely private curator inputs for quality claims.

Choose one strategy in `catalog.json`. Trace distillation makes one small repair
from recurring trace evidence. Population compares complete alternatives using a
scalar score. Pareto preserves nondominated case vectors before choosing one
finalist with the frozen scalar-score/digest tie-breaker. No controller launches
models while idle or activates source changes.

From the project directory, build first and collect actual execution evidence.
Run `node dist/src/cli.js serve --config config.json`, send a task through its
authenticated CLI or console, and stop cleanly. The ordinary offline smoke uses
temporary state; it does not populate this project's evolution evidence store.

The curator commits independent gates before opening development:

```text
uv run --script evolution-plans/study.py commit-gate --input evolution-plans/validation-gate.json --output evolution-plans/validation-commitment.json
uv run --script evolution-plans/study.py commit-gate --input evolution-plans/holdout-gate.json --output evolution-plans/holdout-commitment.json
uv run --script evolution-plans/study.py open --study review-policy-v1
uv run --script evolution-plans/study.py reflect --study review-policy-v1
```

Ordinary reflection exports a pack. Use `reflect --generate` only for separately
requested model assistance. For real agents use the project's Codex provider
bridge with a resolved exact model, an absolute installed Pi CLI JavaScript path,
and the existing account's credential environment. Keep `faux` for offline work.
Run `npm run models -- lock --config config.codex.example.json --output config.resolved.json`
before collecting real evidence, then pass `--config config.resolved.json` to
every study command. This pins resident, specialist and reflection IDs/efforts
plus the catalog snapshot. Freeze the same provider/model identity for comparable arms. Do not substitute
an unrelated model policy from the source playbooks.

Author a complete `candidate.json` using the returned request ID, pack evidence
IDs and exact preimage hashes. Its schema is the existing evolution CLI's
`ProposalInput`. For the synthetic demo, a generic repair recognizes opened,
reopened and ready-for-review PR actions, retaining duplicate/draft guards.
The task-policy demo is deliberately outside production admission logic.

```text
uv run --script evolution-plans/study.py develop --study review-policy-v1 --candidate candidate.json --operator lifecycle-actions
uv run --script evolution-plans/study.py operators --study review-policy-v1
uv run --script evolution-plans/study.py freeze --study review-policy-v1
uv run --script evolution-plans/study.py validation --study review-policy-v1 --gate evolution-plans/validation-gate.json
uv run --script evolution-plans/study.py holdout --study review-policy-v1 --gate evolution-plans/holdout-gate.json
uv run --script evolution-plans/study.py status --study review-policy-v1
```

Every started candidate consumes the frozen count budget, including failures.
Commands that can mutate or consume study state hold one exclusive study lock
for their complete execution, including long-running CLI children. A concurrent
command fails immediately. `status` remains a read-only snapshot. An interrupted
owner leaves `evolution-plans/runs/.locks/<study-id>.json`; locks never expire or
clear automatically. Before manually removing an interrupted lock, inspect the
recorded PID with the operating system, match its command and creation time to
avoid PID reuse, and establish that its child evaluation/CLI processes are also
terminal. If any owner is still running, wait for or explicitly stop that work;
the mere presence, age or absence of a study artifact is not terminal evidence.
Keep the interrupted attempt and gate receipts. Removing a verified abandoned
lock does not reopen a consumed gate or authorize replaying an evaluation.

Later generations require an evaluated previous-generation parent that qualifies
for scalar selection or belongs to the valid nondominated Pareto archive,
an operator name and a complete patch including inherited changed paths. All
candidate preimages remain relative to the original baseline. Child-versus-parent
development deltas support attribution hypotheses; they do not establish causal
operator superiority. Require at least two distinct child-parent comparisons per
operator and inspect parent/task-family coverage before freezing a next-study
operator contract. Keep rejected attempts. Do not adapt operators from gate data.

Selection closes development. Only one digest-frozen patch enters independent
validation. An attempted, failed or interrupted gate consumes its release; no
repair, reselection, retry or development reentry is allowed in the same study.
A new claim needs a new study and fresh independent inputs. Optional holdout
opens only after validation passes. Shared fixture paths are rejected; a curator
must additionally verify semantic-family separation and exposure, which hashes
cannot establish.

The final receipt recommends only activation review. It never calls `promote`.
Review the exact final proposal, stop and drain the service, then use the existing
explicit promote/build/smoke/restart lifecycle and retain exact rollback bytes.
The old low-level evolution CLI remains available; the operator must preserve
this study's gate policy when choosing which proposal to activate.
