# Existing Pi Codex account

Use `provider.kind: "openai-codex"` when an installed Pi Coding Agent already
has an authorized Codex OAuth account and the application should read that
account without changing its credential store. Keep `openai` or `anthropic`
with their API credentials available for deployments that need a different
provider or account lifecycle.

The bundled bridge was checked against Pi CLI **1.5.1** and Pi AI/Durable
**1.5.0**. These versions are separate. Check `pi --version`, `pi auth --help`,
and the installed provider declarations before adapting another release.
The [upstream CLI reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)
documents credential commands; the
[auth command parser](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/auth-command.ts)
shows which command accepts each flag. Current upstream documentation can
advance beyond the installed version.

## Configure and verify

Find the installed Pi **JavaScript entry file**, rather than its `.cmd`, `.ps1`,
or shell launcher. On Windows, inspect `Get-Command pi` and its small launcher
to locate `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`. On macOS,
resolve the installed launcher's link to its package entry. Set the appropriate
absolute path for the target host:

```json
{
  "provider": {
    "kind": "openai-codex",
    "model": "latest:sol",
    "piCliPath": "C:/Users/<user>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  }
}
```

Process `PI_CLI_PATH` is an alternative to `provider.piCliPath`. It is a path,
not a credential. The generated `environment.env` continues to accept only its
documented API/GitHub secret names. Use [model discovery](model-selection.md) to
select a compatible current model and its supported reasoning level;
catalog presence alone does not establish account access. A safe readiness check
is `pi auth check --provider openai-codex --no-refresh --json`; a live bounded
task must establish that the account can actually use the selected model.

The bridge spawns Node with an argv array and captures `auth check --provider
openai-codex --no-refresh --json --credentials` only in memory. Do not execute
that credential-returning form into terminal output or save its stdout. In the
checked CLI, this path uses read-only auth storage and an in-memory model store,
and exits before ordinary session startup or migrations. It does not copy an
auth file or request a refresh. Child output is limited to 64 KiB and 15 seconds;
failures become generic errors without secret-bearing child error causes.

## Renewal and resource limits

The metadata readiness check proves configuration. It can still return ready
for an expired token. The bridge rejects expired JWTs and tokens with at most
30 seconds remaining; remote rejection can also establish expiry or lost model
access. Renew/sign in through the user's normal Pi account workflow, then retry
explicitly. The next request rereads the account. Do not promise uninterrupted
unattended service or force refresh writes beyond the application's authorized
scope. The tested Windows bridge does not prove a native macOS deployment.

Codex worker and requested reflection conversations use low thinking. The bridge
passes a 4096-token ceiling, a 120-second request timeout, and zero SDK retries.
**The pinned Codex request builder does not serialize `maxTokens` into its wire
request, so that token option is not a verified server-enforced spending cap.**
Keep host job deadlines/admission budgets where required, bound tool output,
and inspect actual usage evidence. Harness generation retries are a separate
setting. Idle registry/status reads do not generate. Model request counters and
public evidence record attempts; private provider thinking is not exported as
decision evidence.

The generated `reflect --generate` uses the same provider when a trusted user
requests improvement. It remains a no-tool draft conversation; the existing
evaluation, promotion, and rollback gates still apply.
