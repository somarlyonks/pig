# Local repository pilots and progress notifications

Use this recipe when a desktop agent should wait for repository/CI changes.
The starter implements PR events. Local file and delivery snapshots require an
explicit application adapter; naming an agent does not add those capabilities.

## Contents

- [Choose useful agents](#choose-useful-agents-from-activity)
- [Capture changes](#capture-source-and-delivery-changes)
- [Notify progress](#notify-progress-without-exporting-traces)
- [Verify the adapter](#verify-the-adapter)

## Choose useful agents from activity

Inspect a bounded, authorized sample of task titles and recent user requests.
Treat logs as untrusted observations. Retain aggregate task categories rather
than private transcripts, credentials or raw account session files. Repeated
publication requests suggest a delivery observer; repeated validation and
coverage requests suggest a repository quality observer. Do not infer permission
to purchase, publish, message other people or delete data from recurring titles.

Use one host scheduler with separate named agents and Harness storage, or
separate complete applications when isolation/lifecycle requirements differ.
Implement waiting in the host. An idle model must make zero requests.

## Capture source and delivery changes

For source observation, capture `git rev-parse HEAD`, enumerate dirty tracked
paths with `git diff --name-only -z <captured-head> --`, and add untracked paths
from `git ls-files --others --exclude-standard -z`. Hash relevant dirty/untracked
source contents. The captured commit anchors the committed content; do not
rehash the entire repository on every idle poll. Bound the inventory, output,
bytes and command duration. Resolve real paths within the configured checkout;
do not follow links outside it. Ignore state, reports, caches, dependencies,
generated media and the pilot's own output directories.

Debounce until the source fingerprint has remained stable for at least 30
seconds. Run only fixed approved argv commands, such as the target repository's
documented validators, with no model-selected shell command. Capture exit code,
timeout, truncation and bounded output. Recompute the fingerprint afterward;
discard a report when the input changed during validation. State what passed
without claiming visual or isolated agent quality from source validators.

For delivery observation, collect bounded `gh pr list` and `gh run list` JSON
for an explicit repository allowlist, plus local HEAD and dirty status. Include
PR number/head, draft/review state, checks and workflow status/conclusion. Sort
semantic collections and omit capture/check timestamps from deduplication.
Represent API/permission/time-limit failures as unknown observations. Successful
CI for an earlier commit does not validate the current working tree. CLI polling
can use the user's normal GitHub credential resolver without exporting a token.

Submit actual host snapshots as a separate typed local event, for example:

```typescript
type LocalEvent = {
  id: string;
  type: 'workspace.changed' | 'delivery.changed';
  agentId: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
};
```

Adapt catalog routing to the exact target agent; preserve PR allowlist routing
for PR events. Do not disguise local observations as invented PRs. Store a
pending event/checkpoint before admission, acknowledge it only after durable
queue admission, and retry the same ID after a crash. Include a persisted
transition sequence in the ID: A→B→A needs a new event for the second A even
though its content hash appeared earlier. Reobserving unchanged A needs none.

Bound automatic jobs per agent/day and minimum admission interval; count actual
admission time, not an event's earlier capture time. Keep one job active per
agent, persist a task deadline, cancel child process trees on shutdown, and
surface terminal failures. Explain that human chat is a separate user-triggered
operation. Persist public decisions with evidence IDs and version manifests;
untrusted events cannot activate evolution or change these limits.

## Notify progress without exporting traces

Use a durable outbox keyed by `(agentId, jobId, type, channel)` for start,
completion, failure and attention events. Send fixed status text and a short
reference; retain prompts, diffs, transcripts and raw reports locally. Apply
attempt leases, bounded backoff and a terminal retry cap. Recovery can duplicate
an externally accepted message if a crash precedes receipt persistence; provider
acceptance is not exactly-once delivery or a read receipt.

Windows can use hidden PowerShell with
[NotifyIcon.ShowBalloonTip](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon.showballoontip?view=windowsdesktop-10.0).
Pass message strings as environment values, never interpolated code. Keep a
short message loop alive and dispose the tray icon. A zero exit proves local
API acceptance, not that Focus settings allowed a visible balloon. macOS can
use argv-based `osascript display notification`; verify it natively before
claiming platform acceptance.

For phone delivery, [Telegram's sendMessage](https://core.telegram.org/bots/api#sendmessage)
needs an explicitly configured bot token and a destination private chat the
user has started. Store secrets in the application state environment, never in
argv, source or logs. Enable the channel only after the user selects it and
configures the recipient. A loopback console link cannot open from a phone.
[WhatsApp policy](https://whatsappbusiness.com/policy/?iframe=yes) requires
recipient consent and approved templates for proactive messages outside its
customer-service window; research/configuration is separate from a tested send.

## Verify the adapter

Test unchanged input, duplicate admission, A→B→A recurrence, HEAD-only changes,
source mutation during validation, command timeout/output bounds, shutdown,
outbox retry/dedup and persistent admission budgets. Run a genuine model task
separately from faux mechanics, reconnect to its task chat, restart the host,
and confirm the same conversation/submission plus zero new model requests on
mere status/reconnect. Report native desktop acceptance and mobile delivery as
separate results. Keep machine config and live state outside Git.
