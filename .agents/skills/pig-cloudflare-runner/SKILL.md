---
name: pig-cloudflare-runner
description: Use when changing the Cloudflare Worker/Durable Object host, alarm/wake behavior, Wrangler deployment, or the remote coding runner and remote agent tools. Covers full mode, orchestration-only mode, runner protocol, and security boundaries.
---

# PiG Cloudflare + runner

Read `references/protocol.md` before changing the runner API or remote tools.

## Modes

Cloudflare chooses a runtime at DO initialization:

- **Orchestration-only** — no `PIG_RUNNER_URL`/`PIG_RUNNER_TOKEN`.
  - runtime: `createOrchestrationRuntime`
  - task: `pig.orchestration`
  - control/release work; manual work/review become a notice; auto reviews ignored; no model calls.
- **Full** — both runner settings present.
  - runtime: `createCloudflareCodingRuntime`
  - task: `pig.job`
  - work/review/release/control work; model calls in the DO; coding tools via runner.

If only one runner setting is present, initialization throws. Enabling/disabling the runner changes the active task kind; old jobs of the other kind remain in storage but the active admin view does not list them.

## Files

- `src/cloudflare/worker.ts` — webhook HMAC, repo routing, admin proxy.
- `src/cloudflare/repo-do.ts` — DO class, storage, runtime choice, alarm, `ctx.abort` on harness failure.
- `src/cloudflare/config.ts` — Worker/DO config from env/secrets.
- `src/cloudflare/env.ts` — bindings and optional provider keys.
- `src/cloudflare/logger.ts` — console logger.
- `src/durable/cloudflare-coding-runtime.ts` — full runtime.
- `src/durable/orchestration-runtime.ts` — no-runner runtime.
- `src/durable/alarm.ts` — `nextAlarmForTasks`.
- `src/runner/server.ts` — HTTP runner and workspace operations.
- `src/runner/main.ts` — runner process startup.
- `src/durable/remote-runner.ts` — client used by the DO.
- `src/durable/remote-workspace.ts` — `JobWorkspace` over HTTP.
- `src/durable/remote-tools.ts` — remote read/list/write/edit/bash tools.
- `src/durable/agent-workspace-doc.ts` — conversation → runner workspace binding.

## DO lifecycle

```ts
constructor(ctx, env) {
  super(ctx, env);
  void ctx.blockConcurrencyWhile(() => this.#initialize());
}
```

`#initialize`:
1. build logger/config/clients
2. copy provider keys into `process.env` (compatibility date already populates them; keep explicit common keys)
3. choose runner vs orchestration
4. `openDurableObjectSqliteStorage(ctx.storage, { prefix })`
5. create runtime with `onWake`
6. `runtime.closed` failure → `ctx.abort(...)`
7. `await this.#arm(runtime.wake())`
8. `runtime.resume()`

`onWake` must arm a recovery heartbeat while work is active and the earliest sleep otherwise. Serialize all alarm writes.

`alarm()` recomputes from `runtime.nextAlarm()` and then `resume()`. Alarms are at-least-once; keep admission/phases idempotent.

## Full mode wiring

`createCloudflareCodingRuntime`:
- `models = createModels()` (`pi-ai`), provider keys from Worker secrets/process.env.
- registry installs `createRemoteWorkTools(runner)` and `createRemoteReviewTools(runner)`.
- `createJobTask` gets:
  - `workspaceFactory` → `new RemoteJobWorkspace({ ...options, client, remoteUrl })`
  - `toolExtensions` → remote work/review tools
  - list/cancel using `JOB_TASK_NAME`
- no `env`; remote tools never use `NodeExecutionEnv`.
- Agent conversation `init` writes `AgentWorkspaceDoc`; tools read it.

Review remote tools: read/list/write only; write guard accepts only `.pig/review.json`. Work tools: read/list/write/edit/bash.

## Runner

Trusted Node service, `npm run runner` or `node dist/runner/main.js`.

Required:
- `PIG_RUNNER_TOKEN` (caller auth)
- `PIG_RUNNER_WORKSPACE_ROOT` (persistent volume; default `./data/runner`)
- `PIG_RUNNER_PORT` (default 8790)
- `GET /healthz` is unauthenticated; all other requests require `Authorization: Bearer <token>`.

Runner workspace key = **repo hex + task ID** (`RemoteJobWorkspace.id`). Never task ID alone; task IDs repeat across repository DOs. Marker reuse is by attempt/ref/branch. New attempt resets checkout.

Runner security:
- path validation inside the checkout (`isSafeRepositoryPath` + prefix check)
- sanitized shell env from `buildShellEnvironment`; no `PIG_*`, `GITHUB_*`, `GH_*`, model keys, App keys
- receives short-lived GitHub installation tokens in create/push bodies; never model/App/admin secrets
- executes arbitrary bash in per-job checkouts; treat it as a trusted execution host behind HTTPS
- persistent workspace volume; cleanup removes a job workspace

## Worker

- `GET /healthz` is static; does not query DOs.
- `POST /api/github/webhooks`: WebCrypto HMAC from raw ArrayBuffer; parse; extract `repository.full_name`; `REPOS.idFromName(repo)`; `stub.fetch("/admit")`.
- Admin requires `PIG_ADMIN_TOKEN`; because state is per repo, both list and detail require `?repo=owner/name`. Detail: `/api/jobs/<id>?repo=...`.
- No global admin listing.

## Wrangler / secrets

`wrangler.jsonc`:
- `main: src/cloudflare/worker.ts`
- `nodejs_compat`
- `REPOS` DO binding + `new_sqlite_classes`
- vars `PIG_APP_SLUG`, `PIG_TABLE_PREFIX`

Secrets:
`PIG_GITHUB_APP_ID`, `PIG_GITHUB_PRIVATE_KEY`, `PIG_WEBHOOK_SECRET`, optional `PIG_ADMIN_TOKEN`, `PIG_RUNNER_URL`, `PIG_RUNNER_TOKEN`, provider keys (`ANTHROPIC_API_KEY`, etc.). `PIG_MODEL`/`PIG_THINKING` can be vars/secrets.

Local: `.dev.vars` (ignored); `npm run cf:dev`. Full-mode local test: run runner on 8790 and set `PIG_RUNNER_URL=http://127.0.0.1:8790`.

## Gotchas

- `wrangler deploy --dry-run` is the fastest bundle check. Confirm no `prepareRepository`, `child_process`, `NodeExecutionEnv`, or local workspace in the bundle.
- Worker bundle may include `pi-ai` and remote coding modules even in orchestration mode; the orchestration path must not execute them.
- `process.env` is populated for modern compatibility dates; explicit copying is defensive.
- Admin detail requires `repo`; a job ID alone is ambiguous across DOs.
- DO alarms: one alarm per object; serialize writes; `onWake` may fire during init.
- `ctx.abort` on harness failure; next event reopens storage and recovers.
- Runner down → work/review fail with a progress comment; control/release still work.
- Runner cleanup may 404 if the checkout never existed; treat as best-effort.
- Runner path traversal must be rejected; keep tests.
- Do not add a second writer to DO SQLite.
