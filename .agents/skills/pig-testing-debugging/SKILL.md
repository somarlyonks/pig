---
name: pig-testing-debugging
description: Use when running or adding PiG tests, debugging a failure, or verifying Node, Cloudflare, runner, or remote-tool changes. Contains the test harness patterns, commands, and known runtime/type pitfalls.
---

# PiG testing and debugging

## Commands

```bash
npm ci
npm run check         # typecheck + Cloudflare typecheck + node:test
npm run build         # Node host + runner to dist/
npm test              # node:test only
npm run cf:typecheck  # Worker/DO typecheck
npm run cf:dry-run    # Wrangler bundle check
npm run dev           # Node host from source
npm run runner        # trusted remote coding runner
```

Tests use `node --test` with Node type stripping. Import source with explicit `.ts` extensions.

## Test map

- `test/commands.test.ts` — @pig parsing, mentions, release flags.
- `test/webhooks.test.ts` — pure webhook planning.
- `test/admission.test.ts` — atomic admission, dedupe, per-repo chain.
- `test/job-task.test.ts` — full Node job task: control, auth, failure, retry, cancel, work, review, release.
- `test/orchestration.test.ts` — Cloudflare no-runner runtime: control, notices, ignored auto reviews, alarm.
- `test/runner.test.ts` — runner client/server: checkout, read/write/bash, commit/push, path traversal.
- `test/remote-job.test.ts` — full remote work job: runner + remote tools + faux model + fake GitHub.
- `test/durable-agent.test.ts` — model resolution, shell env, review path guard, durable agent answer.
- `test/cloudflare.test.ts` — WebCrypto verification, repo extraction, alarm projection.
- `test/server.test.ts` — HTTP/webhook/admin with a fake app.
- `test/dispatch.test.ts` — console dispatch planning, capability catalog, envelope parsing.
- `test/console.test.ts` — console runtime: enrollment, scoped dispatch, session polling, ack, observations.
- `test/console-session.test.ts` — worker-side polling loop: cursor, ack, pause, backoff.
- `test/console-assistant.test.ts` — proposal-only assistant with a faux model.
- `test/worker-kit.test.ts` — the worker protocol for non-PiG agents.
- `test/e2e.test.ts` — vertical slice over HTTP: console enroll → dispatch → PiG patch job → branch, draft PR, observation, reply.
- `test/git.test.ts` — Git safety, workflow guard, askpass, commit.
- `test/contract.test.ts`, `diff.test.ts`, `semver.test.ts`, `repo-config.test.ts`, `verify.test.ts` — pure helpers.

## Durable test patterns

- Use `MemoryStorage` for the Harness.
- Use `createModels()` + `fauxProvider({ models: [{ id: "faux-1" }] })` and `faux.setResponses([...])`.
- For tools, set `env: ({ cwd }) => new NodeExecutionEnv({ cwd })` on the Harness; local tools need it.
- For remote tools, no env; start `startRunnerServer({ port: 0, token, workspaceRoot })` and use `RemoteRunnerClient`.
- Use a local bare repo as remote; `runGit(["clone","--bare",work,bare])`; create `refs/pull/N/head` for review checkouts.
- Fake GitHub by casting an object to `Octokit`; implement only used endpoints.
- `settled.answer` is an EntryId; tests read entries if needed.
- `TaskId`/`ConversationId` are numbers; cast `Number(id) as never` in tests if types complain.
- For admission tests, a probe task can stand in for the real task; admission is generic over the task type.
- For remote job tests, `RemoteJobWorkspace` needs `client` and `remoteUrl`; the job task needs `workspaceFactory` and `toolExtensions`.

## Cloudflare verification

1. `npm run cf:typecheck`
2. `npm run cf:dry-run`
3. Inspect `dist-cloudflare/worker.js` for `prepareRepository`, `child_process`, `NodeExecutionEnv`, `local-workspace` — must be absent. `pi-ai` may contain a dynamic `node:fs` import; that is acceptable under `nodejs_compat`.
4. Optional local workerd smoke:
   - generate a throwaway RSA key
   - `.dev.vars` with fake app id, key (`\n` escaped), webhook secret, admin token, `PIG_RUNNER_URL`, `PIG_RUNNER_TOKEN`
   - start runner on 8790
   - `npx wrangler dev --port <port> --ip 127.0.0.1`
   - sign an `issue_comment` body with `openssl dgst -sha256 -hmac <secret>`
   - POST to `/api/github/webhooks`, then `GET /api/jobs?repo=...` with admin token
   - remove `.dev.vars`, `.wrangler`, kill processes
5. Real GitHub/model end-to-end needs credentials; not available in CI.

## Known pitfalls

### Node type stripping
- No TypeScript **parameter properties** (`constructor(private x)`). Use explicit fields.
- No enums/namespaces/decorators.
- Use `.ts` extensions in relative imports.

### Types
- `exactOptionalPropertyTypes`: use conditional spreads, not `{ x: undefined }`.
- Type-only imports for host-neutral modules.
- `defineDoc` values must satisfy `JsonObject`; add `[key: string]: JsonValue`.
- `runtime.commit` callbacks returning `void` are not accepted; return `undefined`.
- `Harness.open` requires a `Models` object; use `createNoModels()` for orchestration-only.

### pi-durable 1.5.0
- Task-scoped docs are retired at terminal. Use session `defineDocFamily` for job state.
- Creating a conversation inside a task `runtime.commit` crashed MemoryStorage/SQLite in 1.5.0. Create via `harness.createConversation` (with `init`).
- `Harness` has no direct `scanTasks`; use `harness.commit(tx => tx.scanTasks(...))`.
- `settled.answer` is an EntryId.
- IDs are numbers.
- `onWake`/alarms replace timers in DO; at-least-once.

### Runtime symptoms
- `Cannot read properties of undefined (reading 'length')` or SQLite `parameter 4` in a task commit → often creating a conversation inside a task commit; move it host-side.
- `Harness is closed`/`SessionFailed` → a storage misuse or error; reopen/recover.
- Worker bundle failure → Node-only import in the Cloudflare path; run `cf:dry-run` and inspect.
- Wrangler hang → stop the process; Docker/OrbStack daemon has been flaky in this environment.

### Docker
- Local Docker/OrbStack can become unresponsive. `npm ci --ignore-scripts && npm run build && npm prune --omit=dev` locally simulates the image build steps. The Dockerfile installs Git/CA, no Pi CLI.

## Change checklists

- **Engine/admission**: `npm run check`; add MemoryStorage tests; confirm replay/chain/cancel.
- **Handler/GitHub**: job-task work/review/release tests; check checkpoints/idempotency; no default-branch/force-push regressions.
- **Runner/remote tools**: runner test + remote job test; path traversal; token handling; cleanup.
- **Cloudflare**: cf:typecheck + dry-run + bundle grep; mode choice; alarm; admin repo requirement.
- **Docs**: update `ARCHITECTURE.md` for behavior; README for operator changes; AGENTS for invariants.
