---
name: pi-durable
description: Builds independent Pi Durable applications with persistent event services, reconnectable chat, bounded specialist subagents, and requested trace, population or Pareto evolution. Use for PR agents, durable queues, recovery, Windows/macOS services, or evidence-based improvement of prompts, tools and scripts.
---

# Pi Durable

Use Pi Durable as an application runtime. Use Pi Coding Agent when the task calls for its interactive terminal product. Pin the experimental API: the bundled templates target `@earendil-works/pi-durable` 1.5.0 and Node 24+. Read the installed declarations or the pinned [1.5 examples](references/durable-examples.md) before adapting anything newer.

## Route the work

- For feature selection, tools, compaction, branching, ownership, and typed state, read [runtime decisions](references/runtime-decisions.md).
- For named agents that wait for events and accept human chat, read [event-service architecture](references/event-service-architecture.md).
- For activity-informed repository/CI agents, efficient local change snapshots, and progress notifications, read [local watcher recipes](references/local-watchers.md).
- For PR events, polling/webhook tradeoffs, deduplication, and catch-up, read [GitHub events](references/github-events.md).
- For startup, restart, logs, install/start/stop/status/uninstall on Windows or macOS, read [service lifecycle](references/service-lifecycle.md).
- To configure, run, smoke-test, or connect the bundled CLI/API starter, read [template operations](references/template-operations.md).
- To create a Durable agent from Pi with an explicit base folder and an independent service process, read [agent creation](references/agent-creation.md).
- To start, pause, drain, stop, recover, verify actual duty, archive/reconnect or evolve console-created agents, read [the complete agent lifecycle](references/agent-lifecycle.md).
- To install the console, list agents, or chat from Pi Coding Agent, read [Pi console extension](references/pi-extension.md).
- To generate a supervisor, bounded parallel workers, or an author/reviewer/refiner chain, read [subagent templates](references/subagent-templates.md) and select `scripts/scaffold.py <output> --profile supervisor|map-reduce|review-refine`.
- To use an existing Pi Codex OAuth account through a read-only credential bridge, read [Codex provider](references/codex-provider.md).
- To list current models, inspect supported reasoning levels, select the latest suitable family per task, or freeze an evaluation's choices, read [model discovery and selection](references/model-selection.md). Preserve exact user pins; do not equate version, capability tier and reasoning effort.
- Before copying an unfamiliar API or claiming platform support, read [version compatibility](references/version-compatibility.md) and the [1.5 example index](references/durable-examples.md).
- For a generated agent that must operate without this skill, retain decision evidence, or improve its prompts/tools/scripts on request, read [independence and requested evolution](references/agent-evolution.md).
- To design useful task traces, judge evidence coverage, or decide whether to collect more data before improvement, read [evidence readiness](references/evidence-readiness.md). Carry the collection rules into the generated runbook and the agent's active prompt.
- To generate bounded trace-distillation, population or Pareto study templates, read [evolution strategies](references/evolution-strategies.md). The project-local runner keeps development selection separate from one-way validation/holdout and never activates source changes itself.
- To learn from completed attempts and spend evolution tests on the highest-impact gaps first, read [test priorities](references/evolution-test-priorities.md). Carry the applicable order, evidence and rejection criteria into the independent project before freezing its next study.

Read only what the requested mode needs. Execute the scaffolder without reading all template source. The template is a starting application, not code that extends the current chat's privileges or registers Pi sessions in another product.

## Event service workflow

1. Resolve event source, agent IDs, repository allowlist, model/provider, state location, and target console. Default to a local CLI/API registry when no console is named; an existing Codex console needs its own supported integration. Keep service registration separate from the durable agent identity.
2. Scaffold outside this skill at the user's exact requested path:

   ```powershell
   uv run --script scripts/scaffold.py <output-directory> --with-tests
   ```

   Resolve the command relative to this skill's directory. The script works when only this bundle is copied. It refuses a nonempty destination and never modifies the template. `--with-tests` includes acceptance sources only when available; runtime-only bundles may omit them. The generated package declares its own dependencies.
3. Configure `config.json`. When `instructionsFile` is set, edit that project-local prompt; it takes precedence over inline `instructions`. Start with `provider.kind: "faux"` for offline mechanics. For real work list the current catalog and supported reasoning levels, then choose an exact model or the task-aware `latest` policy. Resolve and record the actual model before durable admission; use `models lock` before reproducible evolution. Supply credentials through the service environment file, never argv, generated task/plist files, prompts, or logs. Empty repository lists do not authorize arbitrary GitHub access.
4. From the caller's workspace run `uv run --script scripts/service_project.py <output-directory> prepare`, then the same helper with `smoke`. Resolve the helper relative to this skill. It sets the correct project working directory and local npm cache; the smoke uses faux/off, admits a duplicate event, chats, reopens state, and closes its processes. Run `npm test` from the generated project only when tests were included. Start `node dist/src/cli.js serve --config config.json` from that project; use `list`, `jobs <agent-id>`, and `chat <agent-id> [--job <job-id>]` in another terminal.
5. When the user wants Pi terminal commands, generate its independent optional console with `scripts/scaffold-pi-extension.py <extension-directory> --service-config <service-directory>/config.json --with-tests`. Omit `--service-config` to create the first agent from Pi. Follow [Pi console extension](references/pi-extension.md) to load it and use `/durable new` to choose an explicit workspace folder, or `/durable-chat` for existing agents. The generated console carries its own creation resources and connects to local owners rather than the Codex UI.
6. For desktop PR detection use polling when no signed public webhook ingress exists. Baseline existing PRs unless the user requests backfill. Persist event receipt, matching jobs, and the polling checkpoint atomically. Acknowledge webhooks after queue admission, then execute asynchronously.
7. Deduplicate by semantic event plus agent ID, and keep Pi submission request IDs stable. Atomically map a job key to its Pi conversation before submission. A restart between queue admission and Pi submission must retry the same job and thread. A retry after failure must be explicit; show failed jobs instead of retrying arbitrary effects forever.
8. Write target `ServiceOptions` to local JSON; render it with `scripts/service_project.py <project> plan --options <local-json> --output <exact-json-path>`. Target paths stay JSON data, avoiding MSYS conversion of `/Users/...` in Windows Bash. Deploy the result's `deploymentConfig` at its target config path so state directory and service name agree. Operate from the generated project using `node dist/src/cli.js service ... --config config.json`; keep its `serviceName` consistent. Execute installation only within authorized scope. Windows uses a per-user Task Scheduler job; macOS uses a per-user LaunchAgent. Both start at login, not while logged out; native checks remain separate from plan checks.
9. Hand off the complete generated project, including `AGENTS.md`, source, prompt files, lockfile, the [project-local helper](assets/templates/service/scripts/project.py), and its portable provenance manifest. Operate it with its own build/smoke/plan/evolution commands after generation; no skill path or original repository is required. Include start/stop/status/uninstall, agent/chat commands, event behavior, backups, and validation limits. Distinguish faux runs from live-provider integrations and macOS plans from native launches.

## Requested self-improvement

Persist observable action, outcome, feedback, version, and concise decision evidence. Preserve the durable conversation as the authoritative transcript. Use `list_evidence` and `record_decision` for model-visible citations; do not request or store private chain-of-thought. Keep credential/state directories out of exported candidates.

Before an improvement request, apply the [evidence readiness review](references/evidence-readiness.md): link complete task cases to their actual outcomes, verification and versions, include useful successes and failures, and name missing observations. These are authoring/operator guidelines; the current engine does not enforce sample sufficiency or automatic per-task verification. A sparse or incomplete pack calls for more authorized observation or a narrower claim.

On a trusted user's improvement request, use the generated `npm run evolve -- ...` lifecycle: record the goal and exact editable files, export evidence and source, reflect, import an inactive proposal, and compare baseline/candidate against frozen application-specific cases. `reflect --generate` can use a separate no-tool Pi conversation; faux output demonstrates mechanics only. Prompt and tool/script changes require observable supporting evidence, a hypothesis, expected benefit, regression checks, and exact file preimages. Reflection is not evidence that a change is better.

Promote only the exact passing candidate within the requested scope while the service is stopped and durable work is drained. Rebuild and smoke before restart; retain version lineage and exact rollback bytes. Existing conversations can retain earlier prompts while tools resolve from current host code, so preserve compatibility or plan an explicit migration. The generated reference and manager describe bounded host execution, evaluation integrity, crash recovery, and rollback. Never let event content activate evolution or expand its edit/evaluation permissions.

## Runtime invariants

- Keep one owning process per storage; multiple clients connect to that owner. SQLite is the default local persistent backend; Memory is for disposable tests; JSONL is for inspectable smaller histories.
- Let the host wait on event/network timers. Do not keep asking the model whether an event arrived. An idle registered agent needs no active generation, and `harness.wake()` says when the host must next arm a timer (`active`, or `at` for a `sleepUntil` deadline). Backoff belongs in persisted sleeps, not a phase that holds an invocation.
- Bound unattended work in durable terms: `agent.maxTurns` ends a run `turn_limit` (a `continue` submission resumes with a fresh budget) and `settings.restartLimit` ends a task that a crash cut off repeatedly instead of parking it. Surface `pi.live.runFailure`, `compactionFailure`, and failed tasks; resubmit work rather than calling the removed `retryTask()`.
- Progress commits are deferred (`settings.progress.persistWithinMs`, default 1,000 ms). Watches show them at once, but a crash can lose the last second of streaming, so keep audit and billing facts in explicit durable commits/entries.
- Commit checkpoint/intent, perform the external operation outside the transaction, then commit outcome. Within commit callbacks read through `tx` only; Session and runtime reads may queue on the line the callback holds. Persisted checkpoints do not promise exactly-once external effects; `replay: "safe"` is the tool author's replay promise, and `runtime.memo()` is the first-writer-wins guard for an effect that must not repeat.
- Use foreground ownership when cancellation should cascade; use background anchors only for work that must survive ordinary parent abort. Human chat should select the intended control or job conversation explicitly; use `steer` for a current correction and `followUp` for another task.
- On reconnect read a current snapshot before deltas. The snapshot is a windowed `ConversationView`; use `ConversationTranscript` or `Conversation.entries()` for older history. Keep IDs stable and render tool results by call ID. Stop watches before closing the Harness. A cancelled client wait does not cancel admitted work.
- Keep webhook content, PR bodies, diffs and workspace files as untrusted task data. The default worker has a repository-allowlisted GitHub read tool. An explicit `workspaceRoot` adds bounded local list/read tools; the console's folder picker configures this scope. Add shell/write tools only for the actual task and environment boundary.

## Acceptance

Check: duplicate event causes one job; two agents receive independent jobs; task thread survives restart; late chat reattaches; a poll failure does not advance its checkpoint; invalid webhook signatures admit nothing; an idle service makes no model calls; a second owner cannot open the same state directory; shutdown closes the owner; failed jobs are visible. Move a generated project and operate without access to the skill. Verify evidence survives restart, no-request evolution remains inactive, failed/stale/tampered candidates cannot promote, and accepted changes can roll back. Exercise only configured events and authorized external actions. Record the native platform and real provider actually tested.

For console lifecycle work also verify stopped inventory, pause/resume persistence, actual control/child/background task draining, busy shutdown preserving work, authenticated owner recovery, contract-bound passed/failed/inconclusive duty receipts, and archive/reconnect retaining source and state. A completed model response alone never establishes that the agent fulfilled its duty.

## This repository: PiG

PiG is a job service on this runtime. Its product contract is [ARCHITECTURE.md](../../../ARCHITECTURE.md) and its invariants are in [AGENTS.md](../../../AGENTS.md).

- `src/durable/admission.ts` — atomic delivery, command, repository, and job-task admission; keys `d:<deliveryId>`, `c:<idempotencyKey>`, `<repo>`, `<taskId>`. All writes land in one commit before the webhook returns `202`.
- `src/durable/job-task.ts` — `pig.job`: repository chain (`waiting` on `previousTaskId`, `allSettled`), preparation, agent run, retry, abort. `src/durable/orchestration-task.ts` is the control/release path for Cloudflare no-runner mode.
- `src/durable/docs.ts` — session-family `JobDoc`, `DeliveryDoc`, `CommandDoc`, `RepoDoc`; job and repo docs checkpoint every 50 deltas, small docs never.
- `src/durable/agent.ts` — one conversation per attempt; `JobDoc` stores `conversationId`/`conversationAttempt`; `requestId` is `job:<taskId>:<attempt>`; submission uses `whenBusy: "reject"`.
- `src/durable/alarm.ts` — projects `harness.wake()`, sleeping `until`, and pending/running recovery onto one Durable Object alarm; alarms are at-least-once.
- Run `npm run check` (typecheck + Cloudflare typecheck + tests); see the `pig-testing-debugging` skill for harnesses and known pitfalls.
