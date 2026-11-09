# Per-user service lifecycle on Windows and macOS

## Contents

- [Choosing a platform mechanism](#choosing-a-platform-mechanism)
- [Windows operation](#windows-operation)
- [macOS operation](#macos-operation)
- [Validation contract](#validation-contract)
- [Primary references](#primary-references)

Use `assets/templates/service/src/service-manager.ts` in the generated application's
source tree. It exports `createServicePlan(options)` and
`runServiceAction(action, {...options, execute})`. Supported actions are `install`,
`start`, `stop`, `status`, and `uninstall`. Dry-run is the default: it returns
artifacts and command arrays without writing files or changing services.

`ServiceOptions` requires `platform` (`win32` or `darwin`), absolute `projectDir`,
`configPath`, `dataDir`, and `nodePath`; `serviceName` defaults to `pi-agent-service`.
The name accepts a lowercase initial letter, lowercase letters, digits and
hyphens, up to 48 characters. Different installations need different names and
data directories. macOS derives `homeDir` and `userId` from the current user;
provide both explicitly when rendering a macOS plan on another OS.

The generated executable contract is:

```text
<absolute-node> <absolute-project>/dist/src/cli.js serve --config <absolute-config>
```

Console-managed projects instead supply optional `entryPath` equal to their
absolute project-local `agent-host.mjs` with that project's `config.json`.
The native argv is then `[entryPath]`, preserving the authenticated owner and
drain protocol. This entry joins the registration's ownership identity. Managed
macOS plans use `KeepAlive` with `SuccessfulExit: false`: a clean drained stop
does not respawn. Generic CLI plans retain their existing supervision policy.
Use `/durable login <agent>` or the project's control CLI `login-startup`
subcommand for reviewed plan/install/status/uninstall. Installation requires a
stopped managed owner; removal drains before unregistering. Once installed,
managed start follows that owned native registration, avoiding a second detached
process. Interrupted installation intent fails closed until inspected/recovered.

Compile the application before installing. Resolve `nodePath` from `process.execPath`
and keep that Node installation available. Reinstall the service after moving the
project or replacing Node with a different absolute path. Never install directly
from a temporary evaluation workspace. Produce a reviewable dry-run first; perform
installation when the user requests activation in their own generated project.

## Choosing a platform mechanism

| Requirement | Windows | macOS |
| --- | --- | --- |
| Run when the user logs in | Task Scheduler `LogonTrigger` | User `LaunchAgent` |
| Identity | Current user SID; `InteractiveToken`, `LeastPrivilege` | Current GUI user's `gui/<uid>` domain |
| Restart after failure | One-minute interval, up to 255 retries | `KeepAlive`, ten-second throttling |
| Start immediately at installation | Register and start task | Bootstrap with `RunAtLoad` |
| Stay out of the user's terminal | Hidden PowerShell parent; Node inherits the hidden console | Background launchd process |
| Prevent duplicate service instances | Task `IgnoreNew` plus application owner lock | One launchd label plus application owner lock |
| Logs | Append stdout/stderr in `dataDir/logs/` | launchd stdout/stderr files in `dataDir/logs/` |

Both mechanisms run in the user's login session. They can continue when the screen
is locked; they depend on the computer being awake and the network being available.
They do not provide a guarantee of running through logout or sleep. For work that
must run while the laptop is off, deploy the same service on an always-on host.
Choose a machine-level Windows service or macOS LaunchDaemon only when a deployment
explicitly needs that lifecycle, with a separate service identity and installation
policy. The bundled template deliberately uses the user's normal credentials and
requires no administrator password.

## Windows operation

`createServicePlan` generates four local files under `dataDir/service/`:
`owner.json`, `task.xml`, `run-service.ps1`, and `manage-service.ps1`. The manager
substitutes the current user's SID at registration. It queries the task folder
before choosing a missing-task branch, so access failures are surfaced rather than
treated as an absent installation. It refuses a task whose description does not
match the configuration ownership hash.

The scheduled action runs the built-in Windows PowerShell executable with
`-NoProfile -NonInteractive -WindowStyle Hidden`. The runner invokes Node with an
argument array, waits for completion, appends logs, and preserves Node's exit code.
This keeps the Node child in the scheduled task's process tree. `stop` waits for
the scheduled task to leave the running state; `start` starts an existing task.
`status` emits JSON with installation, task state, last run time and last result.
`uninstall` stops and unregisters only the matching task.

Task Scheduler may terminate the process abruptly during stop or logout. Commit
queue state before accepting work, use durable request IDs, and resume from durable
state after restart. Limit job work to the application's configured tools; a
hidden service has the same filesystem and network access as the user.

The XML specifies `ExecutionTimeLimit=PT0S`; otherwise Task Scheduler's default
execution limit could end a long-running daemon. Battery settings allow execution
on battery. The template does not wake the computer. A retry budget exhausted by
repeated crashes requires diagnosing the logs and starting the task again.

## macOS operation

The generated plist uses explicit `ProgramArguments` strings, an absolute working
directory, `RunAtLoad`, and `KeepAlive`. It contains no shell command and does not
depend on shell initialization, nvm activation, or interactive `PATH` settings.
The manager stages the plist under `dataDir/service/`, validates it with
`/usr/bin/plutil -lint`, creates the log directory, then installs the owned file at:

```text
~/Library/LaunchAgents/local.pi-durable.<serviceName>.plist
```

It probes the exact `gui/<uid>/<label>` target before mutation. A loaded label
without its owned plist is a collision and is refused. An unchanged installation
is idempotent. Updating an owned plist unloads the existing job before replacing
and bootstrapping it.

- `start` enables the label, bootstraps it when unloaded, and uses `kickstart`
  without `-k`, preserving an already running process.
- `stop` uses `bootout` to unload the job. Sending a signal alone would let
  `KeepAlive` restart the process. The plist remains and the service loads again
  at the next login; use `uninstall` when it should stay removed.
- `status` reports the native `launchctl print` output. A missing service is an
  expected status; permission and other errors are surfaced.
- `uninstall` unloads the job and removes its owned plist. It retains the local
  configuration, database, staging files and logs for recovery.

Run lifecycle commands inside the target user's logged-in GUI session. `gui/<uid>`
is unavailable before that session exists. Modern macOS can expose the background
item in System Settings; a user disabling it requires re-enabling it. Validate on
the target macOS version because system policy and managed-device restrictions
can affect background execution.

## Credentials, configuration and collision protection

Store credentials in the generated application's local environment file or a
supported credential manager. Configure the daemon to load that file itself.
The task, plist and process command line contain only paths and service identity;
do not add GitHub tokens or model API keys to those artifacts. Apply user-only file
permissions/ACLs to the environment file and database. The manager creates POSIX
artifacts with mode `0600` and directories with `0700`; Windows permissions inherit
the selected data directory's ACLs.

The ownership marker binds service name, project, configuration path and data
directory. The manager refuses unrelated jobs, artifacts without their ownership
marker, and direct symlinks at managed artifact paths. This prevents accidental
clobbering; it is not a security boundary against another process running as the
same user. Preserve `owner.json` and the installed plist together. A relocated
configuration should be uninstalled with its original options before reinstalling.

## Validation contract

For normal runtime use, build the generated project, inspect its platform plans,
and run the local health/event/chat smoke checks. Normal runtime payloads exclude
`assets/examples/`; do not search for or read acceptance fixtures that are absent.

For maintainer validation with the full source bundle, copy
`assets/examples/service-acceptance/service-manager.test.ts` into the generated
project's `tests/` directory and run its test runner. The optional fixture checks
both plans, Windows argument quoting, all lifecycle actions through an in-memory
executor, repeated installation, error propagation, collisions and dry-run purity.
On Windows it also parses the generated XML and PowerShell with the native parser.

Native acceptance is a separate check in a disposable generated project:

1. Build, render and inspect the plan. Record the exact service name and data path.
2. Install with a deterministic model provider and a dedicated loopback port.
3. Confirm status, health endpoint, console registry and stdout/stderr paths.
4. Enqueue an event, restart the service, and confirm durable deduplication.
5. Stop and confirm the process/health endpoint disappears; start and reconnect.
6. Log out and back in to verify the promised per-user lifecycle.
7. Uninstall and confirm the task/label is gone while the database remains.

Do not report native registration, restart or login behavior as tested merely
because XML parsing and mocked lifecycle tests pass. On a Windows-only host,
record native macOS installation and login recovery as unverified.

## Primary references

- [Microsoft Task Scheduler schema](https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema).
- [Microsoft InteractiveToken logon semantics](https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element).
- [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
- [Apple: Updating legacy helper executables](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).
- On the target Mac, consult the installed `man launchctl` and `man launchd.plist`
  for current bootstrap, bootout, kickstart and property-list semantics.
