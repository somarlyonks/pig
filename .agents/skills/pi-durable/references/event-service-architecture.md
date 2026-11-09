# Turn a Pi agent into an event-driven service

Use a resident host around Pi Durable. Give the service a stable name, persistent storage, an event adapter, a durable inbox, a worker, and a local console API. Pi supplies durable conversations and tasks; the host supplies event detection, service registration, client transport, authentication, and process supervision.

## Use this flow

```text
PR/webhook/file/timer event
          |
          v
validate + normalize adapter
          |
          v
atomic durable inbox ---- duplicate delivery --> existing receipt
          |
          v
job identity -> persisted conversation mapping
          |
          v
Pi submit(stable requestId) -> durable work -> outcome + effect receipt
          ^                         |
          |                         v
console chat by ID <---- registry / snapshot / watch
```

Keep detection outside the model. A webhook or filesystem event can wake the worker immediately. If polling is necessary, poll a remote API with ordinary code, bounded cadence, backoff, and a persisted cursor. Submit only a new relevant event to Pi. During idle periods, keep the service discoverable without repeatedly asking a model whether anything happened.

## Separate identities

| Identity | Stable example | Purpose |
|---|---|---|
| Service/agent | `pr-reviewer-acme` | Human-visible worker identity and configuration. |
| Delivery | Provider delivery ID or a deterministic feed record key | Deduplicate transport redelivery. |
| Logical job | `github:acme/app:pr:42` | Find the continuing task conversation. |
| Revision/event | PR number plus immutable head SHA and action | Distinguish a new revision from another notification about the same revision. |
| Pi input | `review:acme/app:42:<head-sha>:v1` | Deduplicate admission within that job conversation. |
| Human message | Client-generated immutable message ID | Retry a chat send without producing duplicate input. |
| External effect | Job/revision plus effect kind | Reconcile or deduplicate a comment, check result, or other write. |

Keep delivery and job deduplication separate: one delivery may describe a new revision, and multiple deliveries may describe the same desired review. Decide whether opened PRs only, every head update, or explicit labels/comments should trigger work. Include policy/schema version in a key when the same revision intentionally needs another kind of run. Use a new operation ID for an explicitly requested rerun.

## Admit events before acknowledging them

1. Authenticate a webhook or local client; validate its envelope, source, permitted event type, and repository. Preserve untrusted PR text as task data rather than host instructions.
2. In one inbox transaction, insert the delivery key and normalized job payload with a unique constraint, status, receipt, and timestamp. Persist the polling cursor in the same transaction as new inbox rows when using a feed.
3. Acknowledge only after durable acceptance. On redelivery, return the existing receipt. A transient processing failure must leave an accepted event recoverable.
4. Let the single owner claim queued rows with bounded concurrency and persisted attempts. Give retryable failures a persisted next-attempt deadline; expose exhausted attempts for manual retry.
5. Resolve the logical job to an existing conversation before submitting input. Persist creation and mapping atomically in Pi state, or provide an equivalent tested reconciliation procedure. A crash between conversation creation and saving its ID otherwise makes an orphan and can create duplicate work.
6. Call the public conversation `submit()` with the stable request ID. Once it returns, persist the submission ID in the inbox receipt. If the process dies between admission and saving that receipt, retry the same conversation and request ID.
7. Mark completed only after interpreting the terminal settlement. Persist failures/unanswered outcomes too. Model completion and completion of a public side effect may require separate receipts.

Pi and a separate inbox database do not share an automatic atomic commit. The stable mapping and submission ID protocol closes that gap through replay. If the inbox lives in Pi typed documents, use the same host commit line; do not write directly into its SQLite tables from an adapter. Use `tx.createConversation()` with a session-scoped mapping document in one commit when implementing atomic mapping, and reacquire its handle afterward. Public `Conversation.submit()` applies admission; raw `tx.createSubmission()` requires implementing those rules yourself. See the pinned [transaction contract](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/types.ts) and [public Harness interfaces](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/src/harness/types.ts).

## Give jobs their own conversations

Keep a small control conversation for service-level questions and configuration. Give each PR, incident, or durable task its own continuing conversation. Store `{ serviceId, jobKey, conversationId, latestSubmissionId, status }` in the registry. Route later PR revisions to that PR conversation, or create revision conversations if independent histories and parallel execution are required.

This prevents unrelated jobs accumulating in one growing model transcript. Store shared policy and service state in typed documents, and send selected facts to a job. A chat asking about PR 42 attaches to PR 42's saved conversation; it must not create another agent simply to display a chat window. If a user wants a separate exploratory branch, use `fork()` and register that new ID explicitly.

Apply bounded active jobs and per-job serialization. Multiple clients can talk to the owner process; they must not open the same Pi storage independently. Multiple host processes need independent stores and explicit sharding or a separately designed coordinator.

## Register an agent in the console

Provide a host-owned registry and CLI or web console with these operations:

| Operation | Behavior |
|---|---|
| List agents | Show stable name, description, source, idle/busy/offline state, active job count, last event, and last error. |
| List jobs | Show job key, conversation ID, queued/running/failed/completed state, revision, and spend. |
| Open chat | Resolve an agent/job selection to its persisted conversation ID; fetch snapshot, then watch. |
| Send message | Submit with a stable message request ID and a stated busy policy. |
| Stop task | Commit task/conversation abort; include background work only when explicitly selected. |
| Stop service | Stop admission and watchers, cooperatively close the Harness, then stop the process. |
| Restart service | Start one owner, reinstall definitions, reopen storage, resume pending work, reconcile receipts. |

Select `whenBusy: "steer"` for a correction to the current review, `"followUp"` for the next question, and `"reject"` when an operation requires idle admission. Show accepted/queued separately from answered. Closing a console tab or cancelling its wait leaves accepted work running. Use snapshot/watch through the owner for reconnectable state; see [runtime decisions](runtime-decisions.md).

Use an authenticated loopback endpoint, named local IPC, or another explicitly secured transport. Keep credentials in the platform's supported secret mechanism or a restricted runtime configuration. A console registry is host application data, not model context.

"Register in the console" means registering in the console supplied by this service unless the user names another product and a supported integration exists. A Pi conversation is not automatically a Codex task. Do not claim an arbitrary Pi session can be inserted into Codex's task sidebar through a generic API. A bridge must keep the Pi conversation authoritative, retain its ID mapping, and accurately state any unsupported attach/open behavior.

## Recover and verify the complete path

Reopen the same databases with one owner, call `resume()`, then reconcile inbox rows with Pi submissions before accepting another copy. Preserve absolute runtime paths, task definitions, and provider identities across restarts. Mark `replay: "safe"` only for tools whose repeated effects are safe or independently idempotent. Pi input deduplication does not deduplicate remote effects.

Exercise: duplicate deliveries; two revisions of one PR; crash after inbox acceptance; crash after Pi admission but before receipt; restart during a tool; provider failure with a queued follow-up; chat disconnect/reconnect; busy steering; ordinary versus background-inclusive abort; two-owner prevention; shutdown while idle. Show event counts, submission IDs, effect counts, and recovered conversation IDs. Verify no model calls during an idle observation window.

Validate native installation/start/stop/restart on each promised platform. OS service templates can be structurally checked elsewhere; only a run on the actual operating system establishes its lifecycle behavior. Keep webhook delivery/authentication, real-provider quality, and posting integration results distinct from deterministic local recovery checks.
