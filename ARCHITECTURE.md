# PiG — Architecture and Product Specification

PiG (Pi-durable In GitHub) is a GitHub App that runs durable AI coding jobs with [Pi](https://pi.dev). It is built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable): every job, agent conversation, model turn, tool call, and app checkpoint is committed to storage before it is shown or acted on. GitHub is the entire user interface: install the app, mention it in a comment, and it opens pull requests, reviews code, or releases a version.

This document specifies observable behavior. Implementation choices live in the code; product rules that must not drift live here.

## 1. Actors and trust boundaries

- **Installer / operator** owns the GitHub App, server, model credentials, and durable database. They install PiG on selected repositories.
- **Repository writers** (`admin`, `maintain`, `write`, or `push` permission) may use PiG in that repository. A repository may also allow extra GitHub logins through `.pig.yml`.
- **Repository readers and strangers** cannot start jobs. PiG verifies permission server-side before running anything, even when the comment came from a seemingly trusted association.
- **GitHub** is the source of truth for repository content, pull requests, reviews, tags, and releases.
- **Pi** is the reasoning engine. It runs as durable conversations inside the PiG process. Agent tools are selected per job and receive a restricted environment and filesystem view appropriate to their kind.

A public repository with the app installed may receive mention comments from anyone. Such comments become durable admission records and tasks, are authorized, denied, and answered cheaply, and never reach an agent conversation unless the author has write access (or is explicitly allowed by `.pig.yml`).

## 2. Invocation surface

Users interact by commenting on an issue or pull request:

| Command | Effect |
| --- | --- |
| `@pig <anything>` | Work request: change code and open/update a pull request |
| `@pig fix <instructions>` | Same as above, explicit work request |
| `@pig review [focus]` | Review the current pull request, optionally focusing on a topic |
| `@pig release [auto\|major\|minor\|patch\|<version>]` | Tag the default branch and publish a GitHub Release |
| `@pig status` | Show recent durable jobs for the repository |
| `@pig cancel` | Cancel queued/waiting/sleeping jobs and stop the running job |
| `@pig help` | Show usage |

`/pig` is accepted as an alias for `@pig`. Commands are case-insensitive. A bare `@pig` shows help. Review and release flags: `--draft`, `--prerelease`.

Automatic behavior:

- **Automatic review** is queued when a pull request is `opened`, `reopened`, `synchronize`d, or marked `ready_for_review`.
- Draft pull requests are skipped when `review.skip_drafts` is true.
- Pull requests authored by PiG itself are never auto-reviewed, preventing feedback loops.
- A review event is deduplicated by repository, pull request number, and head SHA. `ready_for_review` has its own key so a draft PR can still be reviewed when it becomes ready at the same SHA.
- A stale automatic review (head SHA changed before it ran) is skipped because a newer event supersedes it.

PiG never edits a pull request body to add reviews, and never approves by default.

## 3. Durable job contract

PiG uses one `pi-durable` Harness over one SQLite storage per host session. On the Node host, one process owns the database. On Cloudflare, one Durable Object owns one repository database. `pi-durable` has no cross-process locking. The Harness is resumed on startup or Durable Object start, which recovers tasks that were cut off by a crash, shutdown, hibernation, or host failure.

### Admission

Every webhook is verified from its raw body with `X-Hub-Signature-256`, parsed, and then admitted in one durable commit before GitHub receives its acknowledgement:

- A **delivery record** keyed by the GitHub delivery ID makes replays duplicates.
- A **command record** keyed by the stable command key makes repeated commands idempotent. A duplicate command reuses the original job task.
- A **repository record** tracks the tail of the per-repository job chain.
- A **job task** and its **job document** are created atomically with those records.

Ignored events (no mention, bot author, unsupported action) also record their delivery so a replay is a duplicate and no work is repeated.

### Task, conversation, and state

- Each command is a durable `pig.job` task with an input, phase checkpoint, attempt budget, and terminal outcome.
- A work or review job creates one **agent conversation per attempt**, owned by the job task. The conversation stores its model, thinking level, working directory, tool selection, instructions, transcript, and live task state.
- One **job document** per task stores status, the handler checkpoint, progress-comment ID, agent conversation ID, attempt number, summary, error, and a bounded event log. It survives the task's terminal state.
- Task-scoped documents are not used for job history because `pi-durable` retires them when the task ends.

### Ordering and concurrency

- Agent jobs for one repository run in admission order. Each new job task waits on the previous agent job task for that repository before doing work. A terminal, failed, or cancelled predecessor does not block the successor.
- Control jobs (`status`, `help`, `cancel`) bypass the repository chain so cancellation and inspection remain responsive. They still require authorization.
- Different repositories may run concurrently. There is no global concurrency cap in v1; the operator limits concurrency by limiting repositories and host resources.

### Retries and recovery

- A retryable failure ends the job phase `sleeping` with exponential backoff (15s, 30s, 60s, capped at 120s) and an incremented attempt. The task resumes at its checkpoint.
- Permanent failures and exhausted attempts end the task with a failed outcome and a visible error.
- A crash or process shutdown leaves the task and its conversation durable. Reopening the storage resumes the task and the agent run. Completed tool calls and turns are not repeated; an in-flight model request is treated as a failed attempt under Pi's retry policy.
- `pi-durable`'s restart limit bounds crash loops. A task that keeps cutting off its process ends instead of running forever.
- A workspace is reused within one attempt so a resumed conversation finds its files. A new attempt gets a fresh checkout.

### Cancellation

- `@pig cancel` aborts live job tasks for the repository except the cancel command itself. A job that is pending, running, waiting, or sleeping is abort-marked.
- Aborting a job cascades to its owned agent conversation, then runs the job's abort handler in a fresh invocation. The handler posts a cancellation comment and commits an aborted outcome.
- A cancelled job's successor in the repository chain proceeds.

### Checkpoints

Handlers persist checkpoints for irreversible steps:

- A work PR update records the pushed commit before PR bookkeeping.
- A review records the posted review URL after the review succeeds, and also detects a review already posted by PiG for the same head commit before posting again.
- A release records the planned tag, target commit, version, notes, and draft/prerelease flags before creating external state.

Retries resume from the checkpoint rather than rebuilding completed work.

### Progress reporting

- Work, manual review, release, and control jobs post one progress comment, then edit it instead of adding comments.
- Automatic reviews are silent until the review is posted.
- Failures update the progress comment with the actionable error; automatic reviews fail silently to avoid noise on every push.
- Job status, request, events, and progress-comment ID are available to the operator over an authenticated admin endpoint.

## 4. Work requests

A work request targets an issue or a pull request.

**On an issue**:

- PiG checks out the default branch into an attempt-specific workspace, creates a branch under the configured prefix, runs the agent, commits, pushes, and opens a pull request.
- The branch name is deterministic for the job, so retries update the same branch with a force push.
- The PR body closes the issue (unless the agent already wrote a closing reference) and credits the requester.
- If the agent changes nothing, no branch or PR is created and the progress comment says so.
- Closed issues are rejected.

**On a pull request**:

- PiG only updates same-repository head branches. Fork branches are rejected with an explanation, because the installation token cannot push to the fork.
- PiG commits to the existing head branch without force-pushing. A rejected non-fast-forward push fails and may be retried.
- Closed or merged pull requests are rejected.
- If the agent changes nothing, no commit is pushed.
- Review-thread commands include the file, line, and inline comment as context.

**Agent constraints**:

- The agent works in a throwaway checkout. It must not commit, amend, rebase, push, create pull requests, touch `.git/`, or use `.pig/` except for its result file.
- PiG, not the agent, commits and pushes.
- Workflow file changes (`.github/workflows/**`) are reverted before commit unless `work.allow_workflow_changes` is true and the GitHub App has the Workflows permission. The PR body/comment records any reverted files.
- The PR title/body and commit message come from the agent's structured result when available; PiG falls back to the issue title and final agent message.
- No pull request is opened for an empty change set.

## 5. Reviews

- The pull request head is checked out read-only. The review agent can read files and write only `.pig/review.json`; it has no shell.
- PiG supplies the unified diff, PR metadata, changed-file stats, and an optional inline-comment focus. The agent can inspect surrounding code by reading files.
- Findings are structured, with file path, line, side (`RIGHT` for new lines, `LEFT` for removed lines), severity (`blocker`, `issue`, `nit`), and Markdown body.
- Only findings that map to a real line in the diff are posted inline. Others are listed in the review body with a reason.
- Duplicate findings are removed. Inline findings are capped by `review.max_findings`.
- If GitHub rejects inline comments, PiG retries as a single review body. A review is never partially lost.
- Default verdict is `COMMENT`. `REQUEST_CHANGES` is only emitted according to `review.request_changes_on` (`blocker`, `any`, or `never`). `APPROVE` is only possible when `review.allow_approve` is true and there are no findings.
- Reviews are posted against the live head commit. Automatic reviews whose recorded SHA no longer matches are skipped, not posted against stale code.

## 6. Releases

- A release targets the repository's default branch.
- Only semantic versions under `release.tag_prefix` are considered. Comparison follows semver, including prerelease ordering.
- Version selection:
  - `auto`: infer from merged PRs since the last tag using labels and conventional-commit titles (`!`/breaking labels → major, `feat`/feature labels → minor, otherwise patch). First release is `0.1.0`, or `1.0.0` if breaking.
  - `major` / `minor` / `patch`: bump the latest release version.
  - Exact version: used as-is; versions below the latest are rejected.
- Merged pull requests are collected from GitHub, excluding PRs labeled `skip-changelog`, `no-changelog`, or `release-skip`, internal `chore(release)` PRs, and PRs merged into other branches.
- Notes group PRs into Breaking Changes, Features, Fixes, Performance, Documentation, Maintenance, and Other Changes. The notes include a compare link to the previous tag and may carry a truncation notice for very large histories.
- Releasing creates a lightweight tag at the default branch head and a GitHub Release. Draft and prerelease flags are honored from the command or `.pig.yml`.
- Releases are idempotent:
  - An existing release for the target tag is reported, not duplicated.
  - An existing tag without a release gets the missing release.
  - A retry reuses the checkpointed tag/notes/commit and re-checks GitHub state.
- If there are no merged PRs for a new version, nothing is released.
- No package registry publishing, asset upload, or version-file commit happens in v1. Tag and release only.

## 7. Repository configuration

`.pig.yml` on the default branch tunes behavior. An absent file means all defaults. Invalid values produce warnings and fall back per-field. The file is read no more than once per five minutes per repository.

```yaml
version: 1

agent:
  model: anthropic/claude-sonnet-4-5  # optional; overrides PIG_MODEL
  thinking: high                      # optional; overrides PIG_THINKING
  timeout_minutes: 30                 # capped by the operator's PIG_JOB_TIMEOUT_MINUTES

review:
  auto: true
  skip_drafts: true
  request_changes_on: blocker   # blocker | any | never
  allow_approve: false
  max_findings: 30              # 1..50

work:
  branch_prefix: pig/           # must end in /
  allow_workflow_changes: false

release:
  tag_prefix: v
  draft: false

permissions:
  allow: []                     # extra GitHub logins allowed without write access
```

Configuration is trusted only from the default branch. A PR cannot change PiG's behavior until it is merged.

## 7.1 Deployment hosts

PiG has one durable job model and two hosts.

**Node host (full):**

- One process owns one SQLite storage.
- The HTTP server verifies webhooks from the raw body with `node:crypto`.
- Work, review, release, and control jobs run with Node execution tools, local Git operations, and model calls.
- Retry sleeps use the harness's timers. A graceful shutdown leaves unfinished tasks durable for the next process.

**Cloudflare host (experimental):**

- A Worker verifies webhooks with WebCrypto and routes each repository to its own Durable Object.
- The Durable Object owns `pi-durable` SQLite storage and the `pig.job` task. It hibernates while idle and uses its alarm to wake for stored task deadlines and in-flight work.
- Without a coding runner, it runs as an **orchestration host**: control and release jobs work, manual work/review commands become a notice, automatic reviews are ignored, and no model calls are made.
- With `PIG_RUNNER_URL` and `PIG_RUNNER_TOKEN`, it runs in **full mode**: work and review jobs run with the same handlers as the Node host. The Durable Object owns state, orchestration, model calls, reviews, releases, progress comments, and GitHub output. Agent file/shell/Git tools execute on the runner through a remote workspace.
- State and admin listing are partitioned per repository. One repository is one Durable Object and one storage owner.
- Agent state stays in the DO; the runner holds only an ephemeral checkout and performs tool calls. The runner is not a second durable-state owner.

**Remote coding runner:**

- A separate trusted Node service, started with `npm run runner`.
- Authenticates callers with `PIG_RUNNER_TOKEN`.
- Creates one checkout per job attempt under a persistent workspace root and reuses it for the same attempt.
- Implements file read/write/edit/list, shell execution, changed paths, workflow reverts, commit, push, reset, and cleanup.
- Receives short-lived GitHub installation tokens for clone/push; it never receives model provider keys or the App private key.
- Treat it as an execution host with the same trust level as the Node host's agent tools. Isolate it from unrelated secrets and data.

Both hosts share command planning, admission records, job documents, per-repository chaining, retries, cancellation, checkpoints, and progress comments. The orchestration-only mode uses a separate `pig.orchestration` task so it does not execute coding or model work; Worker-compatible code may still be bundled for full mode.

## 8. Safety and isolation

- Webhooks require a valid `X-Hub-Signature-256` HMAC. Unsigned or stale deliveries are rejected before parsing. The Node host uses `node:crypto`; the Cloudflare Worker uses WebCrypto.
- Authorization happens server-side per job. `.pig.yml` may grant named users, but only writers can change that file on the default branch.
- PiG never pushes to the default branch and never force-pushes an existing pull request branch. It force-pushes only its own deterministic `pig/*` branch for issue work.
- Host Git operations use a short-lived askpass file created around the operation and removed afterwards. Hooks and credential helpers are disabled; the local Git config is reset after agent work; pushes use an explicit repository URL.
- Agent shell commands receive a minimal environment: system basics, `CI`, and Git no-prompt guards. `PIG_*`, `GITHUB_*`, `GH_*`, model provider keys, and unrelated host secrets are not inherited. The remote runner applies the same environment to its shell tool.
- The Cloudflare runner is authenticated by `PIG_RUNNER_TOKEN`, must be behind HTTPS, and executes agent work in its own per-job checkouts. It receives short-lived GitHub installation tokens only; model and App credentials stay out of runner tool environments.
- Review agents have no shell and may write only `.pig/review.json`.
- The in-process agent can still read files the PiG process can read. Run PiG in a container or dedicated host, as a non-root user, with only the data volume mounted.
- The agent's process group is cleaned up when a bash tool call exits.

## 9. Limits and non-goals (v1)

- Single GitHub host (github.com); GitHub Enterprise Server is not configured.
- One process or Durable Object owns one `pi-durable` SQLite storage. There is no cross-process locking or horizontal scaling. High availability comes from restart/hibernation and durable resume, not from replicas.
- The Cloudflare full mode still needs a runner execution host; state is serverless, execution is not part of the Durable Object.
- The Cloudflare host runs work/review only in full mode, which requires the separate coding runner. Without it, coding commands are notices.
- The app depends on an **experimental** `pi-durable` API. Upgrades may require data migrations; PiG pins an exact version.
- No web dashboard. GitHub comments, reviews, releases, the status command, and the admin endpoint are the interface.
- The Cloudflare host has no global admin listing across repository Durable Objects.
- No package publishing, deployment automation, merge queues, or issue triage.
- No continuation of the same Pi conversation across separate commands. Every job attempt starts a fresh conversation, while a crash within an attempt resumes it.
- Automatic review is one pass; PiG does not re-review its own fixes explicitly.
- Repository configuration cannot install extensions or arbitrary commands for the agent.
- Durable delivery and command records grow with webhook history; v1 does not prune them.
