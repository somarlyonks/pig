# Upstream pi-durable 1.5 examples

`pi-durable` ships runnable examples in the `pi` monorepo next to its sources. They are the most reliable description of the 1.5.0 API; read the one matching a change before guessing at signatures.

- Browse: <https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable/test/examples>
- Raw file: `https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/durable/test/examples/<name>.ts`

Read from the tag matching the installed package; `main` moves ahead of a pinned release.

```bash
node -p "require('./node_modules/@earendil-works/pi-durable/package.json').version"
curl -sS "https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/packages/durable/test/examples/23-child-tasks.ts"
```

The examples import package internals (`../../src/...`) and run with `node --conditions=source --experimental-strip-types`, so treat them as reference code, not as import paths for a generated service. A service imports only public subpaths: `@earendil-works/pi-durable`, `.../tools`, `.../env/node`, `.../storage/sqlite/node`, `.../storage/jsonl/node`.

## Highest value for this skill

| Example | Lesson |
| --- | --- |
| `03-owned-conversations.ts` | Task-owned child conversation created in one commit with its parent task and a mapping document; `requestId` dedupe. |
| `11-tasks.ts` | Task = state machine; every phase commits a checkpoint or outcome; save intent, act, then save the result. |
| `12-recovery.ts` | Reopen continues from the last checkpoint; `memo()` makes a repeated step safe; `sleepUntil()` parks without an invocation. |
| `19-inbox.ts` | Busy-conversation input: `followUp` vs `steer` vs `reject`, queue withdrawal, `InboxDoc`. |
| `23-child-tasks.ts` | `waiting` + `on` + `policy`, `runtime.outcomes()`, child-first abort ordering, `watchTaskGraph()`. |
| `24-compaction.ts` | Background vs blocking compaction, overflow retry, `compact()`, `pi.live.compactionFailure`. |
| `28-sandbox-per-conversation.ts` | Async `env(target, context)` that resolves a per-conversation workspace from a committed document. |
| `31-transcript.ts` | `ConversationTranscript` over a windowed view: gaps, load earlier, resume after a drop. |
| `32-tests-after-edits.ts` | `afterRun` hook task: run verification after edits, start a fix run, hold later input. |
| `33-turn-limit-and-continue.ts` | `maxTurns`, `continue` submissions, `pi.live.runFailure`, `ConversationBusy`. |
| `34-submit-in-commit.ts` | Admission inside a host commit: check, document write, and submit atomically. |

## Full index

| Example | Lesson |
| --- | --- |
| `00-conversation.ts` | `createSession`, `MemoryStorage`, `BACKGROUND_CONTEXT`, all writes inside `commit`. |
| `01-documents.ts` | `defineDoc`, `tx.doc()` creates on first write, `snapshot` vs `snapshotAsOf`. |
| `02-forks.ts` | `forkConversation(conversation, entry)`; fork transcript and docs follow `fork: "asOf"`. |
| `03-owned-conversations.ts` | One commit creates a background supervisor task, its task-owned child conversation, and an app registry doc. |
| `04-watches.ts` | `watchDoc`: non-overlapping folded calls, ops, `stop()`. |
| `05-harness.ts` | `Harness.open(storage, { models, registry }, context)`, `root()`, extension and tool resolution. |
| `06-configuration.ts` | Per-conversation `agent` choices, `configure()` add/remove, defaults from `settings.extensions`. |
| `07-harness-conversations.ts` | Conversation handles, typed entries (`defineEntry`), `createConversation`, `fork`, `agent`. |
| `08-context.ts` | What `context()` sends: heads, edits, aborted/error messages, tool-result ordering. |
| `09-registry-reload.ts` | Install same name to replace in place; `wrapTool`; uninstall. |
| `10-extension-state.ts` | Tool writes a conversation doc, `section` reads it into the system prompt. |
| `11-tasks.ts` | Phase contract, `runtime.commit` returning next state, terminal outcome, `abort` handler. |
| `12-recovery.ts` | Durable continuation after close, `memo`, `sleepUntil`, inspection with a non-resumed Harness. |
| `13-chat.ts` | `submit`/`wait`, `settled.answer` as an `EntryId`, built-in `pi.generation`. |
| `14-system-prompt.ts` | `section`/`wrapSection`, per-conversation `instructions`, prompt diffing into `pi.system` entries. |
| `15-real-model.ts` | Real provider through `Models`; stream partials via a `LiveDoc` watch. |
| `16-coding-tools.ts` | `CodingTools`, per-call `env`, tool hooks (`beforeTool`/`afterTool`) on `ToolTask`. |
| `17-print.ts` | One-shot print mode; await the submission, not global idle. |
| `18-json.ts` | Conversation view as ops or state frames; `--storage sqlite/jsonl/memory`. |
| `19-inbox.ts` | Follow-up vs steer vs reject while busy, queue withdrawal, `InboxDoc`. |
| `20-late-join.ts` | A watch attaches mid-run and first gets the current view, then changes. |
| `21-subagent-foreground.ts` | A tool call creates and owns a child conversation, waits for its task, aborts it with the call. |
| `22-subagent-background.ts` | Long-lived named subagents: message, stop, list, deliver answers, survive restart. |
| `23-child-tasks.ts` | Child tasks, `failFast`, `outcomes`, child-first abort, `watchTaskGraph`. |
| `24-compaction.ts` | Compaction thresholds, background vs blocking, overflow retry, `compact()`. |
| `25-coding-agent.ts` | Small coding agent: live settings getters, prompt sections, env following conversation `cwd`. |
| `26-plan-mode.ts` | Read-only mode via `configure({ extensions, tools })`, `control: { terminate: true }`. |
| `27-reviewer.ts` | Reviewer conversation: cheaper model, own checkout, read-only tools, review loop hook. |
| `28-sandbox-per-conversation.ts` | Async `env` reads a conversation doc to pick the workspace. |
| `29-tool-override.ts` | Same-name tool replacement plus `wrapTool` decoration, per-conversation extension add. |
| `30-reload-and-restart.ts` | Running call finishes on old code; stored names bind to whatever the next process installs. |
| `31-transcript.ts` | `ConversationTranscript` over a windowed view: gaps, load earlier, resume. |
| `32-tests-after-edits.ts` | `afterRun` hook task: run tests after edits, start a fix run, hold later input. |
| `33-turn-limit-and-continue.ts` | `maxTurns`, `continue` submissions, `pi.live.runFailure`, `ConversationBusy`. |
| `34-submit-in-commit.ts` | Admission inside a host commit, check plus write plus submit atomically. |
| `35-durable-on-the-store.ts` | `StoreStorage` on a Chord store: one commit queue, shared seq/id allocator. |
| `36-durable-views.ts` | `observeConversation`/`observeTaskGraph` as Chord sources. |
| `37-harness-registry.ts` | `registryReader` for plugin-contributed extensions; a contributed Harness followed by another object. |

## Not relevant to a local event service

Chord store integration, browser storage, and Pi terminal product examples (`35`–`37`) do not map to the bundled service template. They are still the fastest way to check a `Harness`, `Storage`, or registry signature.
