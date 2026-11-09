# Choose Pi Durable features deliberately

Apply this guide to `@earendil-works/pi-durable` **1.5.0**. Read the installed public declarations before changing signatures. Use [version compatibility](version-compatibility.md) when upgrading, and the [1.5 example index](durable-examples.md) when a signature is unclear.

## Start with the smallest useful host

1. Open Node SQLite with one owning process and one Harness for that database.
2. Install the required tools, task definitions, hooks, and providers on every start. Persisted extension names do not persist executable code.
3. Reacquire existing conversation IDs. Creation options on `root()` initialize a missing root; use `configure()` to change an existing agent.
4. Call `resume()` after startup even when no input arrives. Read-only inspection does not schedule recovery.
5. Reuse the same `requestId` for a retry of the same logical input, in the same conversation, with the same content. Give a new input a new ID.
6. Observe committed state, and close the Harness cooperatively when shutting down.

Use `MemoryStorage` for disposable tests. Choose JSONL for small inspectable histories; its implementation also retains the history in memory. Prefer Node SQLite for a resident local service. SQLite locking and table prefixes do not make a Pi storage safe for multiple Harness owners. See the [pinned lifecycle and storage contracts](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/harness.ts) and [Node SQLite adapter](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/storage/sqlite/node.ts).

## Choose the tool surface

| Situation | Use | Implementation rule |
|---|---|---|
| A few operations with simple inputs | Direct `defineTool()` tools | Validate arguments with schemas and return concise model output. |
| Many dependent queries, loops, filters, or aggregation | Code Mode | Let QuickJS compose `tools.*`; return selected results instead of every intermediate response. |
| A large tool catalog | Deferred tools and `tool_search` | Load relevant tools on demand. Loaded tools remain available on that branch after compaction. |
| A program needs typed fields | `structuredOutputSchema` and `structuredOutput` | Validate typed results; keep `output` for model text and `details` for UI metadata. |
| Another tool composes operations | `api.executeTool()` | Use stable explicit nested call keys when call order may vary after recovery. |

Code Mode journals completed nested results and reruns deterministic script code after restart; an interrupted nested operation still follows its own replay policy. Check structured shell `exitCode` even if the JavaScript promise resolves. Set explicit output and execution limits. Restrict enabled `tools`, caller permissions, and the execution environment to enforce policy; hiding a tool with `modelTools` does not revoke nested access.

Use `NodeExecutionEnv` for trusted local execution. Its `cwd` chooses a directory and does not confine filesystem or process access. On Windows, install `createPowerShellTool()` when commands use PowerShell syntax; `CodingTools` supplies `bash` alongside read/write/edit. See the pinned [tool implementation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/tool.ts), [Code Mode implementation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/codemode/codemode.ts), and [tool search](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/tool-search/tool-search.ts).

## Admit a human message or another job

| Intent | Submission policy | What the client should show |
|---|---|---|
| Correct the work currently running | `whenBusy: "steer"` | Accepted for the next tool-round boundary; a provider request already running is not interrupted midway. |
| Ask another question after the current answer | `whenBusy: "followUp"` | Queued for another run. On a failed run, `settings.afterFailedRun` decides: `keep` (default), `continue`, or `withdraw`; surface the choice. |
| Perform an action only if idle | `whenBusy: "reject"` | Handle `ConversationBusy` without claiming admission. |
| Record an application/UI fact without generation | `type: "write"` | Committed application data; choose whether the entry belongs in model context. |

Use an immutable client message ID as `requestId`. A lost HTTP response or closed chat window must not create another input when retried. Cancelling `submission.wait(context)` cancels that wait only. Reacquire a submission by ID to inspect its settlement after reconnecting. See the pinned [submission types](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/types.ts) and [inbox implementation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/inbox.ts).

## Manage branches, context, and ownership

Use `fork(entryId, ...)` to try an alternative from a concrete historical cutoff. Keep the original conversation as the original branch. Use `reset(handoff, context)` for fresh active model context within the same stored history; a reset alone does not request generation. Use compaction when a continuing conversation needs a shorter active context. Validate the summary on the selected live model and preserve durable application facts outside a lossy summary.

Interpret settlements and referenced entry kinds. A tool's `control.handoff` can settle input `done` with an assistant entry that is not final prose. A host reset during tool execution settles it `unanswered` with reason `reset`. An `unanswered` settlement carries one of `model_error`, `no_model`, `aborted`, `reset`, `faulted`, `orphaned`, `interrupted`, `restart_limit`, `nothing_to_answer`, `turn_limit`; the same reason appears in `pi.live.runFailure`, which persists until a later run starts. Do not display every `done.answer` as final answer prose. See the pinned [generation](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/generation.ts) and [compaction](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/compaction.ts) implementations.

Prefer task-owned foreground subagent conversations when their parent must wait and cancel with them. Choose a background anchor owning a child only when that worker should survive the parent's ordinary abort. Ordinary idle/abort excludes background subtrees; show them separately and offer explicit background-inclusive abort. Use durable `waiting` joins with `allSettled` when every branch matters; use `failFast` when one failure invalidates pending siblings.

Use `abort` for durable cancellation and `close()` for host shutdown with recoverable pending work. Handlers must honor cancellation for a timely close. Do not use a forever-running model turn as an event listener. A task cut off `settings.restartLimit` times in a row ends visibly (a run failure, a tool error result, a failed compaction, or a faulted task) instead of parking; resubmit the work rather than looking for `retryTask()`. See [task ownership and state types](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/types.ts).

## Make recovery safe

Design each effect as: commit intent and operation ID, execute outside the commit, commit its receipt. Crash recovery starts from committed checkpoints and can repeat an interrupted phase. `replay: "safe"` allows the tool to rerun; it does not make a remote comment, payment, command, or file append exactly once. Implement external idempotency or reconcile an ambiguous result before repeating it. Use stable provider operation IDs where supported, or `runtime.memo(name, candidate)` for a small first-writer-wins claim that survives a crash between effect and checkpoint.

Keep commit callbacks short and use only the current `tx` for transactional reads/writes. Read table records before table writes. Do not await shell commands, models, HTTP requests, or Harness snapshot methods inside a commit. Use `defineTask()` for workflows that need explicit phase transitions and durable joins, rather than assuming JavaScript stacks survive restart.

Use typed documents for application state. Choose `session` for service-wide state, `conversation` for branch state, and `task` for state that retires with its task. Choose `latest` history for current values and `rewindable` for historical reconstruction. Fork policies `initial`, `current`, and `asOf` respectively reset, copy current, and reconstruct at the branch entry; `asOf` requires rewindable history. `checkpointWhen` is required on every definition: return `true` to store a change as a full base, and `() => false` for an ordinary small document. Version task inputs/checkpoints and document schemas, retain required migrations, and inspect blocked definitions before resuming upgraded code. See [documents](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/documents.ts) and [task definitions](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/tasks.ts).

## Observe without creating another owner

Serve a `Conversation.watch()` value (or the first value of a short-lived watch) through the owner process. A view's `entries` is a window (newest `min`, at most `max`), so send `before` with it and page older history with `Conversation.entries()`, or use `ConversationTranscript` for gaps and resume. Initialize a client with the current snapshot; apply subsequent serialized patches. Reconnect with a new snapshot; after a drop, `transcript.resume` restarts the window at the newest entry the client kept. Watches fold commits made while a listener runs and may replace buffered intermediate frames, so retain audit facts as durable entries instead of treating a watch as an exhaustive event log. Stop watches before closing storage.

Expose `inspect()` for blocked reasons, `watchTaskGraph()` for ownership, and `usage()` for model/tool spend. Surface failed, unanswered, queued, background, and restart-limited work explicitly. An idle agent service remains registered and consumes no model requests while waiting for an event; `harness.wake()` tells a suspending host when it must next run. See [views](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/view.ts) and [task graph](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/task-graph.ts).
