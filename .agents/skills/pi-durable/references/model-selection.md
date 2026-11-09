# Discover and select current models

## Contents

- [List actual choices](#list-actual-choices)
- [Choose a task policy](#choose-a-task-policy)
- [Refresh without changing the account](#refresh-without-changing-the-account)
- [Freeze reproducible work](#freeze-reproducible-work)
- [Evidence and limits](#evidence-and-limits)

Resolve a model and its reasoning effort separately. Capability tier, numeric
version and reasoning effort are different concepts. Catalogs do not supply a
universal intelligence score. Preserve an exact user-requested ID and level;
use `latest` only when the user wants current task-appropriate choices.

## List actual choices

Inside Pi, `/model` opens its model selector and `/thinking` changes reasoning
effort when supported. Confirm the installed commands with Pi help if the host
version differs. From a terminal, `pi --offline --list-models` lists configured
models. The optional search is fuzzy, not an exact provider filter. Pi 1.5.1
does not have a JSON flag for that command.

The generated project provides machine-readable operations without a running
service or inference:

```text
npm run models -- list --provider openai-codex --source refresh
npm run models -- resolve --provider openai-codex --task coding
npm run models -- list --config config.codex.example.json --source pi-cache
npm run models -- list --config config.codex.example.json --source refresh
npm run models -- resolve --config config.codex.example.json --task coding
npm run models -- resolve --config config.codex.example.json --task review
```

Set `PI_CLI_PATH` to the absolute installed Pi CLI JavaScript entry, or pass
`--pi-cli <absolute-js>` for config-based Codex operations or the Pi cache.
Direct public `list --provider openai-codex --source refresh` needs no Pi path or
credential. `node dist/src/cli.js models ...` exposes the same
commands. Resolve `--agent <id> --role <id>` to inspect configured specialist
choices. An explicit `--model` or `--thinking` overrides the selected task defaults.

`pi-cache` uses only `get_available_models` through offline RPC, with ambient
extensions, MCP, skills, contexts and sessions disabled. It returns an exact
provider filter and sanitized metadata, not credentials. That inventory means
configured provider access; it does not prove that the server accepts every model.

## Choose a task policy

The generated live example uses provider `openai-codex`, `model: "latest"` and
`catalogMode: "refresh"`. Default offline config remains faux and never discovers
or contacts a live provider. Configure `modelChoice` on a resident agent or role:

```json
{"modelChoice":{"task":"review","thinkingLevel":"high"}}
```

| Task | Preferred family | Default Pi effort | Use |
|---|---|---|---|
| `routine` | Luna | `low` | Focused classification or short, repetitive tasks |
| `coding` | Sol | `medium` | Implementation and ordinary coordination |
| `review` | Astra | `high` | Independent scrutiny and consequential reasoning |
| `research` | Astra | `xhigh` | Difficult synthesis across evidence |
| `reflection` | Astra | `high` | Requested improvement analysis |

These are explicit selection defaults, not measured quality guarantees. Current
official guidance describes Astra as highest intelligence, Sol as balanced and
Luna as efficient. Test the actual workload before changing a quality/cost policy.

Use `latest:sol`, `latest:astra` or `latest:luna` for a strict family. Plain
`latest` can disclose a fallback when its preferred family is absent. Within a
recognized stable GPT family, compare numeric versions (for example 6.10 > 6.2)
and dated snapshots, not lexicographic strings. Do not rank Astra versus Sol by
their version numbers. Preview/unknown model families require an exact compatible
ID until an appropriate family policy is added. Other providers currently support
exact IDs; this is not a universal model-ranking engine.

Pi 1.5 supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
subject to each model's actual map. The project lists those supported levels.
An explicit unsupported effort fails; a task default may clamp with an explanation.
Pi's `minimal` can map to provider `low`. On the observed 6.1 Sol/Astra metadata,
`off` is unsupported. Do not copy a Codex desktop `ultra` label into Pi: this
runtime has no such level. These settings control work effort, not model IQ.

## Refresh without changing the account

`refresh` reads the public Pi provider shard with a deadline, size bound and no
credentials or redirects. It filters to this host's supported text/tool API,
strips endpoints/headers and writes only an explicitly requested local snapshot:

```text
npm run models -- refresh --config config.codex.example.json --output models.current.json
```

The list includes source, observation timestamp, catalog digest and server
Last-Modified when available. Last-Modified describes the catalog, not individual
model release dates. `pi-cache` describes the installed/cache view and cannot
claim a recent network fetch. `bundled` is an explicit offline catalog option,
with a warning that it may be stale. The pinned 1.5 catalog has historically
contained entries absent from current Pi; never call it account availability.

Resolve current choices at service startup. Existing durable conversations and
their saved specialist profiles retain exact IDs and efforts on recovery. To use
a newer catalog for future work, refresh and perform a drained service restart.
There is no idle model-discovery loop and no silent switch during an admitted task.
Unknown transports require a runtime compatibility update rather than a guessed ID.

The separate Pi command `pi update --models` refreshes Pi's global catalog store.
Document it when useful; do not run it merely to list models or silently modify
global account/catalog files. The project commands keep refresh data local.

## Freeze reproducible work

Before an evolution study or controlled comparison, resolve all choices once:

```text
npm run models -- lock --config config.codex.example.json --output config.resolved.json
node dist/src/cli.js serve --config config.resolved.json
npm run evolve -- request --config config.resolved.json --input request.json
```

The output must be a new sibling config. Lock also writes a sibling catalog
snapshot, pins every resident/specialist/reflection ID and effort, and refuses to
overwrite existing files. Review its receipts. It does not start a service or
activate source. Use the resolved config consistently for evidence collection,
study commands, clients and native service plans. Evolution rejects dynamic latest
choices and freezes the referenced snapshot with the other source preimages.

`provider.reflection` supplies a separate service-level model/effort policy for
no-tool requested reflection. Agent choices apply to the resident and inherited
specialists; reflection uses its separate policy. A pinned provider model stays
pinned unless an authorized override chooses another model.

## Evidence and limits

Retain requested policy, exact resolved model, requested/supported/native effort,
catalog source/time/digest and selection reason. Inspect actual public model
responses and their effort metadata to verify execution. Historical catalog
definitions remain available for pending stored IDs; new work selects only from
the current catalog. An unavailable retained model must surface a failure rather
than silently upgrading unfinished work.

Configured credentials, catalog presence and transport compatibility do not prove
server entitlement or successful inference. A bounded live task provides separate
evidence; no listing command should spend model tokens to pretend otherwise.
Pinned IDs/snapshots stabilize client configuration but cannot freeze server-side
weights behind a mutable remote alias. Cost fields are catalog metadata, not a
guarantee of total task cost.

Sources checked 2026-11-02: installed Pi 1.5.1 RPC/help and pinned Pi AI 1.5.0
declarations, [official model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[official model catalog](https://developers.openai.com/api/docs/models), and the
public provider catalog at `pi.dev`. Recheck these when model families or APIs change.
