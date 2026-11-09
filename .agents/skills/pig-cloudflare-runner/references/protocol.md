# Runner protocol

All routes are `POST` except `GET /healthz`. Auth: `Authorization: Bearer $PIG_RUNNER_TOKEN`.
Bodies are JSON. Paths are relative to the job checkout and must stay inside it.

## Create/reuse workspace

`POST /workspaces`

```json
{
  "jobId": "<repoHex>-<taskId>",
  "repo": "owner/name",
  "ref": "main",
  "localBranch": "pig/…",
  "detached": false,
  "depth": 30,
  "attempt": 1,
  "token": "<github installation token>",
  "remoteUrl": "https://github.com/owner/name.git"
}
```

Response:

```json
{ "workspaceId": "<id>", "repoPath": "/data/runner/<id>/repo", "baseSha": "<sha>" }
```

Reuses when marker `attempt`, `ref`, `localBranch` match and `.git` exists. Otherwise removes and re-clones. Marker includes `remoteUrl` for later push.

## Operations

| Route | Body | Response |
|---|---|---|
| `/workspaces/:id/read` | `{path}` | `{content: string \| null}` (max 512 KiB) |
| `/workspaces/:id/write` | `{path, content}` | `{ok: true}`; creates parent dirs |
| `/workspaces/:id/edit` | `{path, edits:[{oldText,newText}]}` | `{ok:true}`; each oldText must occur exactly once |
| `/workspaces/:id/list` | `{path?}` | `{entries:[{name,kind}]}`; `.` = checkout root |
| `/workspaces/:id/bash` | `{command, timeout?}` | `{output, exitCode, truncated}` |
| `/workspaces/:id/head` | `{}` | `{sha}` |
| `/workspaces/:id/changed` | `{}` | `{paths}` |
| `/workspaces/:id/revert-workflows` | `{paths}` | `{reverted}` |
| `/workspaces/:id/commit` | `{message,name,email}` | `{sha: string \| null}` |
| `/workspaces/:id/push` | `{branch,force,token}` | `{ok:true}`; uses marker `remoteUrl` |
| `/workspaces/:id/reset-config` | `{repo}` | `{ok:true}` |
| `/workspaces/:id/reset-soft` | `{sha}` | `{ok:true}` |
| `/workspaces/:id/remove` | `{path}` | `{ok:true}` |
| `/workspaces/:id/cleanup` | `{}` | `{ok:true}`; removes the whole workspace |

## Remote tools

`AgentWorkspaceDoc` (conversation scope) stores `{workspaceId}`. Each tool reads it with `api.snapshot(AgentWorkspaceDoc, api.conversationId, context)`.

- Work tools: `read`, `list`, `write`, `edit`, `bash`.
- Review tools: `read`, `list`, `write`; `write` only `.pig/review.json`.
- Bash runs in the checkout with `buildShellEnvironment()`; no GitHub/model/App secrets.
- Tool results are text; bash nonzero is an error result with output and exit code.
