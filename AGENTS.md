# PiG

Guidance for agents working in this repository. The product contract is [ARCHITECTURE.md](ARCHITECTURE.md); keep behavior there in sync when changing user-visible behavior.

## Commands

```bash
npm ci
npm run check         # typecheck + Cloudflare typecheck + node:test
npm run build         # tsc to dist/
npm run dev           # node --watch src/main.ts
npm run cf:typecheck  # typecheck the Worker/Durable Object host
npm run cf:dry-run    # bundle the Worker without deploying
```

Tests use `node --test` with Node's TypeScript type stripping. Import source files with explicit `.ts` extensions; `rewriteRelativeImportExtensions` converts them on build.

## Layout

- `src/main.ts` — startup, shutdown, harness failure handling, wiring.
- `src/server.ts` — HTTP routes: webhook, health, admin.
- `src/webhooks/` — raw-body signature verification (Node and WebCrypto), command parsing, webhook planning, repository extraction.
- `src/durable/` — pi-durable app: Harness, `pig.job` and `pig.orchestration` tasks, admission, docs, model resolution, tools, agent adapter.
- `src/cloudflare/` — Worker + per-repository Durable Object host, alarms, WebCrypto verification.
- `src/jobs/` — GitHub job handlers (work/review/release/control), contracts, errors.
- `src/github/` — App clients, repository metadata, `.pig.yml` loading.
- `src/git.ts` — host Git operations, askpass lifecycle, workflow guard, config reset.
- `src/diff.ts`, `src/semver.ts` — pure helpers with unit tests.

## Invariants

- Webhooks must be verified from the raw body with `X-Hub-Signature-256` before parsing.
- Admission must commit the delivery record, command record, repository chain, and job task atomically before the webhook returns `202`.
- Keep delivery/command idempotency keys stable. Replaying a delivery must not start work twice.
- Agent jobs must stay serialized per repository through the durable job chain. Control jobs must bypass the chain.
- Use `pi-durable` tasks, conversations, and documents for all durable state. Do not add a parallel queue or lease layer.
- One process owns one `pi-durable` storage. Do not open the same database from multiple app processes.
- Persist checkpoints for irreversible steps: the release plan before creating a tag, the pushed commit before PR finalization, and the review URL after posting a review.
- Agent conversations are owned by their job task, one per attempt. Reuse the stored conversation and request ID when resuming the same attempt.
- Do not pass `PIG_*`, `GITHUB_*`, `GH_*`, model provider keys, or unrelated host secrets to agent shell commands. Use `buildShellEnvironment` and `createBashTool({ prepare })`.
- Review conversations get no shell and may write only `.pig/review.json` through `ReviewTools`.
- Host Git operations must not run repo hooks or credential helpers; use the existing `runGit` path and reset local config after agent work. Never construct a push URL with a token in it.
- Never push to the default branch or force-push an existing PR head branch. Only the deterministic PiG branch may be force-pushed.
- Keep the Cloudflare Worker bundle free of Node-only modules. `src/cloudflare/` must not import `src/durable/app.ts`, `job-task.ts`, `git.ts`, or the agent/tool modules.
- The orchestration host supports control and release only. Do not make it silently run partial work/review jobs; convert manual commands to a notice and ignore automatic reviews.
- Map `harness.wake()` and stored task deadlines to the Durable Object alarm. Alarms are at-least-once; keep admission and task phases idempotent.
- One Durable Object owns one repository storage. Do not open the same DO SQLite from another process.
- Keep `PIG_TABLE_PREFIX` stable; changing it does not migrate existing state.
- Persist one progress comment per job and edit it; do not add a comment per attempt.
- Revert `.github/workflows/**` edits when workflow changes are not allowed.
- Keep user-facing behavior documented in `ARCHITECTURE.md`, not in code comments.

## Code style

- Descriptive function and variable names; split logic into small named helpers.
- Avoid comments that restate code. Comment only non-obvious reasons.
- Prefer pure functions and explicit parameters over global mutable state.
- TypeScript strict mode is on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Add tests for command parsing, webhook planning, admission/idempotency, job-task retries/cancellation, orchestration admission/alarms, WebCrypto verification, diff line mapping, semver/release grouping, model resolution, shell-env sanitization, and result parsing when those change.
- Durable integration tests should use `MemoryStorage`, faux providers, and local bare Git repositories; they must not need GitHub or model credentials.
