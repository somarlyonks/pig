# Run the service template

## Contents

- [Build and configure](#build-and-configure)
- [Registry and chat](#registry-and-chat)
- [API and offline smoke](#api-and-offline-smoke)
- [Native lifecycle plans](#native-lifecycle-plans)

Scaffold at the requested output path with the bundled `scripts/scaffold.py`.
Operate the generated project, never the read-only skill directory. The starter
implements a loopback HTTP API and terminal CLI; it is not a Codex sidebar plugin
or a browser dashboard. Adapt the registry/chat API to an existing console when
that product exposes a supported integration.

## Build and configure

Prefer the bundled helper from the caller workspace: `uv run --script
<skill>/scripts/service_project.py <generated-project> prepare`. It resolves npm,
sets the generated directory as cwd and a local cache, then installs and builds.
Use action `smoke` for the packaged offline event/chat/reopen check. Its result is
written to `<project>/.cache/smoke-result.json`; every service it opens is closed.
Do not improvise a parser for a registry response: jobs and agents are wrapped as
`{jobs:[...]}` and `{agents:[...]}`. The smoke exercises these exact contracts.

From the generated directory:

```text
npm install --cache .cache/npm --ignore-scripts --no-audit --no-fund
npm run build
node dist/src/cli.js help
```

The dependency versions are pinned. Run `npm test` only when the scaffolder
reported `tests_included: true`; normal runtime bundles omit acceptance examples.
Use the compiled CLI without npm wrappers when capturing raw JSON output.

`config.json` version 1 requires:

- `host: "127.0.0.1"`, a fixed free `port`, and `dataDir` relative to the config
  file or an absolute state path. Port 0 is for embedded tests, not CLI clients.
- Optional `serviceName` persists the OS service identity. Use a unique name for
  each installation and the same name for every later lifecycle action.
- `provider.kind`: `faux`, `openai`, `anthropic`, or `openai-codex`. Real providers also require
  an exact `model` or a task-aware `latest` policy resolved from a compatible current catalog.
  Use the [model commands](model-selection.md) to inspect reasoning levels and freeze comparisons. `faux` emits labeled demo
  text and performs no useful model review; optional `delayMs` simulates latency.
  For `openai-codex`, set an absolute installed Pi CLI JavaScript entry path in
  `provider.piCliPath` or process `PI_CLI_PATH`, and follow the
  [read-only Codex bridge](codex-provider.md). It uses an existing account;
  ordinary `openai` and `anthropic` continue to use their API credentials.
- `agents`: stable lowercase `id`, display `name`, trusted `instructions`, and
  an explicit `repositories` array in `owner/repo` form.
- `github.mode`: `off`, `poll`, or `webhook`; `intervalMs` (normally 60000),
  `initialScan: "baseline"` unless backfill is requested, optional `maxPages`
  (1–10000, default 100) for catch-up. The scheduler also respects server polling
  and rate-limit backoff. An incomplete scan does not advance its checkpoint.

Set GitHub mode `off` for offline smoke. Change to `poll` for desktop detection;
no incoming public port is needed. For `webhook`, configure a trusted HTTPS
ingress forwarding only `/webhooks/github` and a matching webhook secret.

Write supported credentials to `<dataDir>/environment.env` with suitable file
permissions/ACLs. Supported names are `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`,
`OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`. Process environment values take
precedence. Never place secrets in config, service plans, chat, or argv.

The bundled agent tool reads allowlisted GitHub PR metadata/diffs. It has no
shell, filesystem write, GitHub comment, or merge tool. PR text remains untrusted
data. Its diff response limit is 2 MiB; adapt bounded file tools for larger work.

## Registry and chat

Run the service in one terminal, and clients in other terminals:

```text
node dist/src/cli.js serve --config config.json
node dist/src/cli.js list --config config.json
node dist/src/cli.js jobs pr-reviewer --config config.json
node dist/src/cli.js chat pr-reviewer --config config.json
node dist/src/cli.js chat pr-reviewer --job <saved-job-id> --config config.json
node dist/src/cli.js chat pr-reviewer --job <saved-job-id> --steer --message "Focus on compatibility" --config config.json
node dist/src/cli.js abort pr-reviewer --job <saved-job-id> --config config.json
```

Without `--job`, chat attaches to the agent's control conversation. With `--job`,
it attaches to that task's persisted thread, including jobs older than the latest
100 list entries. `/exit` closes an interactive client. A client Ctrl+C disconnects
the client; use `abort` to stop the selected conversation's work.

Messages default to `followUp`; `--steer` joins active work at a tool boundary.
For a one-shot retry after ambiguous network admission, reuse
`--request-id <stable-message-id>`. Do not reuse the same ID for a different human
message. The console remains discoverable when idle; it does not keep a model
request alive simply to wait for another event.

Catalog jobs marked `failed` or `unanswered` stay visible. The starter recovers
unfinished work on restart and Pi may retry transient provider errors, but there
is no automatic retry API for terminal failed jobs. Inspect the cause and attach
an explicit human message to the saved job thread; do not loop arbitrary effects.

## API and offline smoke

The service generates `<dataDir>/console-token` for local bearer authentication.
The CLI reads it locally. A UI adapter sends `Authorization: Bearer <token>`;
never print the value or expose the API beyond loopback without an auth design.
`GET /health` contains only service/version data. Protected routes include:

| Route | Meaning |
|---|---|
| `GET /v1/agents` | Registered agents and pending-job counts |
| `GET /v1/agents/<id>/jobs` | Latest 100 catalog jobs |
| `GET /v1/agents/<id>/chat?jobId=<id>` | Current structural snapshot |
| `POST /v1/agents/<id>/messages?jobId=<id>` | Admit `{content,requestId,whenBusy}` |
| `GET /v1/agents/<id>/submissions/<id>` | Poll an admitted message's status/text |
| `POST /v1/agents/<id>/abort?jobId=<id>` | Abort the selected conversation |
| `POST /v1/events` | Admit an authenticated local PR event for offline smoke |

The local event shape is `{type:"pull_request.opened",repository,number,title,
url,headSha,createdAt}`. The server derives the semantic ID. Send an event twice
for an allowlisted repository: exactly one job should appear per matching agent.
Wait for its labeled faux result, close/reopen the service, and attach using the
same job ID. Confirm unchanged conversation identity and zero new model calls
while merely listing/reconnecting. The provider must remain faux and detection
off during an offline check. Keep request bodies below 1 MiB.

`POST /webhooks/github` uses HMAC authentication rather than the console token.
Signed unsupported events are acknowledged without a job. Receipt is stored
before a 202 acknowledgement; task execution happens afterwards.

## Native lifecycle plans

From the generated directory on the target host:

```text
node dist/src/cli.js service install --config config.json --output plan.json
node dist/src/cli.js service install --config config.json --execute
node dist/src/cli.js service status --config config.json --execute
node dist/src/cli.js service stop --config config.json --execute
node dist/src/cli.js service start --config config.json --execute
node dist/src/cli.js service uninstall --config config.json --execute
```

Without `--execute`, all service actions return a plan and change no OS state.
Specify `--name` consistently for separate installations. On another platform,
use target-OS absolute paths with `--platform win32|darwin`, `--project`,
`--target-config`, `--state-dir`, and `--node`; a macOS cross-plan additionally
needs `--home` and `--uid`. `--config` still reads a local config; the target
overrides describe its future deployment. Real execution rejects a foreign OS.

Prefer `--options <local-json>` or the skill's `service_project.py ... plan`
helper for cross-platform plans. Store `platform`, `projectDir`, `configPath`,
`dataDir`, `nodePath`, `serviceName`, and macOS `homeDir`/`userId` in that JSON.
Do not pass target `/Users/...` strings through Git Bash argument conversion;
JSON file contents bypass MSYS path rewriting. The result also includes
`deploymentConfig`: write that value at the plan's target config path before
activation. Otherwise a future process could read a different state directory
from the one used by the supervisor plan. Native execution rejects mismatches.
Combine plan JSON files programmatically rather than manually transcribing XML.

Show lifecycle commands from the generated project using `node`, avoiding a
bare `C:\\Program Files\\...` executable in shell text. When an absolute Windows
executable is necessary, use a quoted call operator in PowerShell; when using a
Unix shell, quote the executable path. Installed actions already use argv arrays.
After deploying `deploymentConfig`, ordinary `service ... --config config.json`
commands inherit its service name. Do not accidentally target the default name.

State lives in `catalog.sqlite` plus `agents/<id>/harness.sqlite`. `owner.sqlite`
holds an OS-backed exclusive transaction while the service owns the directory;
process death releases it. Service files live in `service/`, logs in `logs/`.
Uninstall retains state. Back up the state with the process stopped or using an
appropriate SQLite backup procedure. Native login/sleep/logout behavior requires
testing on each actual target OS; rendered plans alone do not prove it.
