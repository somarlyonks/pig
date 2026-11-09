# Choose and generate an evolution strategy

## Contents

- [Select a controller](#select-a-controller)
- [Generate an independent project](#generate-an-independent-project)
- [Run a bounded study](#run-a-bounded-study)
- [Separate memory, selection and release](#separate-memory-selection-and-release)
- [Source adaptation and limits](#source-adaptation-and-limits)

Use only after a trusted user requests improvement. An agent's trace, PR body or
child report is evidence, not authorization to mutate policy or permissions.

## Select a controller

| Strategy | Choose it when | Generated behavior |
|---|---|---|
| `trace-distillation` | Traces show a concrete repeated failure or avoidable action | One evidence-cited hypothesis and candidate, paired with the frozen baseline. Start here. |
| `population` | Several complete alternative patches exist and one scalar outcome is meaningful | Bounded candidate/generation search; hard gates precede scalar ranking. |
| `pareto` | Alternatives have complementary strengths across cases | Preserve a non-dominated case-score archive; freeze one finalist using the declared scalar/digest tie-breaker. Reevaluate a merge as a new complete candidate. |

The local runner implements those mechanics with the existing evolution manager.
It does not run GEPA or Harbor. For a prompt-only reflective search, keep tools,
scripts and data fixed and use the trace/population workflow on configured prompt
paths. Name it a local adaptation unless the actual GEPA engine ran.

Operator coevolution needs repeated attributable child-versus-parent comparisons.
The generated `operators` report supports next-study hypotheses; it does not train
or autonomously replace the optimizer. Record parent, operator, complete child
patch and development outcome. Do not infer operator quality from one child.
Advanced meta-policy analysis separates analyzer, retriever, allocator, proposer
and evolver roles; it is a design choice, not another runtime promised here.

## Generate an independent project

Resolve this command relative to the skill; generate outside the read-only bundle:

```text
uv run --script scripts/scaffold-evolution.py my-evolving-agent --strategy pareto
```

Add `--profile supervisor`, `--profile map-reduce` or `--profile review-refine`
to evolve a coordinator/specialist project. `--with-tests` is optional when
acceptance sources are included. Build with that project's own
`uv run --script scripts/project.py prepare`. Its `evolution-plans/` contains a
plan, controller, role/reflection guidance, source provenance and release record.
No command in the generated project needs the skill or original source repos.

The default example repairs an existing pure [task policy](../assets/templates/service/scripts/task-policy.mjs)
using synthetic task cases. It measures deterministic outcome mechanics, not PR
review intelligence. The policy is not silently connected to production routing.
For useful improvement, replace the goal, exact editable paths, verifier and task
fixtures with the user's observable application outcome. Configured supervisor
and specialist prompts, existing task tools and task scripts can be explicit
targets. Management, permissions, fixtures and evaluator code remain protected.

## Run a bounded study

Before freezing a new plan, apply [evidence-based test priorities](evolution-test-priorities.md).
Turn prior development failures and successful controls into cheap behavioral
checks, separate task-quality constraints from receipt utility, and predeclare
the test order and incomplete-comparison policy. These are verifier/operator
requirements to implement; the controller does not infer them from past scores.

Read the generated `evolution-plans/reflection.md` for complete commands and input
contracts. From the project, use `uv run --script evolution-plans/study.py --help`.

1. Collect actual execution or feedback evidence in the configured project's state.
   The project's smoke uses temporary state; it does not seed that evidence store.
   Choose real repeated outcomes for real improvement.
2. Have a trusted curator freeze validation and optional holdout contracts with
   `commit-gate --input <gate.json> --output <commitment.json>`. Put the opaque
   commitment paths in the plan before opening the study. Real private cases
   require a separate curator/workspace or access boundary; a file in the same
   project is not a secret from its owner.
3. Set `maxCandidates`, `maxGenerations`, `maxWallSeconds`, `timeoutMs`, exact
   paths and positive minimum improvement. `open --study <id>` freezes source,
   configuration, development cases and commitments. Started attempts consume
   budget even if interrupted. Retain failed and incomplete attempts.
4. `reflect --study <id>` exports the evidence pack. Add `--generate` only for
   explicitly requested model reflection; it produces an inactive no-tool draft.
   The authorized author writes a complete candidate patch with source preimages
   and evidence IDs. `develop --study <id> --candidate <file>` invokes real paired
   build/evaluation. Later generations require a previous qualified parent and a
   complete child patch. Do not replace comparison against the immutable baseline
   with the candidate's own claims.
5. `freeze --study <id>` closes development and fixes the finalist. A study with
   no qualified candidate retains baseline and does not open an independent gate.
6. `validation --study <id> --gate <contract.json>` opens the committed gate once.
   If declared, `holdout` follows passed validation. The exact finalist patch
   bytes are reused. Failed or interrupted gate release is terminal for that
   study; do not tune from its feedback and retry the same private cases.
7. Review the final receipt and complete `release-record.md`. Activation is a
   separate explicit `npm run evolve -- promote --proposal <final-gate-proposal>`
   command after draining/stopping the service, followed by build and smoke.
   Keep rollback bytes and verify the live outcome, following
   [the independent evolution lifecycle](agent-evolution.md).

Do not claim complete budget coverage from child counts alone. The study runner
bounds candidate attempts, generations and host wait time; it does not meter all
provider tokens, dollars or arbitrary descendant processes. Model-assisted
authoring and reflection require their own accounted budget. A verifier runs as
trusted host code and needs an appropriate environment for its actual effects.

## Separate memory, selection and release

Preserve immutable traces and source/evaluation receipts. Keep public concise
decision summaries, evidence references, hypothesis, accepted/rejected result,
regression risks, operator identity and next revisit condition. Never save private
chain-of-thought. Keep optimizer lessons out of the evaluated worker's inputs;
otherwise the comparison measures a different candidate. One successful incident
supports a local fix; generalizing a policy needs evidence across task families.

One controller owns selection in a study. A planner may propose evidence-bound
operators and an author may realize them, but neither can rewrite outcome scores,
relax hard gates or infer promotion permission. Freeze selection before the gate
and keep validation/holdout feedback out of the same study's prompts and operators.
For continued evolution open a new study with fresh evaluation cases. Carry the
last accepted baseline and use a declared plateau/attempt limit rather than an
endless retry loop. Three non-improving attempts is a possible local policy, not
a universal threshold implemented by this runner.

## Source adaptation and limits

The templates adapt the user's documented strategies from the `knowledge`
playbook and roadmap, `skill-arena` evolution skills, the blog release-record
template and `zx-harness` composition/strategy-portfolio ADRs. The generated
`evolution-plans/sources.md` records the source identities and adapted scope. It is
provenance, not required reading from those repositories at runtime.

Keep outcomes specific: a passed synthetic policy repair proves the executable
lifecycle and exact-patch gates. It does not prove autonomous model improvement,
private-data isolation, cross-domain transfer or native macOS operation. Use real
task outcomes and independent varied cases before making those claims.
