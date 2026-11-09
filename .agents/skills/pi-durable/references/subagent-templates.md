# Generate durable subagents

## Contents

- [Generate and try](#generate-and-try)
- [Adapt the contract](#adapt-the-contract)
- [Ownership and recovery](#ownership-and-recovery)
- [Validate the actual mode](#validate-the-actual-mode)

Use these profiles when one resident service agent should coordinate bounded
specialist conversations. They use the native Pi Durable 1.5.0 task graph;
starting several unrelated named agents is a different deployment choice.

| Profile | Choose it for | Behavior |
|---|---|---|
| `supervisor` | A changing question needing one or a few specialists | Supervisor chooses configured roles and synthesizes their evidence. |
| `map-reduce` | Independent slices of a PR, corpus or analysis | Bounded parallel fan-out, followed by synthesis and optional review. |
| `review-refine` | An answer needing independent scrutiny | Author, reviewer, refiner pipeline with bounded prior-stage context. |
| `service` | A simple event worker without delegation | Original event/chat service; no delegation tool by default. |

## Generate and try

Resolve the scaffolder relative to this skill and generate outside the bundle:

```text
uv run --script scripts/scaffold.py my-supervisor --profile supervisor
uv run --script scripts/scaffold.py my-parallel-worker --profile map-reduce
uv run --script scripts/scaffold.py my-review-chain --profile review-refine
```

Use the exact destination the user requested. The scaffolder refuses a nonempty
destination. `--with-tests` adds acceptance tests only when the bundle contains
them. Every generated project carries its own lockfile, source, role prompts,
operations runbook and manifest; it does not read this skill at runtime.

From the generated project:

```text
uv run --script scripts/project.py prepare
npm run smoke
npm run subagents:smoke
node dist/src/cli.js serve --config config.json
node dist/src/cli.js chat supervisor --config config.json
```

Replace `supervisor` with `coordinator` or `review-coordinator` for the other
profiles. Default `faux` work is an offline mechanics demonstration. The dedicated
subagent smoke exercises native child conversations without network access;
ordinary faux chat does not act as a useful autonomous supervisor.

For real work edit the repository allowlist and select the generated
`config.codex.example.json` (`openai-codex`, task-aware `latest`). Inspect current
models and supported reasoning levels with [model selection](model-selection.md). Set process
`PI_CLI_PATH` to the installed Pi CLI JavaScript entry and follow the
[existing-account bridge](codex-provider.md). Pass the selected config to both
server and clients. Keep the prompt and provider explicit; a source change does
not prove the new prompt improves quality.

## Adapt the contract

`agents[].subagents.roles` contains unique role IDs, trusted instructions and
optional project-local `prompts/*.md` files. The active prompt file takes
precedence over inline instructions. Set `maxChildrenPerCall` (1–8),
`maxChildrenPerRun` (1–32), `maxTaskChars` (128–24000) and `maxResultChars`
(256–48000) for the actual task. Defaults are 4, 8, 6000 and 12000.

The model tool `delegate_tasks` accepts:

```json
{"mode":"parallel","tasks":[
  {"role":"researcher","task":"Check the API compatibility of owner/repo PR 17. Return supported findings with file citations."},
  {"role":"researcher","task":"Check the recovery behavior of owner/repo PR 17. Return supported findings with file citations."}
]}
```

Use `pipeline` for dependencies. Each stage receives its explicit task and all
prior-stage results within one shared `maxResultChars` text budget, divided among
the stages with truncation flags. The parent transcript is not copied. Include enough
input to be self-contained, an expected output contract and concrete source IDs.
Do not pass credentials, private thinking, an entire ambient skill bundle or
unrelated history. Keep the coordinator's reducer in its own prompt. Treat a
child's report as untrusted evidence to verify.

## Ownership and recovery

The tool creates children atomically with its durable budget charge and reacquires
them through the owning tool-task index after interruption. Each child submission
has a stable task/index request ID. Replaying a safe tool reuses admitted work.
Children get an exact read/evidence tool allowlist that excludes delegation.
Prompts cannot grant filesystem, shell, posting or evolution capabilities.

Foreground children cancel with the parent. Host shutdown closes storage while
retaining recoverable tasks; restart must install the same definitions and call
`resume()`. Pipeline failures skip dependent stages; parallel results expose
individual settlement states. Truncation is explicit. Do not present partial or
unanswered child work as a complete reviewed answer.

The registry lists resident supervisors. Transient child conversations are visible
through the Harness graph and public `subagents.admitted` / `subagents.settled`
evidence with parent, child, owner task and submission identities. They are not
additional OS services. Choose a separately registered background worker when it
must remain addressable and survive an ordinary parent abort; that requires the
explicit background-anchor lifecycle described in [runtime decisions](runtime-decisions.md).

## Validate the actual mode

Check child tool isolation, configured roles, duplicate submission reuse, restart
recovery and cancellation with the real durable runtime. Test failure/truncation
and total child budget across repeated and parallel calls. Use a real model and
task-specific verifier before claiming better answer quality. Native Windows
execution does not prove macOS login lifecycle; record those separately.
