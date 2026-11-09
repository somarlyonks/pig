/** Compile with the generated service's `npm run build`; no shell interpolation or extra packages. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ServiceAction = "install" | "start" | "stop" | "status" | "uninstall";
export interface ServiceOptions {
  platform: "win32" | "darwin";
  projectDir: string;
  configPath: string;
  dataDir: string;
  nodePath: string;
  /** Console-managed hosts keep authenticated lifecycle ownership across login startup. */
  entryPath?: string;
  serviceName?: string;
  homeDir?: string;
  /** Required to render a macOS plan on another OS; native macOS uses process.getuid(). */
  userId?: number;
}
export interface ServiceCommand {
  file: string;
  args: string[];
  description: string;
  condition?: string;
}
export interface ServicePlan {
  platform: ServiceOptions["platform"];
  serviceName: string;
  ownerId: string;
  serviceDirectory: string;
  installPath: string;
  target: string;
  artifacts: Array<{ path: string; content: string; mode: number }>;
  commands: Record<ServiceAction, ServiceCommand[]>;
}
export interface CommandOutput { stdout: string; stderr: string; exitCode: number }
export interface ServiceRunResult {
  plan: ServicePlan;
  action: ServiceAction;
  executed: boolean;
  output: Array<{ command: ServiceCommand } & CommandOutput>;
}
/** Injection boundary for lifecycle tests. Production callers omit this argument. */
export interface ServiceExecutionContext {
  platform: string;
  run(command: ServiceCommand): Promise<CommandOutput>;
  read(file: string): Promise<string | undefined>;
  write(file: string, content: string, mode: number): Promise<void>;
  remove(file: string): Promise<void>;
  isSymlink(file: string): Promise<boolean>;
}

const actions: ServiceAction[] = ["install", "start", "stop", "status", "uninstall"];
const xml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** CommandLineToArgvW / CRT quoting; used only at Windows argument-string boundaries. */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function createServicePlan(options: ServiceOptions): ServicePlan {
  if (!["win32", "darwin"].includes(options.platform)) throw new Error("Only Windows and macOS service plans are supported.");
  const p = options.platform === "win32" ? path.win32 : path.posix;
  for (const key of ["projectDir", "configPath", "dataDir", "nodePath"] as const) {
    if (!p.isAbsolute(options[key]) || /[\x00-\x1f]/.test(options[key])) throw new Error(`${key} must be an absolute path without control characters.`);
  }
  const name = options.serviceName ?? "pi-agent-service";
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error("serviceName must start with a lowercase letter and contain at most 48 lowercase letters, digits, or hyphens.");
  if(options.entryPath!==undefined&&(!p.isAbsolute(options.entryPath)||/[\x00-\x1f]/.test(options.entryPath)||p.relative(options.projectDir,options.entryPath)!=='agent-host.mjs'||p.relative(options.projectDir,options.configPath)!=='config.json'))throw new Error('entryPath must be the absolute project-local agent-host.mjs path with the matching config.json.');
  const identity = [name, options.projectDir, options.configPath, options.dataDir,...(options.entryPath?[options.entryPath]:[])].map((s) => options.platform === "win32" ? p.normalize(s).toLowerCase() : p.normalize(s));
  const ownerId = `pi-durable-service:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  const serviceDirectory = p.join(options.dataDir, "service");
  const cli = p.join(options.projectDir, "dist", "src", "cli.js");
  const argv = options.entryPath?[options.entryPath]:[cli, "serve", "--config", options.configPath];
  const logs = p.join(options.dataDir, "logs");
  const artifacts: ServicePlan["artifacts"] = [];
  const commands = {} as ServicePlan["commands"];
  artifacts.push({ path: p.join(serviceDirectory, "owner.json"), mode: 0o600, content: JSON.stringify({ ownerId }, null, 2) + "\n" });
  if (options.platform === "win32") {
    const runner = p.join(serviceDirectory, "run-service.ps1");
    const manager = p.join(serviceDirectory, "manage-service.ps1");
    const taskXml = p.join(serviceDirectory, "task.xml");
    const taskArguments = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", runner].map(quoteWindowsArgument).join(" ");
    const windowsPowerShell = p.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(ownerId)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>__CURRENT_USER_SID__</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>__CURRENT_USER_SID__</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${xml(windowsPowerShell)}</Command><Arguments>${xml(taskArguments)}</Arguments><WorkingDirectory>${xml(options.projectDir)}</WorkingDirectory></Exec></Actions>
</Task>
`;
    artifacts.push({ path: taskXml, content, mode: 0o600 });
    // The hidden parent console is inherited by Node; direct invocation preserves exit codes
    // and keeps Node in the Task Scheduler process tree. Append logs across restarts.
    artifacts.push({ path: runner, mode: 0o600, content: `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Set-Location -LiteralPath ${ps(options.projectDir)}
[System.IO.Directory]::CreateDirectory(${ps(logs)}) | Out-Null
$serviceArguments = @(${argv.map(ps).join(", ")})
& ${ps(options.nodePath)} @serviceArguments 1>> ${ps(p.join(logs, "service.stdout.log"))} 2>> ${ps(p.join(logs, "service.stderr.log"))}
if ($null -eq $LASTEXITCODE) { exit 1 }
exit $LASTEXITCODE
` });
    artifacts.push({ path: manager, mode: 0o600, content: `param([ValidateSet('install','start','stop','status','uninstall')][string]$Action)
$ErrorActionPreference = 'Stop'
$taskName = ${ps(name)}
$ownerId = ${ps(ownerId)}
$taskPath = '\\'
# Query the folder first: access/service errors must not be mistaken for a missing task.
$task = Get-ScheduledTask -TaskPath $taskPath | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
if ($null -ne $task -and $task.Description -ne $ownerId) { throw 'Refusing to modify an unrelated scheduled task with the same name.' }
if ($Action -eq 'install') {
  $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $taskXml = [System.IO.File]::ReadAllText(${ps(taskXml)}).Replace('__CURRENT_USER_SID__', $userSid)
  Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $taskXml -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
} elseif ($Action -eq 'start') {
  if ($null -eq $task) { throw 'Service is not installed. Run service install first.' }
  Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
} elseif ($Action -eq 'stop' -or $Action -eq 'uninstall') {
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $current = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
      if ($current.State -ne 'Running') { break }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($current.State -eq 'Running') { throw 'Timed out stopping the scheduled task.' }
    if ($Action -eq 'uninstall') { Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false }
  }
}
$task = Get-ScheduledTask -TaskPath $taskPath | Where-Object { $_.TaskName -eq $taskName } | Select-Object -First 1
if ($null -eq $task) { @{ installed = $false; name = $taskName } | ConvertTo-Json -Compress }
else {
  $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath
  @{ installed = $true; name = $taskName; state = [string]$task.State; lastTaskResult = $info.LastTaskResult; lastRunTime = [string]$info.LastRunTime } | ConvertTo-Json -Compress
}
` });
    // Built-in Windows PowerShell 5.1 treats UTF-8 without BOM as ANSI.
    for(const artifact of artifacts)if(artifact.path.endsWith('.ps1'))artifact.content='\ufeff'+artifact.content;
    for (const action of actions) commands[action] = [{ file: windowsPowerShell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", manager, "-Action", action], description: `${action} the owned per-user scheduled task` }];
    return { platform: options.platform, serviceName: name, ownerId, serviceDirectory, installPath: taskXml, target: name, artifacts, commands };
  }
  const home = options.homeDir ?? (process.platform === "darwin" ? os.homedir() : "");
  const uid = options.userId ?? (process.platform === "darwin" ? process.getuid?.() : undefined);
  if (!p.isAbsolute(home) || /[\x00-\x1f]/.test(home)) throw new Error("homeDir must be an absolute macOS path when rendering a macOS plan on another OS.");
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 1) throw new Error("userId must be a positive macOS user ID; per-user services do not run as root.");
  const label = `local.pi-durable.${name}`;
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const installPath = p.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <!-- PiDurableServiceOwner: ${xml(ownerId)} -->
  <key>ProgramArguments</key><array>${[options.nodePath, ...argv].map((s) => `<string>${xml(s)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(options.projectDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${options.entryPath?'<dict><key>SuccessfulExit</key><false/></dict>':'<true/>'}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(p.join(logs, "service.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(p.join(logs, "service.stderr.log"))}</string>
</dict></plist>
`;
  const staged = p.join(serviceDirectory, `${label}.plist`);
  artifacts.push({ path: staged, content: plist, mode: 0o600 });
  const cmd = (args: string[], description: string, condition?: string): ServiceCommand => ({ file: "/bin/launchctl", args, description, ...(condition ? { condition } : {}) });
  const probe = cmd(["print", target], "query the user's launchd job");
  const bootstrap = cmd(["bootstrap", domain, installPath], "load the owned LaunchAgent", "when unloaded");
  const enable = cmd(["enable", target], "enable the owned LaunchAgent");
  const stop = cmd(["bootout", target], "unload and stop the owned LaunchAgent", "when loaded");
  commands.install = [probe, { file: "/usr/bin/plutil", args: ["-lint", staged], description: "validate the generated property list" }, { ...stop, condition: "when loaded and the owned plist changed" }, enable, bootstrap];
  commands.start = [probe, enable, bootstrap, cmd(["kickstart", target], "start the owned job without restarting an already running instance")];
  commands.stop = [probe, stop];
  commands.status = [probe];
  commands.uninstall = [probe, stop];
  return { platform: options.platform, serviceName: name, ownerId, serviceDirectory, installPath, target, artifacts, commands };
}

const nativeContext: ServiceExecutionContext = {
  platform: process.platform,
  async run(command) {
    return await new Promise<CommandOutput>((resolve, reject) => {
      const child = spawn(command.file, command.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
  },
  async read(file) { try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
  async write(file, content, mode) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try { await fs.writeFile(temporary, content, { mode, flag: "wx" }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  },
  async remove(file) { await fs.rm(file, { force: true }); },
  async isSymlink(file) { try { return (await fs.lstat(file)).isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
};

/** Pure dry-run by default. Installation is an explicit operation by the generated app's user. */
export async function runServiceAction(action: ServiceAction, options: ServiceOptions & { execute?: boolean }, context: ServiceExecutionContext = nativeContext): Promise<ServiceRunResult> {
  if (!actions.includes(action)) throw new Error("Unknown service action.");
  const plan = createServicePlan(options);
  const result: ServiceRunResult = { plan, action, executed: false, output: [] };
  if (!options.execute) return result;
  if (context.platform !== options.platform) throw new Error("A service action must execute on its target operating system. Use dry-run to inspect another platform.");
  const p = options.platform === "win32" ? path.win32 : path.posix;
  const marker = plan.artifacts[0]!;
  if (await context.isSymlink(plan.serviceDirectory)) throw new Error("Refusing a symlinked service directory.");
  for (const artifact of plan.artifacts) if (await context.isSymlink(artifact.path)) throw new Error("Refusing a symlinked service artifact.");
  const existingMarker = await context.read(marker.path);
  if (existingMarker !== undefined && existingMarker !== marker.content) throw new Error("This dataDir/service belongs to another service configuration.");
  if (existingMarker === undefined) {
    for (const artifact of plan.artifacts.slice(1)) if (await context.read(artifact.path) !== undefined) throw new Error("Refusing to overwrite service artifacts without an ownership marker.");
  }
  const run = async (command: ServiceCommand, allowMissing = false) => {
    const output = await context.run(command);
    result.output.push({ command, ...output });
    if (output.exitCode !== 0 && !(allowMissing && /could not find service|service .*not found/i.test(output.stderr))) throw new Error(`${command.description} failed (${output.exitCode}): ${output.stderr.trim()}`);
    return output;
  };
  if (options.platform === "win32") {
    for (const artifact of plan.artifacts) await context.write(artifact.path, artifact.content, artifact.mode);
    await run(plan.commands[action][0]!);
    result.executed = true;
    return result;
  }
  if (await context.isSymlink(plan.installPath)) throw new Error("Refusing a symlinked LaunchAgent property list.");
  const existingPlist = await context.read(plan.installPath);
  if (existingPlist !== undefined && !existingPlist.includes(`<!-- PiDurableServiceOwner: ${xml(plan.ownerId)} -->`)) throw new Error("Refusing to modify an unrelated LaunchAgent with the same label.");
  const probe = await run(plan.commands.status[0]!, true);
  const loaded = probe.exitCode === 0;
  if (loaded && existingPlist === undefined) throw new Error("A launchd job with this label already exists without an owned property list.");
  const plist = plan.artifacts[1]!;
  const launch = (args: string[], description: string): ServiceCommand => ({ file: "/bin/launchctl", args, description });
  const domain = plan.target.slice(0, plan.target.lastIndexOf("/"));
  if (action === "install") {
    for (const artifact of plan.artifacts) await context.write(artifact.path, artifact.content, artifact.mode);
    await run(plan.commands.install[1]!);
    // launchd opens log files before starting the process; create their directory first.
    const logDirectory = p.join(options.dataDir, "logs");
    if (await context.read(p.join(logDirectory, ".service-logs")) === undefined) await context.write(p.join(logDirectory, ".service-logs"), "Service stdout and stderr logs.\n", 0o600);
    if (loaded && existingPlist !== plist.content) await run(launch(["bootout", plan.target], "unload the previous owned LaunchAgent"));
    await context.write(plan.installPath, plist.content, 0o600);
    await run(launch(["enable", plan.target], "enable the owned LaunchAgent"));
    if (!loaded || existingPlist !== plist.content) await run(launch(["bootstrap", domain, plan.installPath], "load the owned LaunchAgent"));
  } else if (action === "start") {
    if (existingPlist === undefined) throw new Error("Service is not installed. Run service install first.");
    await run(launch(["enable", plan.target], "enable the owned LaunchAgent"));
    if (!loaded) await run(launch(["bootstrap", domain, plan.installPath], "load the owned LaunchAgent"));
    await run(launch(["kickstart", plan.target], "start the owned LaunchAgent"));
  } else if (action === "stop" || action === "uninstall") {
    if (loaded) await run(launch(["bootout", plan.target], "stop and unload the owned LaunchAgent"));
    if (action === "uninstall" && existingPlist !== undefined) await context.remove(plan.installPath);
  }
  result.executed = true;
  return result;
}
