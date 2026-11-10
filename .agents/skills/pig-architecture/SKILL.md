---
name: pig-architecture
description: Use when changing PiG's overall design, deployment model, job lifecycle, or deciding where durable state, model calls, and coding tools run. Covers the Node host, Cloudflare hosts, orchestration-only vs full mode, and the state/execution split.
---

# PiG architecture

PiG is a GitHub App built on `@earendil-works/pi-durable`. GitHub is the UI: comments become durable jobs that open PRs, post reviews, or publish releases.

Read `ARCHITECTURE.md` for the product contract and `README.md` for operator setup. This skill is the mental model for making changes.

## One engine, two hosts

| | Node host | Cloudflare host |
|---|---|---|
| Ingress | HTTP server | Worker |
| Durable storage | SQLite file, one process | SQLite inside a per-repository Durable Object |
| Scheduling | `pi-durable` timers | DO alarm + `onWake` |
| Full coding jobs | Yes, local tools | Yes, only with a remote runner |
| No-runner mode | n/a | `pig.orchestration`: control + release only |
| Model calls | In-process `pi-ai` | In the DO (`pi-ai`) |
| Coding tools | `NodeExecutionEnv` in-process | Authenticated remote runner |
| Deployment | `npm run dev`, Docker | `npm run cf:deploy`, Wrangler |

## Request flow

```
webhook
  -> verify HMAC
  -> plan @pig command
  -> one durable admission commit:
       delivery doc
       command doc
       repository chain doc
       job task
       job doc
  -> 202
  -> per-repository job chain
  -> authorize + load .pig.yml + progress comment + model
  -> for work/review: workspace (local or remote)
  -> agent conversation owned by the task
  -> GitHub side effects + checkpoints + progress comment
```

Control jobs bypass the per-repository chain. Work/review/release are chained.

## Where to change what

- Command parsing / webhook planning: `src/webhooks/commands.ts`, `src/webhooks/plan.ts`
- Admission, dedupe, repository chain: `src/durable/admission.ts`
- Host-neutral job lifecycle: `src/durable/job-task.ts`
- Workspace contract: `src/durable/workspace.ts`
- Node workspace: `src/durable/local-workspace.ts`
- Remote workspace/tools/protocol: `src/durable/remote-workspace.ts`, `remote-tools.ts`, `remote-runner.ts`
- Cloudflare hosts: `src/cloudflare/` and `src/durable/cloudflare-coding-runtime.ts`
- Console dispatch (worker side): `src/dispatch/` — planning, capabilities, dispatch keys, expiry
- Operator console (separate app): `src/console/` + `src/cloudflare/console/`, `wrangler.console.jsonc`
- Orchestration-only task: `src/durable/orchestration-task.ts`, `orchestration-runtime.ts`
- GitHub handlers: `src/jobs/handlers/`
- GitHub auth/metadata/config: `src/github/`
- Git safety: `src/git.ts`
- Diff mapping: `src/diff.ts`
- Semver/release notes: `src/semver.ts`

## Invariants

- Webhook signatures are checked from the raw body before parsing.
- Admission commits delivery, command, repository chain, task, and job doc atomically before returning `202`.
- One repository serializes agent jobs through the durable chain. Control jobs bypass it.
- One process or Durable Object owns one `pi-durable` storage. No parallel queue or lease layer.
- Agent jobs have one conversation per attempt, owned by the job task.
- Work/review jobs are anchored to a real GitHub issue or pull request; release and control jobs are repository-scoped. PiG may create an anchor itself (`anchor: auto`) as a marker-idempotent, checkpointed step. Anchor rules: `ARCHITECTURE.md` §3 "Anchoring".
- The work write target (`new` on an issue, `head` or `patch` on a PR) is explicit in the command. The agent only produces a change set; `branch`, `base`, `force`, and the target PR are PiG's deterministic decision. Force is legal only for PiG-named branches (`new`, `patch`).
- A console-originated command is identified by a dispatch key plus a claimed actor that must be re-verified against GitHub permissions. The console holds no GitHub credential; all GitHub access is PiG's installation token. Reply channel follows the origin: artifacts report on GitHub, informational commands answer in the console.
- Console dispatch is at least once and deduplicated by dispatch key at admission; pending console records are delivery attempts, not a queue. The consumed cursor lives on the worker. Transport (`inbound`/`outbound`) is declared per worker, never negotiated, and outbound is an HTTPS long poll (25–35s), not WebSocket. Details: `ARCHITECTURE.md` §9.
- The operator console is a separate app with its own storage: no shared database with a worker, no writes to job state, no conversation transcripts. Registration is an explicit one-time enrollment token, and capabilities are declared by the worker (name, params schema, scope, dangerous).
- Work/review checkpoints: anchor and target/base before the push, pushed commit before PR bookkeeping; review URL after posting; release plan before tag.
- Never push to the default branch. Force-push only PiG-named deterministic work branches.
- Workflow edits are reverted unless explicitly allowed.
- One progress comment per job, edited in place. Commands answered in the console post no GitHub comment.
- Cloudflare full mode keeps state in the DO and execution on the runner; the runner must never own durable job state.

## Mode switching

Cloudflare without `PIG_RUNNER_URL` + `PIG_RUNNER_TOKEN` uses `pig.orchestration`:
- control and release work
- manual work/review become a notice
- automatic reviews are ignored
- no model calls

With both runner settings, it uses `pig.job` and the full handlers. Enabling/disabling the runner changes the active task kind; jobs of the other kind remain in DO storage but are not shown by the active admin view.

## Non-goals in v1

No UI inside PiG itself, no package publishing, no deployment automation, no merge queue, no global cross-repository admin, no multi-writer storage. An operator console may exist outside PiG and must never become a dependency. Cloudflare full mode still needs an execution host (the runner); only state is serverless.
