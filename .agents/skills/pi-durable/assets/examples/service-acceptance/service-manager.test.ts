import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createServicePlan, quoteWindowsArgument, runServiceAction, type ServiceCommand, type ServiceExecutionContext, type ServiceOptions } from "../src/service-manager.js";

const win: ServiceOptions = { platform: "win32", projectDir: "C:\\Work Space\\O'Brien & Agents", configPath: "C:\\Work Space\\O'Brien & Agents\\config.json", dataDir: "C:\\Users\\Tester\\Pi Data", nodePath: "C:\\Program Files\\nodejs\\node.exe" };
const mac: ServiceOptions = { platform: "darwin", projectDir: '/Users/tester/Work Space/Agent "One"', configPath: '/Users/tester/Work Space/Agent "One"/config.json', dataDir: "/Users/tester/Library/Application Support/Pi Agents", nodePath: "/opt/homebrew/bin/node", homeDir: "/Users/tester", userId: 501 };

function memoryContext(platform: string) {
  const files = new Map<string, string>();
  const calls: ServiceCommand[] = [];
  const symlinks = new Set<string>();
  let loaded = false;
  const context: ServiceExecutionContext = {
    platform,
    async run(command) {
      calls.push(command);
      const operation = command.args[0];
      if (operation === "print" && !loaded) return { stdout: "", stderr: "Could not find service in domain for user gui: 501", exitCode: 113 };
      if (operation === "bootstrap") loaded = true;
      if (operation === "bootout") loaded = false;
      return { stdout: operation === "print" ? "state = running\n" : "", stderr: "", exitCode: 0 };
    },
    async read(file) { return files.get(file); },
    async write(file, content) { files.set(file, content); },
    async remove(file) { files.delete(file); },
    async isSymlink(file) { return symlinks.has(file); },
  };
  return { context, files, calls, symlinks, setLoaded: (value: boolean) => { loaded = value; } };
}

test("plans reject unsupported platforms, unsafe names, relative paths, and control characters", () => {
  for (const serviceName of ["../other", "Pi Agent", "a;b", "a.b", "a".repeat(49), "-agent"]) assert.throws(() => createServicePlan({ ...win, serviceName }), /serviceName/);
  assert.throws(() => createServicePlan({ ...win, configPath: "config.json" }), /absolute path/);
  assert.throws(() => createServicePlan({ ...mac, nodePath: "/usr/bin/node\nother" }), /control characters/);
  assert.throws(() => createServicePlan({ ...mac, userId: 0 }), /user ID/);
  assert.throws(() => createServicePlan({ ...mac, userId: 1.5 }), /user ID/);
  assert.throws(() => createServicePlan({ ...mac, homeDir: "relative" }), /homeDir/);
  assert.throws(() => createServicePlan({ ...win, platform: "linux" as "win32" }), /Windows and macOS/);
});

test("Windows argv quoting doubles backslashes correctly at quote boundaries", () => {
  assert.equal(quoteWindowsArgument("a b"), '"a b"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument("C:\\space path\\"), '"C:\\space path\\\\"');
});

test("Windows plan is scoped to current user with restart, hidden execution, and ownership checks", () => {
  const plan = createServicePlan(win);
  const task = plan.artifacts.find((a) => a.path.endsWith("task.xml"))!.content;
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>255<\/Count>/);
  assert.match(task, /<Hidden>true<\/Hidden>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(task, /O&apos;Brien &amp; Agents/);
  const runner = plan.artifacts.find((a) => a.path.endsWith("run-service.ps1"))!.content;
  assert.equal(runner.charCodeAt(0),0xfeff,'PowerShell 5.1 requires an explicit UTF-8 BOM for Unicode literals.');
  assert.match(runner, /O''Brien & Agents/);
  assert.match(runner, /exit \$LASTEXITCODE/);
  assert.match(runner, /1>> .*service\.stdout\.log/);
  const manager = plan.artifacts.find((a) => a.path.endsWith("manage-service.ps1"))!.content;
  assert.equal(manager.charCodeAt(0),0xfeff);
  assert.match(manager, /Refusing to modify an unrelated scheduled task/);
  assert.match(manager, /WindowsIdentity.*GetCurrent/);
  assert.match(manager, /Stop-ScheduledTask/);
  assert.match(manager, /Unregister-ScheduledTask/);
  for (const action of ["install", "start", "stop", "status", "uninstall"] as const) assert.deepEqual(plan.commands[action][0]!.args.slice(-2), ["-Action", action]);
});

test("macOS plan uses exact argv, per-user launchd domain, logs, and bootout for stop", () => {
  const plan = createServicePlan(mac);
  const plist = plan.artifacts[1]!.content;
  assert.equal(plan.target, "gui/501/local.pi-durable.pi-agent-service");
  assert.equal(plan.installPath, "/Users/tester/Library/LaunchAgents/local.pi-durable.pi-agent-service.plist");
  assert.match(plist, /Agent &quot;One&quot;/);
  assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /service\.stderr\.log/);
  assert.equal(plan.commands.stop[1]!.args[0], "bootout");
  assert.equal(plan.commands.start.at(-1)!.args[0], "kickstart");
  assert.ok(!plan.commands.start.at(-1)!.args.includes("-k"), "start should not restart an already running daemon");
  assert.ok(!plist.includes("EnvironmentVariables"));
});

test("owner identity is stable, case-insensitive on Windows, and configuration-specific", () => {
  assert.equal(createServicePlan(win).ownerId, createServicePlan({ ...win, projectDir: win.projectDir.toLowerCase() }).ownerId);
  assert.notEqual(createServicePlan(win).ownerId, createServicePlan({ ...win, configPath: "C:\\Other\\config.json" }).ownerId);
  assert.notEqual(createServicePlan(mac).ownerId, createServicePlan({ ...mac, projectDir: mac.projectDir.toLowerCase() }).ownerId);
});

test('managed login hosts use exact project entry ownership and do not restart after a clean macOS shutdown',()=>{
  const windows=createServicePlan({...win,entryPath:path.win32.join(win.projectDir,'agent-host.mjs')});
  const runner=windows.artifacts.find(item=>item.path.endsWith('run-service.ps1'))!.content;
  assert.match(runner,/agent-host\.mjs/);assert.doesNotMatch(runner,/"serve"|'serve'/);
  assert.notEqual(windows.ownerId,createServicePlan(win).ownerId);
  const managedMac=createServicePlan({...mac,entryPath:path.posix.join(mac.projectDir,'agent-host.mjs')});
  const plist=managedMac.artifacts[1]!.content;
  assert.match(plist,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist,/agent-host\.mjs/);assert.doesNotMatch(plist,/<string>serve<\/string>/);
  assert.notEqual(managedMac.ownerId,createServicePlan(mac).ownerId);
  for(const entryPath of ['relative/agent-host.mjs','/tmp/agent-host.mjs',path.posix.join(mac.projectDir,'another.mjs')])assert.throws(()=>createServicePlan({...mac,entryPath}),/entryPath/);
});

test('managed native execution refuses generic ownership and preserves clean-stop plans on both platforms',async()=>{
  for(const options of [win,mac]){
    const p=options.platform==='win32'?path.win32:path.posix,managed={...options,entryPath:p.join(options.projectDir,'agent-host.mjs')};
    const generic=createServicePlan(options),context=memoryContext(options.platform);
    context.files.set(generic.artifacts[0]!.path,generic.artifacts[0]!.content);
    await assert.rejects(runServiceAction('install',{...managed,execute:true},context.context),/another service configuration/);
    assert.equal(context.calls.length,0);context.files.clear();
    const installed=await runServiceAction('install',{...managed,execute:true},context.context);
    assert.equal(installed.executed,true);assert.ok(installed.plan.artifacts.some(item=>item.content.includes('agent-host.mjs')));
    await runServiceAction('status',{...managed,execute:true},context.context);
    await runServiceAction('uninstall',{...managed,execute:true},context.context);
    assert.ok(context.files.has(installed.plan.artifacts[0]!.path),'Owned local state is retained after unregister.');
  }
});

test("dry-run performs no IO or command execution on either platform", async () => {
  for (const options of [win, mac]) {
    const mock = memoryContext(options.platform);
    for (const action of ["install", "start", "stop", "status", "uninstall"] as const) {
      const result = await runServiceAction(action, options, mock.context);
      assert.equal(result.executed, false);
      assert.equal(result.output.length, 0);
    }
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.files.size, 0);
  }
});

test("execution rejects the wrong platform and unrelated staged artifacts", async () => {
  await assert.rejects(runServiceAction("install", { ...mac, execute: true }, memoryContext("win32").context), /target operating system/);
  const mock = memoryContext("win32");
  const plan = createServicePlan(win);
  mock.files.set(plan.artifacts[1]!.path, "unrelated");
  await assert.rejects(runServiceAction("install", { ...win, execute: true }, mock.context), /without an ownership marker/);
  assert.equal(mock.calls.length, 0);
});

test("Windows execution writes only local owned artifacts and invokes exact command arrays", async () => {
  const mock = memoryContext("win32");
  for (const action of ["install", "start", "status", "stop", "uninstall"] as const) {
    const result = await runServiceAction(action, { ...win, execute: true }, mock.context);
    assert.equal(result.executed, true);
    assert.deepEqual(mock.calls.at(-1), result.plan.commands[action][0]);
  }
  assert.equal(mock.files.size, 4);
  assert.ok([...mock.files.keys()].every((file) => file.startsWith(win.dataDir + "\\service\\")));
});

test("macOS install/start/stop/uninstall are idempotent and preserve local state", async () => {
  const mock = memoryContext("darwin");
  const plan = createServicePlan(mac);
  await runServiceAction("install", { ...mac, execute: true }, mock.context);
  assert.equal(mock.files.get(plan.installPath), plan.artifacts[1]!.content);
  assert.ok(mock.files.has(mac.dataDir + "/logs/.service-logs"));
  const bootstraps = () => mock.calls.filter((c) => c.args[0] === "bootstrap").length;
  assert.equal(bootstraps(), 1);
  await runServiceAction("install", { ...mac, execute: true }, mock.context);
  assert.equal(bootstraps(), 1);
  await runServiceAction("start", { ...mac, execute: true }, mock.context);
  assert.equal(bootstraps(), 1);
  await runServiceAction("stop", { ...mac, execute: true }, mock.context);
  assert.ok(mock.files.has(plan.installPath));
  await runServiceAction("stop", { ...mac, execute: true }, mock.context);
  await runServiceAction("start", { ...mac, execute: true }, mock.context);
  assert.equal(bootstraps(), 2);
  await runServiceAction("uninstall", { ...mac, execute: true }, mock.context);
  assert.ok(!mock.files.has(plan.installPath));
  assert.ok(mock.files.has(plan.artifacts[0]!.path));
  await runServiceAction("uninstall", { ...mac, execute: true }, mock.context);
});

test("macOS changed owned plist reloads while unrelated files and unmanaged loaded labels are protected", async () => {
  const mock = memoryContext("darwin");
  const plan = createServicePlan(mac);
  mock.files.set(plan.installPath, "unrelated");
  await assert.rejects(runServiceAction("install", { ...mac, execute: true }, mock.context), /unrelated LaunchAgent/);
  mock.files.delete(plan.installPath);
  mock.setLoaded(true);
  await assert.rejects(runServiceAction("install", { ...mac, execute: true }, mock.context), /without an owned property list/);
  mock.setLoaded(false);
  await runServiceAction("install", { ...mac, execute: true }, mock.context);
  mock.files.set(plan.installPath, plan.artifacts[1]!.content.replace("<integer>10</integer>", "<integer>20</integer>"));
  const previous = mock.calls.length;
  await runServiceAction("install", { ...mac, execute: true }, mock.context);
  const operations = mock.calls.slice(previous).map((c) => c.args[0]);
  assert.ok(operations.indexOf("bootout") < operations.indexOf("bootstrap"));
});

test("missing job status is allowed, but launchctl access and bootstrap errors are surfaced", async () => {
  const mock = memoryContext("darwin");
  const result = await runServiceAction("status", { ...mac, execute: true }, mock.context);
  assert.equal(result.output[0]!.exitCode, 113);
  mock.context.run = async () => ({ exitCode: 1, stdout: "", stderr: "Operation not permitted" });
  await assert.rejects(runServiceAction("status", { ...mac, execute: true }, mock.context), /Operation not permitted/);
  mock.context.run = async (command) => command.args[0] === "print" ? { exitCode: 113, stdout: "", stderr: "Could not find service" } : { exitCode: 5, stdout: "", stderr: "Input/output error" };
  await assert.rejects(runServiceAction("install", { ...mac, execute: true }, mock.context), /Input\/output error/);
});

test("symlinked service directories, artifacts, and installed plists are protected", async () => {
  for (const options of [win, mac]) {
    const plan = createServicePlan(options);
    for (const file of [plan.serviceDirectory, plan.artifacts[0]!.path, ...(options.platform === "darwin" ? [plan.installPath] : [])]) {
      const mock = memoryContext(options.platform);
      mock.symlinks.add(file);
      await assert.rejects(runServiceAction("install", { ...options, execute: true }, mock.context), /symlinked/);
      assert.equal(mock.calls.length, 0);
    }
  }
});

test("generated XML parses and generated PowerShell passes the native AST parser", { skip: process.platform !== "win32" }, async () => {
  // Keep generated validation artifacts in the caller's workspace, never the skill bundle.
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".service-validation-"));
  try {
    const plan = createServicePlan({ ...win, dataDir: directory });
    for (const artifact of plan.artifacts) { await fs.mkdir(path.dirname(artifact.path), { recursive: true }); await fs.writeFile(artifact.path, artifact.content); }
    const scripts = plan.artifacts.filter((artifact) => artifact.path.endsWith(".ps1"));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const parse = scripts.map((script) => `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile(${quote(script.path)}, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { throw ($errors | Out-String) }`).join("\n");
    const task = plan.artifacts.find((artifact) => artifact.path.endsWith("task.xml"))!;
    const macPlist = path.join(directory, "mac.plist");
    await fs.writeFile(macPlist, createServicePlan(mac).artifacts[1]!.content);
    const source = `$ErrorActionPreference = 'Stop'\n${parse}\n[xml]$task = [System.IO.File]::ReadAllText(${quote(task.path)})\nif ($task.Task.Settings.ExecutionTimeLimit -ne 'PT0S') { throw 'Wrong execution limit' }\n[xml]$plist = [System.IO.File]::ReadAllText(${quote(macPlist)})\nif ($plist.plist.dict.array.string.Count -ne 5) { throw 'Wrong ProgramArguments count' }\nWrite-Output 'PowerShell AST and both XML formats pass'\n`;
    const validation = path.join(directory, "validate.ps1");
    await fs.writeFile(validation, source);
    const parsed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", validation], { encoding: "utf8", windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("generated Windows manager runs all actions against mocked Task Scheduler cmdlets", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".service-validation-"));
  try {
    const plan = createServicePlan({ ...win, dataDir: directory });
    for (const artifact of plan.artifacts) { await fs.mkdir(path.dirname(artifact.path), { recursive: true }); await fs.writeFile(artifact.path, artifact.content); }
    const manager = plan.artifacts.find((artifact) => artifact.path.endsWith("manage-service.ps1"))!;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const source = `$ErrorActionPreference = 'Stop'
$global:testTask = $null
$global:registerCalls = 0
function Get-ScheduledTask { param($TaskName, $TaskPath) if ($null -ne $global:testTask) { $global:testTask } }
function Register-ScheduledTask {
  param($TaskName, $TaskPath, $Xml, [switch]$Force)
  [xml]$parsed = $Xml
  if ($parsed.Task.Principals.Principal.UserId -notmatch '^S-1-') { throw 'The actual user SID was not substituted' }
  if ($parsed.Task.Principals.Principal.RunLevel -ne 'LeastPrivilege') { throw 'Privilege escalation requested' }
  $global:testTask = [pscustomobject]@{ TaskName = $TaskName; Description = [string]$parsed.Task.RegistrationInfo.Description; State = 'Ready' }
  $global:registerCalls++
}
function Start-ScheduledTask { param($TaskName, $TaskPath) $global:testTask.State = 'Running' }
function Stop-ScheduledTask { param($TaskName, $TaskPath) $global:testTask.State = 'Ready' }
function Unregister-ScheduledTask { param($TaskName, $TaskPath, [switch]$Confirm) $global:testTask = $null }
function Get-ScheduledTaskInfo { param($TaskName, $TaskPath) [pscustomobject]@{ LastTaskResult = 0; LastRunTime = [DateTime]::UtcNow } }
$manager = ${quote(manager.path)}
$status = & $manager -Action status | ConvertFrom-Json
if ($status.installed) { throw 'Unexpected initial installation' }
$status = & $manager -Action install | ConvertFrom-Json
if (-not $status.installed -or $status.state -ne 'Running') { throw 'Install did not register and start' }
$status = & $manager -Action install | ConvertFrom-Json
if ($global:registerCalls -ne 2) { throw 'Owned reinstall failed' }
$status = & $manager -Action stop | ConvertFrom-Json
if ($status.state -ne 'Ready') { throw 'Stop failed' }
$status = & $manager -Action start | ConvertFrom-Json
if ($status.state -ne 'Running') { throw 'Start failed' }
$global:testTask.Description = 'unrelated-task'
$blocked = $false
try { & $manager -Action uninstall | Out-Null } catch { $blocked = $_.Exception.Message -match 'unrelated scheduled task' }
if (-not $blocked -or $null -eq $global:testTask) { throw 'Unrelated task was not protected' }
$global:testTask.Description = ${quote(plan.ownerId)}
$status = & $manager -Action uninstall | ConvertFrom-Json
if ($status.installed) { throw 'Uninstall failed' }
Write-Output 'All mocked native PowerShell lifecycle actions pass'
`;
    const fixture = path.join(directory, "mock-scheduler.ps1");
    await fs.writeFile(fixture, source);
    const executed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], { encoding: "utf8", windowsHide: true });
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("generated Windows runner executes real Node with quoted paths, logs, and its exit code", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".service-validation-"));
  try {
    const projectDir = path.join(directory, "O'Brien & Agent Space");
    const dataDir = path.join(directory, "Service Data & Logs");
    const configPath = path.join(projectDir, "O'Brien config.json");
    await fs.mkdir(path.join(projectDir, "dist", "src"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "dist", "src", "cli.js"), "console.log(JSON.stringify(process.argv.slice(2))); console.error('runner-stderr-check'); process.exitCode = 7;\n");
    const plan = createServicePlan({ platform: "win32", projectDir, dataDir, configPath, nodePath: process.execPath });
    const runner = plan.artifacts.find((artifact) => artifact.path.endsWith("run-service.ps1"))!;
    await fs.mkdir(path.dirname(runner.path), { recursive: true });
    await fs.writeFile(runner.path, runner.content);
    const executed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", runner.path], { encoding: "utf8", windowsHide: true });
    assert.equal(executed.status, 7, executed.stdout + executed.stderr);
    // Windows PowerShell 5.1 redirection writes UTF-16LE; pwsh uses UTF-8.
    const readLog = async (name: string) => {
      const bytes = await fs.readFile(path.join(dataDir, "logs", name));
      return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
    };
    assert.deepEqual(JSON.parse((await readLog("service.stdout.log")).trim()), ["serve", "--config", configPath]);
    assert.match(await readLog("service.stderr.log"), /runner-stderr-check/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(process.cwd()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
