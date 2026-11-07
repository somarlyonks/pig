# PiG

Guidance for agents working in this repository. The product contract is [ARCHITECTURE.md](ARCHITECTURE.md); keep behavior there in sync when changing user-visible behavior.

## Commands

```bash
npm ci
npm run check       # typecheck + node:test
npm run build       # tsc to dist/
npm run dev         # node --watch src/main.ts
```

Tests use `node --test` with Node's TypeScript type stripping. Import source files with explicit `.ts` extensions; `rewriteRelativeImportExtensions` converts them on build.

## Layout

- `src/main.ts` — startup, shutdown, wiring.
- `src/server.ts` — HTTP routes: webhook, health, admin.
- `src/webhooks/` — raw-body signature verification, command parsing, dispatch to durable jobs.
- `src/jobs/` — SQLite store, worker (leases/retries/cancellation), handlers for work/review/release/control.
- `src/agent/` — Pi subprocess execution, environment allowlist, result file parsing.
- `src/git.ts` — host Git operations, askpass lifecycle, workflow guard, config reset.
- `src/github/` — App clients, repository metadata, `.pig.yml` loading.
- `src/diff.ts`, `src/semver.ts` — pure helpers with unit tests.

## Invariants

- Webhooks must be verified from the raw body with `X-Hub-Signature-256` before parsing.
- Authorization is server-side per job. Never move it into comment parsing or the webhook handler alone.
- Do not pass `PIG_*`, `GITHUB_*`, or `GH_*` variables to the Pi agent. Use the allowlist in `src/agent/runner.ts`.
- Host Git operations must not run repo hooks or credential helpers; use the existing `runGit` path and reset local config after agent work. Never construct a push URL with a token in it.
- Never push to the default branch or force-push an existing PR head branch. Only the deterministic PiG branch may be force-pushed.
- Every externally visible command must become a durable job before the webhook returns. Keep idempotency keys stable.
- Persist checkpoints for irreversible steps: the release plan before creating a tag, the pushed commit before PR finalization, and the review URL after posting a review.
- Persist one progress comment per job and edit it; do not add a comment per attempt.
- Revert `.github/workflows/**` edits when workflow changes are not allowed.
- Keep user-facing behavior documented in `ARCHITECTURE.md`, not in code comments.

## Code style

- Descriptive function and variable names; split logic into small named helpers.
- Avoid comments that restate code. Comment only non-obvious reasons.
- Prefer pure functions and explicit parameters over global mutable state.
- TypeScript strict mode is on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Add tests for command parsing, diff line mapping, semver/release grouping, queue semantics, webhook dispatch, and result parsing when those change.
