# PiG

**Pi-durable In GitHub.** A durable GitHub App that makes pull requests, reviews code, and manages releases with [Pi](https://pi.dev).

Comment `@pig` on an issue or pull request. PiG queues a durable job, runs Pi in a throwaway checkout, and reports back on GitHub:

- **Work** — implement an issue and open a PR, or push a fix to the current PR branch.
- **Review** — post a structured review with inline findings on the changed lines.
- **Release** — infer or choose a version, tag the default branch, and publish grouped release notes.
- **Status / Cancel** — inspect or stop the repository's jobs.

Every job survives restarts, webhook redeliveries, and retried attempts. See [ARCHITECTURE.md](ARCHITECTURE.md) for the product contract and safety rules.

## Requirements

- Node.js 24+ (uses built-in `node:sqlite` and TypeScript type stripping)
- Git
- A GitHub App with a private key and webhook secret
- Pi installed and authenticated with a model provider

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
pi            # then run /login
```

Alternatively set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or another provider variable in `.env`.

## Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

Use these settings:

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
| `PIG_DATABASE_PATH` | `./data/pig.sqlite` | durable job database |
| `PIG_WORKSPACE_ROOT` | `./data/workspaces` | throwaway checkouts |
| `PIG_MODEL` | Pi default | e.g. `sonnet:high` |
| `PIG_THINKING` | Pi default | `off`, `low`, `medium`, `high`, … |
| `PIG_PI_BIN` | `pi` | Pi executable |
| `PIG_MAX_CONCURRENCY` | `2` | concurrent jobs across different repositories |
| `PIG_JOB_TIMEOUT_MINUTES` | `30` | hard agent timeout cap |
| `PIG_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `PIG_ADMIN_TOKEN` | unset | enables authenticated job inspection endpoints |

Model credentials are supplied to Pi through provider environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, …). The server passes only provider variables and basic process variables to the agent; it strips `PIG_*`, `GITHUB_*`, and `GH_*`.

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

The included Dockerfile runs the server as a non-root user, installs Git, and pins Pi `1.5.0`.

```bash
cp .env.example .env
# Set PIG_GITHUB_PRIVATE_KEY_PATH inside .env, then mount the key into the container:
docker compose up --build -d
```

`compose.yaml` maps port `8787` and persists `/data` in a named volume. For the private key, either:

- mount the `.pem` and set `PIG_GITHUB_PRIVATE_KEY_PATH=/run/secrets/pig.pem`, or
- put the full key in `PIG_GITHUB_PRIVATE_KEY` with `\n` escapes.

Put the service behind HTTPS (reverse proxy, ingress, or a platform load balancer), then point the GitHub App webhook at the public URL. Set `PIG_MAX_CONCURRENCY` conservatively: each agent can use substantial CPU, memory, and network.

The SQLite database and workspace directory live under `/data`. Workspaces are deleted after each job; the database and its WAL files are the durable state.

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
| `@pig cancel` | Cancel queued jobs and abort the running job. |
| `@pig help` | Usage reminder. |

`/pig` works as an alias.

Automatic review runs on PR open, reopen, synchronize, and ready-for-review. It is deduplicated per head SHA, skips drafts, and never reviews PiG's own PRs.

## Repository configuration

Add `.pig.yml` on the default branch:

```yaml
version: 1

agent:
  model: sonnet:high
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

- **Webhook dedupe** — GitHub delivery IDs are stored; replays are ignored.
- **Idempotent commands** — one job per comment/event, enforced by a unique key.
- **Leases and heartbeats** — a crashed worker's job is requeued after its lease expires.
- **Checkpoints** — a release plan is recorded before the tag is created, a pushed commit is recorded before PR bookkeeping, and a posted review URL is recorded when the review succeeds. Retries resume instead of rebuilding.
- **Per-repository serialization** — one agent job per repository prevents branch and release races. Control commands bypass the lock.
- **Progress comments** — one comment per job, edited in place.
- **Graceful shutdown** — active attempts are aborted and requeued without burning an attempt.

## Operations

- `GET /healthz` — liveness and uptime.
- `GET /api/jobs?repo=owner/name&limit=20` — requires `Authorization: Bearer $PIG_ADMIN_TOKEN`.
- `GET /api/jobs/:id` — job record plus event log; same auth.
- Logs go to stdout/stderr. Job logs include event history for the last 200 events per job.
- Back up `PIG_DATABASE_PATH` (and its WAL) together with the `/data` volume. Stop the process or use a SQLite-consistent backup.
- To rotate the App key or webhook secret: update the environment, restart, and update GitHub App settings.

SQLite and the workspace directory must be local to one host. Several workers on that host can share the database through leases; do not put the SQLite file on a network filesystem.

## Security

PiG is an automation tool, not a sandbox boundary.

- Repository content, issues, PR bodies, and review comments are untrusted input. Prompt injection is possible. The agent is instructed to treat repo text as data, but that is not a guarantee.
- Work jobs deliberately give the agent shell and network access so it can run tests and inspect a project. A malicious repository could read anything the PiG process can read.
- Model provider keys are passed to the agent because Pi needs them. Use a dedicated model key with a budget, and do not co-locate unrelated secrets on the host.
- The GitHub App private key, webhook secret, admin token, and installation token are not passed to the agent's environment. Git uses a short-lived askpass file around host operations, with hooks and credential helpers disabled and the local Git config reset after the agent exits.
- Run PiG in a container or dedicated host, as a non-root user, with only the data volume mounted. Restrict egress if your threat model requires it.
- Keep App permissions minimal and install PiG only on trusted repositories.
- PiG never pushes to the default branch, never force-pushes an existing PR branch, and reverts workflow-file edits unless explicitly allowed.

## Development

```bash
npm ci
npm run check      # typecheck + tests
npm run build      # compile to dist/
npm run dev        # run TypeScript directly with Node type stripping
```

Layout:

```
src/
  agent/        Pi subprocess runner and result contracts
  github/       App auth, repository metadata, .pig.yml loading
  jobs/         SQLite store, worker, durable job handlers
  webhooks/     signature verification, command parsing, event routing
  diff.ts       unified diff indexing and inline-line validation
  semver.ts     version handling and release-note grouping
  server.ts     HTTP/webhook/admin server
test/           node:test coverage for the pure logic and queue
```

## License

MIT
