# Version and compatibility boundary

Use **1.5.0** as this skill's reference release. Pin `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, and optional `@earendil-works/pi-codemode` / `@earendil-works/pi-schema` to compatible exact versions, then retain the lockfile. The reference runtime used Node **24.18.0**; verify Node's SQLite availability on the actual supported platforms before installation.

The release is experimental. Resolve executable signatures from installed `dist/*.d.ts` and source, and read the bundled [1.5 examples](durable-examples.md) instead of trusting an unversioned development README. Tag `v1.5.0` resolves to commit `f9a26365568127461c47a07a37dcb42c140a3ac5`. For an upgrade, compare the installed package's `CHANGELOG.md` (`1.4.0` and `1.5.0` sections) rather than assuming today's `main` matches.

For an offline compatibility/design request, this reference's pinned API table and source links are sufficient evidence for the release verdict. Inspect installed declarations only when they exist inside the user's authorized target project. If that project has no installed package and installation/network are prohibited, state that local package inspection was unavailable and use this bundled evidence. Do not search parent directories, home directories, global npm/Pi caches, or other evaluation runs to find a different installation. Report the observed host platform without treating a library source search as a prerequisite for a design answer.

## What 1.5 gives a host that 1.3 did not

| Concern | 1.3.0 | 1.5.0 |
| --- | --- | --- |
| Retry / backoff between attempts | `runtime.sleep()` waited inside a live phase | `runtime.sleepUntil(at, checkpoint)` and persisted `sleeping` state; no invocation held, survives restart |
| Host wakeup | none | `harness.wake()` → `{ active, at? }`; `HarnessOptions.onWake` tells the host to arm its own alarm |
| Crash-loop bound | unbounded reruns | `settings.restartLimit` (default 5) with `task.restarts`; a limit-hit task now **ends visibly** (faulted / run failure / tool error), never parks |
| Failed run leaving queued input | follow-ups could wait indefinitely | `settings.afterFailedRun: "keep" \| "continue" \| "withdraw"` |
| Per-model compaction | one harness-wide policy | `settings.compaction.modelOverrides` keyed by `"provider/modelId"` |
| Live model/settings replacement | constructor objects only | `HarnessOptions.models` / `settings` also accept suppliers, read at each use |
| Tracing | host instrumentation only | `HarnessOptions.telemetry` with `DURABLE_TELEMETRY_SCHEMA` (content-free admission/phase spans) |
| Host error reporting | `onReport(error)` | `onReport(report)` where `report.kind` is one of `storage_failed`, `task_faulted`, `task_interrupted`, `migration_failed`, `task_outdated`, `task_error`, `extension_error`, `host_error`, `listener_error`; `report.error` carries the failure |
| Tool schemas | TypeBox `Type.*` via pi-ai | `@earendil-works/pi-schema` builders (`obj`, `str`, `num`, `int`, `arr`, `opt`, `oneOf`, `union`); pi-ai no longer exports `Type`, and `typebox` is not a pi-durable dependency. The Pi Coding Agent console extension still types `registerTool` parameters with TypeBox. |
| Client streaming | `watchEvents()` | conversation views: `Conversation.watch()`, `Harness.observeConversation()`, `LiveDoc`, `ConversationTranscript` |
| View snapshot | `Conversation.viewState()` | `Conversation.watch(context, window?)` first value; `viewState`/`documentState`/`Harness.taskGraph()` are removed |

## Breaking changes the bundled templates care about

- **`ConversationView.entries` is a window**, not the whole transcript: newest `min` (default 50), appends, drops to `min` past `max` (default 100), with `before` naming the entry just before it. Read the model's active context from `Conversation.context()`; page older history with `Conversation.entries()`; render a longer transcript with `ConversationTranscript`. `Harness.observeConversation`/`Conversation.watch` take `ConversationWindow` (`from`, `min`, `max`).
- **Watch listeners take one tagged change object**: `watch.start(async (call, context) => { if (call.kind !== "value") return; ... })`. End reasons are tagged: `stopped`, `cancelled`, `aborted`, `ended`, `listener_error`, `failed`. Document watches follow an address across retirement (`call.retired`) instead of ending with `null`.
- **Watchers fold commits made while the listener runs** into one callback with the newest value and folded ops; past 10,000 pending ops they get one root replacement.
- **Progress is persisted later than shown.** Partial answers and running tool output commit deferred (`settings.progress.persistWithinMs`, default 1,000 ms). Watches see them at once; Storage gets them with the next commit that reads `pi.live` or at the deadline. A crash may lose about a second of streamed content.
- **`pi.live` keeps `runFailure`** after a run that ended without an answer. Test idleness with `run === undefined`, not an empty document.
- **Restart-limited tasks end**: a generation ends its run (`runFailure.reason: "restart_limit"`, inputs `unanswered`), a tool call gets an error result with diagnostic `restart_limit`, a compaction fails into `pi.live.compactionFailure`, and an extension task ends `faulted`. `Harness.retryTask()`, the `restart_limit` blocked reason, and `task_parked` were removed; resubmit work instead.
- **A generation whose request was in flight at a crash no longer resends it on open**: the attempt counts as failed under `settings.retry`, then backoff, then `interrupted` when no retry remains.
- **Tool parameters and output schemas are JSON Schema typed through pi-schema.** Replace `Type.Object({ n: Type.Number() })` from pi-ai with `obj({ n: num() })`. `obj` is closed by default (`{ open: true }` allows extra properties). `ToolControl.terminate` is `boolean`, and `control.handoff` continues a run.
- **`onReport` takes one `Report`**: switch on `report.kind`, and add cases for `task_interrupted` and the new `"telemetry"` host callback before an exhaustive switch compiles.
- **`defineDoc()`/`defineDocFamily()` require `checkpointWhen`** (1.4 change): `() => false` for ordinary docs.
- **SQLite storage migrates to schema version 2 automatically** on open (1.4). The migrated database cannot be opened by 1.3.0 or earlier; back up state before upgrading a resident service.
- **Custom `Storage.commit()` takes batches**: `commit(batches, receive, context)` returning `{ stored, refused? }` (1.5). Code that seeded storage directly uses `commitWrites(storage, writes, context)` from `@earendil-works/pi-durable/testing`.
- **`FileSystem.watch()`'s change type is `FileChange`** in `@earendil-works/pi-durable/env`.

## Preserve storage and environment limits

- Node SQLite uses WAL with `synchronous=NORMAL`. Process-crash recovery is a different guarantee from persistence after host power loss. Give one process ownership of a Pi store; table prefixes do not supply multi-process coordination. See the [adapter implementation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/storage/sqlite/node.ts).
- JSONL with `fsync: true` flushes writes before commit markers but retains the whole history in memory. Use it deliberately for inspectability. See the [JSONL implementation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/storage/jsonl/storage.ts).
- The direct `images/node` import encountered a Photon export-interoperability failure in the reference Windows environment. Supported images within model limits can work without the optional processor. Recheck the installed image path before promising preprocessing; do not silently add a required image dependency to an event-only service. See [image loading](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/images/node.ts).
- CodingTools installs `bash`; PowerShell is a separately installed tool. Validate the intended shell and absolute executable paths under the service account. See [shell tools](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/tools/bash.ts).
- Pi Durable is an embedded host runtime. Pi Coding Agent's interactive/RPC features, installed skill discovery, and CLI options are separate product surfaces. See the pinned [Coding Agent README](https://github.com/earendil-works/pi/blob/v1.5.1/packages/coding-agent/README.md).

## Upgrade with durable state present

1. Keep the service stopped while its storage is opened once by the new code; 1.4+ migrates SQLite automatically and one-way.
2. Re-run the scaffold comparison by hand: `checkpointWhen`, tool schemas, watch call shapes, `viewState`/`watchEvents` call sites, and any `runtime.sleep()` use.
3. Raise `settings.restartLimit` before restart if unfinished work already accumulated crash cutoffs; a limit reached at open ends the task instead of parking it.
4. Decide `settings.afterFailedRun` and `settings.progress.persistWithinMs` explicitly for the product, rather than inheriting defaults by accident.
5. Rebuild, smoke with the faux provider, then restart; verify unfinished conversations recover and `pi.live.runFailure`/`compactionFailure` are surfaced instead of parked tasks.
