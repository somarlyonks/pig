# PiG

**Pi-durable In GitHub.** A durable GitHub App that makes pull requests, reviews code, and manages releases with [Pi](https://pi.dev), built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).

Comment `@pig` on an issue or pull request. PiG admits a durable task, runs a durable Pi conversation in a throwaway checkout, and reports back on GitHub:

- **Work** — implement an issue and open a PR, or push a fix to the current PR branch.
- **Review** — post a structured review with inline findings on the changed lines.
- **Release** — infer or choose a version, tag the default branch, and publish grouped release notes.
- **Status / Cancel** — inspect or stop the repository's jobs.

Jobs, conversations, tool calls, checkpoints, and admission records live in `pi-durable` storage. If the process stops mid-run, reopening the same SQLite file resumes the workflow and the agent run from its last durable checkpoint. See [ARCHITECTURE.md](ARCHITECTURE.md) for the product contract.

> `@earendil-works/pi-durable` is experimental and its API changes between releases. PiG pins `1.5.0`; treat upgrades as migrations.

## Requirements

- Node.js 24+ (the Node host and `pi-durable` both require a modern Node)
- Git for the Node host
- A GitHub App with a private key and webhook secret
- Credentials for a model provider that Pi's `pi-ai` supports for work/review
- Optionally, a Cloudflare account and Wrangler for the serverless orchestration host

The app embeds `pi-durable` and `pi-ai`; it does **not** run the `pi` CLI and does **not** use the CLI's `/login` session state. Configure model credentials with provider environment variables.

## Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Setting | Value |
| --- | --- |
| Webhook URL | `https://<your-host>/api/github/webhooks` |
| Webhook secret | a long random string; copy it to `PIG_WEBHOOK_SECRET` |
| Homepage URL | anything, e.g. your repository URL |
| Request user authorization | off |
| Install app for | only the repositories you trust PiG with |

**Repository permissions**:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | mandatory |
| Contents | Read and write | clone, branches, tags, releases |
| Issues | Read and write | progress comments, linking issues |
| Pull requests | Read and write | PRs, reviews, inline comments |
| Workflows | No access (default) | optional; see the workflow guard |

**Subscribe to events**:

- Issue comment
- Pull request
- Pull request review comment

After creating the app:

1. Note the **App ID** → `PIG_GITHUB_APP_ID`.
2. Generate and download a **private key** → `PIG_GITHUB_PRIVATE_KEY_PATH` (or inline `PIG_GITHUB_PRIVATE_KEY`).
3. Note the app slug from `https://github.com/apps/<slug>` → `PIG_APP_SLUG` (default `pig`).
4. Install the app on your repositories.

PiG never pushes to the default branch. It needs Contents write for feature branches, tags, and releases. If you want PiG to change CI workflows, grant the Workflows permission **and** set `work.allow_workflow_changes: true`; otherwise its workflow edits are reverted before commit.

## Configure

```bash
cp .env.example .env
```

Required:

| Variable | Meaning |
| --- | --- |
| `PIG_GITHUB_APP_ID` | GitHub App ID |
| `PIG_GITHUB_PRIVATE_KEY_PATH` | path to the `.pem` key, or use inline `PIG_GITHUB_PRIVATE_KEY` |
| `PIG_WEBHOOK_SECRET` | the App's webhook secret |

Common:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIG_APP_SLUG` | `pig` | app slug; used for `@pig` mentions and bot self-detection |
| `PIG_PORT` | `8787` | webhook/HTTP port |
| `PIG_DATABASE_PATH` | `./data/pig.sqlite` | durable `pi-durable` storage (tasks, conversations, docs) |
| `PIG_WORKSPACE_ROOT` | `./data/workspaces` | throwaway checkouts |
| `PIG_TABLE_PREFIX` | `pig_` | SQLite table prefix; keep it stable once data exists |
| `PIG_MODEL` | first available model | `provider/modelId`, a bare/fuzzy model id or name, or either with `:thinking` |
| `PIG_THINKING` | model default / suffix | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `PIG_JOB_TIMEOUT_MINUTES` | `30` | hard cap for one agent run |
| `PIG_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `PIG_ADMIN_TOKEN` | unset | enables authenticated job inspection endpoints |

Model credentials are read by `pi-ai` from the process environment. Typical keys are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and provider-specific Amazon Bedrock or Vertex AI variables. See [Pi's provider documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#environment-variables).

`PIG_MODEL` accepts a provider-qualified reference (`anthropic/claude-sonnet-4-5`), a bare or fuzzy model id/name, and an optional `:thinking` suffix (`sonnet:high`). Without a configured model, PiG uses the first model whose provider has credentials. Repository `.pig.yml` overrides `PIG_MODEL` per repository.

> **One process owns one storage file.** `pi-durable` has no cross-process locking. Run one PiG instance per `PIG_DATABASE_PATH`; put it behind a supervisor or container restart policy. Do not share the SQLite file over a network filesystem.

## Run locally

Terminal 1:

```bash
npm ci
npm run dev
```

The server listens on `http://localhost:8787`.

Terminal 2 — GitHub must reach the App's webhook URL, so use a public HTTPS tunnel while developing:

```bash
cloudflared tunnel --url http://localhost:8787
# or: ngrok http 8787
```

Set the GitHub App's Webhook URL to the tunnel URL plus `/api/github/webhooks`. GitHub sends a `ping` on save; PiG answers `202`.

`gh webhook forward` targets repository webhooks, not App-level webhooks, so it does not replace the App webhook URL for this app.

Install the App on a test repository and try:

```text
@pig add tests for the parser edge cases
@pig review
@pig status
```

## Deploy

The included Dockerfile builds the app with its embedded `pi-durable` runtime, runs as a non-root user, and needs only Git and CA certificates at runtime.

```bash
cp .env.example .env
# Set PIG_GITHUB_PRIVATE_KEY_PATH inside .env, then mount the key into the container:
docker compose up --build -d
```

`compose.yaml` maps port `8787` and persists `/data` in a named volume. For the private key, either:

- mount the `.pem` and set `PIG_GITHUB_PRIVATE_KEY_PATH=/run/secrets/pig.pem`, or
- put the full key in `PIG_GITHUB_PRIVATE_KEY` with `\n` escapes.

Put the service behind HTTPS, then point the GitHub App webhook at the public URL. Because one process owns the storage, run exactly one replica per database.

The SQLite database and workspace directory live under `/data`. Workspaces are cleaned up after terminal jobs; the database is the durable state. Back it up with its WAL files while the process is stopped, or use a SQLite-consistent snapshot.

## Serverless Cloudflare host (experimental)

PiG also ships a Cloudflare Worker + Durable Object host. It follows the model from [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/): the Worker receives webhooks, and one Durable Object per repository owns the `pi-durable` SQLite state, the job tasks, and the alarm that wakes the object for retries and in-flight work. No always-on server is required.

It has two modes:

- **Orchestration only** — without a coding runner, control and release jobs work. Manual work/review commands become a control notice, automatic reviews are ignored, and no model calls are made.
- **Full** — with a coding runner configured, work and review also run. The Durable Object owns state, orchestration, model calls, and GitHub output; a separate trusted Node **runner** executes the checkout, files, shell, and Git. This is the state/execution split from Pi Durable.

### Full mode setup

Start a runner somewhere with Git, a persistent workspace volume, and outbound access to GitHub and your Worker:

```bash
PIG_RUNNER_TOKEN="a-long-random-token" \
PIG_RUNNER_WORKSPACE_ROOT="./data/runner" \
npm run runner
```

Or from the built image:

```bash
docker run -d --name pig-runner \
  -p 8790:8790 \
  -e PIG_RUNNER_TOKEN="a-long-random-token" \
  -e PIG_RUNNER_WORKSPACE_ROOT=/data/runner \
  -v pig-runner:/data/runner \
  pig-github-app node dist/runner/main.js
```

Put the runner behind HTTPS and keep its token secret. It executes arbitrary work jobs inside per-job checkouts, so treat it as a trusted execution host and isolate it from unrelated secrets and data.

Configure the Worker:

```bash
npm run cf:dry-run                 # bundle without deploying
npx wrangler secret put PIG_GITHUB_APP_ID
npx wrangler secret put PIG_GITHUB_PRIVATE_KEY   # paste the PEM, newlines escaped or raw
npx wrangler secret put PIG_WEBHOOK_SECRET
npx wrangler secret put PIG_ADMIN_TOKEN          # optional
npx wrangler secret put PIG_RUNNER_TOKEN         # same value as the runner
npx wrangler secret put PIG_RUNNER_URL           # https://runner.example
npx wrangler secret put ANTHROPIC_API_KEY        # or another provider key
# Optional: set PIG_MODEL / PIG_THINKING as Worker variables or secrets.
npm run cf:deploy
```

Point the GitHub App webhook at `https://<worker-host>/api/github/webhooks`. `PIG_APP_SLUG` and `PIG_TABLE_PREFIX` live in `wrangler.jsonc`; keep the prefix stable.

For local Worker development, put the same values in `.dev.vars` (ignored by Git), then run `npm run cf:dev`. For a local full-mode test, run the runner on `127.0.0.1:8790` and set `PIG_RUNNER_URL=http://127.0.0.1:8790` in `.dev.vars`.

The Durable Object copies common provider keys from Worker secrets into the isolate before creating models. Add more provider secrets to the copy list in `src/cloudflare/repo-do.ts` if your provider is not covered.

Admin routes require `PIG_ADMIN_TOKEN` and a repository, because state is partitioned per repository:

```text
GET /api/jobs?repo=owner/name&limit=20
GET /api/jobs/<id>?repo=owner/name
```

Limitations:

- Full mode needs the separate runner. Without it, work and review are notices, not jobs.
- The runner is an execution host, even if it is on-demand or idle most of the time. It is not a second source of durable state; the Durable Object owns state.
- Admin listing is per repository, not global.
- Cloudflare is still a hosted service; the host is serverless and hibernates, not “no cloud at all.”
- One repository is one Durable Object and one storage owner. Do not point two processes at the same DO storage.
- Enabling or disabling the runner changes the active task kind. Jobs from the other mode remain in storage but are not shown by the active admin view.

The Node host below remains the simplest full-featured single-process deployment.

## Commands

| Command | Behavior |
| --- | --- |
| `@pig <instructions>` | Work request. On an issue: open a PR. On a PR: push a fix to its branch. |
| `@pig fix <instructions>` | Same, explicit. |
| `@pig review [focus]` | Review the current PR. |
| `@pig release` | Infer the bump from merged PRs since the last tag. |
| `@pig release major\|minor\|patch` | Bump the latest semantic version. |
| `@pig release 1.2.3` | Exact version. `--draft` and `--prerelease` are accepted. |
| `@pig status` | Recent jobs, attempts, age, and error/result summary. |
| `@pig cancel` | Cancel queued/waiting/sleeping jobs and stop the running job. |
| `@pig help` | Usage reminder. |

`/pig` works as an alias.

Automatic review runs on PR open, reopen, synchronize, and ready-for-review. It is deduplicated per head SHA, skips drafts, and never reviews PiG's own PRs.

## Repository configuration

Add `.pig.yml` on the default branch:

```yaml
version: 1

agent:
  model: anthropic/claude-sonnet-4-5
  thinking: high
  timeout_minutes: 30

review:
  auto: true
  skip_drafts: true
  request_changes_on: blocker   # blocker | any | never
  allow_approve: false
  max_findings: 30

work:
  branch_prefix: pig/
  allow_workflow_changes: false

release:
  tag_prefix: v
  draft: false

permissions:
  allow: []                     # extra GitHub logins besides repo writers
```

Behavior details, defaults, and edge cases are specified in [ARCHITECTURE.md](ARCHITECTURE.md).

## How durability works

PiG has one durable model, supplied by `pi-durable`:

- **Admission** — a webhook delivery and its command are committed in one SQLite transaction. A replayed delivery is a duplicate; a repeated command key reuses the same task.
- **Task per command** — work, review, release, and control commands are durable `pig.job` tasks. Each task owns a phase state, retry budget, and app state.
- **Conversation per attempt** — a work or review agent runs as its own `pi-durable` conversation owned by the job task. Every turn, model request, and tool call is checkpointed before it is shown. A crash resumes the run instead of restarting the agent.
- **Per-repository chain** — agent jobs for one repository run in admission order by waiting on the previous job task. Control jobs bypass the chain.
- **Checkpoints** — pushed commits, posted review URLs, and release plans are recorded in durable state before dependent side effects, so retries resume rather than duplicate.
- **Retries** — transient failures end a phase `sleeping` with backoff; the task resumes at its checkpoint. A crash loop is bounded by `pi-durable`'s restart limit.
- **Cancellation** — `@pig cancel` aborts live repository tasks. Aborting a task cascades to its owned agent conversation and then runs the job's abort handler.
- **Progress comments** — one comment per job, edited in place. Automatic reviews stay silent unless they post a review.
- **Graceful shutdown** — closing the harness signals running phases. A phase that has not reached a terminal state remains durable and resumes when the process reopens the storage.
- **Serverless wakeups** — the Cloudflare host maps `harness.wake()` and stored task deadlines to the Durable Object alarm, so hibernate/wake replaces a resident timer.

## Operations

- `GET /healthz` — liveness, uptime, and active job count.
- `GET /api/jobs?repo=owner/name&limit=20` — requires `Authorization: Bearer $PIG_ADMIN_TOKEN`.
- `GET /api/jobs/:id` — job summary, request, events, and progress comment id; same auth.
- Logs go to stdout/stderr. `pi-durable` reports are logged with their task kind and error.
- Back up `PIG_DATABASE_PATH` (and its WAL) under `/data`. `PIG_TABLE_PREFIX` must stay unchanged.
- To rotate the App key or webhook secret: update the environment, restart, and update GitHub App settings.

## Security

PiG is an automation tool, not a sandbox boundary.

- Repository content, issues, PR bodies, and review comments are untrusted input. Prompt injection is possible. The agent is instructed to treat repo text as data, but that is not a guarantee.
- Work jobs give the agent file access and a shell so it can run tests and inspect a project. The shell receives a minimal environment: no `PIG_*`, `GITHUB_*`, `GH_*`, model keys, package registry tokens, or other host secrets. The agent can still read files the PiG process can read, including dotfiles and provider config on disk.
- Review jobs have no shell: they can read files and write only `.pig/review.json`.
- Model provider credentials stay in the PiG process for `pi-ai`; they are not placed in the agent's shell environment.
- The GitHub App private key, webhook secret, admin token, and installation token are not placed in the agent's shell environment. Git uses a short-lived askpass file around host operations, with hooks and credential helpers disabled and the local Git config reset after the agent exits.
- Run the Node host in a container or dedicated host, as a non-root user, with only the data volume mounted. Restrict egress if your threat model requires it.
- The Cloudflare host stores the App key and webhook secret as Worker secrets and verifies webhooks with WebCrypto. In orchestration mode the Durable Object has no shell or coding tools; in full mode the agent tools run only on the authenticated runner, while the Durable Object keeps state and model access.
- Keep App permissions minimal and install PiG only on trusted repositories.
- PiG never pushes to the default branch, never force-pushes an existing PR branch, and reverts workflow-file edits unless explicitly allowed.

## Development

```bash
npm ci
npm run check         # typecheck + Cloudflare typecheck + tests
npm run build         # compile the Node host to dist/
npm run dev           # run the Node host with Node type stripping
npm run cf:typecheck  # typecheck the Worker/Durable Object host
npm run cf:dry-run    # bundle the Worker without deploying
npm run runner        # run the trusted remote coding runner
```

Layout:

```
src/
  durable/      pi-durable app: Harness, job/orchestration tasks, admission, docs, models, tools, remote workspace/tools
  cloudflare/   Worker + per-repository Durable Object host, alarms, WebCrypto webhook verification
  runner/       trusted remote coding runner for Cloudflare full mode
  jobs/         GitHub job handlers (work, review, release, control) and contracts
  github/       App auth, repository metadata, .pig.yml loading
  webhooks/     signature verification, command parsing, webhook planning, repository extraction
  diff.ts       unified diff indexing and inline-line validation
  semver.ts     version handling and release-note grouping
  server.ts     HTTP/webhook/admin server
test/           node:test coverage, including MemoryStorage + faux-provider integration tests
```

Tests use `node --test` with Node's TypeScript type stripping. Import source files with explicit `.ts` extensions; `rewriteRelativeImportExtensions` converts them on build. Durable tests use `MemoryStorage`, faux providers, and local bare Git repositories, so they need no GitHub or model credentials.

## License

MIT
