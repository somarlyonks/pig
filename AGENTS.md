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
npm run runner        # run the trusted remote coding runner
```

Tests use `node --test` with Node's TypeScript type stripping. Import source files with explicit `.ts` extensions; `rewriteRelativeImportExtensions` converts them on build.

## Layout

- `src/main.ts` — startup, shutdown, harness failure handling, wiring.
- `src/server.ts` — HTTP routes: webhook, health, admin.
- `src/webhooks/` — raw-body signature verification (Node and WebCrypto), command parsing, webhook planning, repository extraction.
- `src/durable/` — pi-durable app: Harness, `pig.job` and `pig.orchestration` tasks, admission, docs, model resolution, tools, agent adapter, remote workspace/tools, and host runtimes.
- `src/cloudflare/` — Worker + per-repository Durable Object host, alarms, WebCrypto verification.
- `src/runner/` — trusted remote coding runner for Cloudflare full mode.
- `src/jobs/` — GitHub job handlers (work/review/release/control), contracts, errors.
- `src/github/` — App clients, repository metadata, `.pig.yml` loading.
- `src/git.ts` — host Git operations, askpass lifecycle, workflow guard, config reset.
- `src/diff.ts`, `src/semver.ts` — pure helpers with unit tests.

## Project skills

Detailed, task-routed guidance lives in [`.agents/skills/`](.agents/skills). Load the relevant skill before large changes:

- `pig-architecture` — hosts, modes, request flow, state/execution split.
- `pi-durable` — Pi Durable 1.5 runtime patterns (services, console, subagents, evolution, version boundary) plus this repo's engine map.
- `pig-cloudflare-runner` — Worker/DO host, alarms, deployment, runner protocol, remote tools.
- `pig-github-git-safety` — GitHub App contract, handlers, review/release invariants, Git safety.
- `pig-testing-debugging` — commands, test harnesses, known failures, verification checklists.

Keep skills in sync when architecture, deployment, or debugging knowledge changes.

## Invariants

- Webhooks must be verified from the raw body with `X-Hub-Signature-256` before parsing.
- Admission must commit the delivery record, command record, repository chain, and job task atomically before the webhook returns `202`.
- Keep delivery/command idempotency keys stable. Replaying a delivery must not start work twice.
- Agent jobs must stay serialized per repository through the durable job chain. Control jobs must bypass the chain.
- Use `pi-durable` tasks, conversations, and documents for all durable state. Do not add a parallel queue or lease layer.
- One process or Durable Object owns one `pi-durable` storage. Do not open the same database from multiple app processes.
- Persist checkpoints for irreversible steps: the release plan before creating a tag, the pushed commit before PR finalization, and the review URL after posting a review.
- Agent conversations are owned by their job task, one per attempt. Reuse the stored conversation and request ID when resuming the same attempt.
- Do not pass `PIG_*`, `GITHUB_*`, `GH_*`, model provider keys, or unrelated host secrets to agent shell commands. Use `buildShellEnvironment` and `createBashTool({ prepare })`.
- Review conversations get no shell and may write only `.pig/review.json` through `ReviewTools`.
- Host Git operations must not run repo hooks or credential helpers; use the existing `runGit` path and reset local config after agent work. Never construct a push URL with a token in it.
- Never push to the default branch or force-push an existing PR head branch. Only PiG-named deterministic work branches (`new`, `patch`) may be force-pushed.
- Every work and review job is anchored to a real GitHub issue or PR; release and control jobs are repository-scoped. PiG may create the anchor itself as a checkpointed, marker-idempotent step, and that is the only issue PiG creates on its own.
- The work write target (`new`, `head`, `patch`) is explicit in the command. The agent never chooses a branch, base, force, or target PR; a target is never inferred from instructions.
- A command from outside GitHub carries only a claimed actor. Verify that login's repository permission with the GitHub API; an external console holds no GitHub credential and its token never authorizes a job.
- Console dispatch is at least once: the worker deduplicates by dispatch key at admission. Never add a second queue, lease, or ack layer, and never resolve an unknown outcome by resending blindly. An unknown outcome is a dispatch-key lookup.
- A worker's transport is declared (inbound or outbound), never negotiated. Console pending records are delivery attempts, not authoritative state; the consumed cursor lives on the worker.
- An operator console is a separate application with its own storage and never shares a database with a worker. Registration requires an explicit one-time enrollment token; reachability never registers a worker. The console knows workers only through their capability declaration.
- The Cloudflare orchestration path must not execute coding tasks or model calls. It may share Worker-compatible modules with full mode, but must not use the local Node workspace, `git.ts`, or `NodeExecutionEnv`.
- The Cloudflare full mode uses the same `pig.job` task, remote workspace, and remote tools as the coding path. Its coding tools go through the authenticated runner, never through a local `ExecutionEnv`.
- Map `harness.wake()` and stored task deadlines to the Durable Object alarm. Alarms are at-least-once; keep admission and task phases idempotent.
- One Durable Object owns one repository storage. Do not open the same DO SQLite from another process.
- Keep `PIG_TABLE_PREFIX` stable; changing it does not migrate existing state.
- Remote workspace IDs must include the repository and task ID; never key runner checkouts by task ID alone across repositories.
- The runner authenticates with `PIG_RUNNER_TOKEN`, validates every path inside the checkout, uses the sanitized shell environment, and receives only short-lived GitHub installation tokens for clone/push.
- Do not send model provider keys, the App private key, or admin secrets to the runner or its shell.
- The runner is a trusted execution host. Keep it behind HTTPS and isolate it from unrelated secrets and data.
- Persist one progress comment per job and edit it; do not add a comment per attempt.
- Revert `.github/workflows/**` edits when workflow changes are not allowed.
- Keep user-facing behavior documented in `ARCHITECTURE.md`, not in code comments.

## Code style

- Descriptive function and variable names; split logic into small named helpers.
- Avoid comments that restate code. Comment only non-obvious reasons.
- Prefer pure functions and explicit parameters over global mutable state.
- TypeScript strict mode is on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Add tests for command parsing, webhook planning, admission/idempotency, job-task retries/cancellation, orchestration admission/alarms, WebCrypto verification, the runner and remote workspace/tools, diff line mapping, semver/release grouping, model resolution, shell-env sanitization, and result parsing when those change.
- Durable integration tests should use `MemoryStorage`, faux providers, and local bare Git repositories; they must not need GitHub or model credentials.
