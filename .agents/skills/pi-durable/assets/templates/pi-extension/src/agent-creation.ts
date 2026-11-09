// Pi loads TypeScript directly. Create independent services through explicit Node argv.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableClient, type ServiceConnection } from './client.js';

export type AgentTask = 'routine' | 'coding' | 'review' | 'research' | 'reflection';
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AgentCreationInput {
  id: string; name: string; baseDir: string; instructions: string;
  task?: AgentTask; model?: string; thinkingLevel?: AgentThinkingLevel; repository?: string;
}
export interface AgentCreationContext {
  cwd: string; extensionDir: string; connectionsFile?: string;
  piCliPath?: string; npmCliPath?: string; serviceTemplateDir?: string;
  /** Offline acceptance fixtures only; the interactive wizard uses Codex. */
  provider?: 'openai-codex' | 'faux';
}
export interface PreparedAgentCreation {
  readonly id: string; readonly name: string; readonly baseDir: string; readonly instructions: string;
  readonly projectDir: string; readonly configPath: string; readonly connectionsFile: string;
  readonly target: string; readonly provider: 'openai-codex' | 'faux';
  readonly requestedModel: string; readonly task: AgentTask;
  readonly thinkingLevel?: AgentThinkingLevel; readonly repository?: string;
}
export interface CreatedAgentReceipt {
  target: string; configPath: string; projectDir: string; baseDir: string;
  connectionsFile: string; pid: number; status: 'running'; requestedModel: string; task: AgentTask;
  resolvedModel?: string; thinkingLevel?: string;
  management?: {descriptorPath:string;controlCliPath:string};
}
export interface CreateAgentOptions { signal?: AbortSignal; onProgress?: (message: string) => void }
export class AgentCreationError extends Error {
  constructor(readonly code: string, message: string, readonly projectDir?: string, readonly pid?: number) {
    super(message); this.name = 'AgentCreationError';
  }
}
interface Resource { name: string; bytes: Buffer }
interface PrivatePlan { files: Resource[]; npmCliPath: string; piCliPath?: string; state: 'ready' | 'started' }
const plans = new WeakMap<PreparedAgentCreation, PrivatePlan>();
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const TASKS: AgentTask[] = ['routine', 'coding', 'review', 'research', 'reflection'];
const EFFORTS: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CONFIG_LIMIT = 256 * 1024;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function error(code: string, message: string): never { throw new AgentCreationError(code, message); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) error('cancelled', 'Agent creation was cancelled.'); }
function hash(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
function inside(root: string, path: string) { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); }
function samePath(left: string, right: string) { return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
async function exists(path: string) { try { await lstat(path); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; } }
async function bounded(path: string, limit = CONFIG_LIMIT): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > limit) error('file_too_large', 'A creation resource exceeds its size limit.');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
interface Registry { version: 1; services: Array<{ id: string; name?: string; configPath: string }> }
async function registry(path: string): Promise<{ value: Registry; bytes?: Buffer }> {
  if (!await exists(path)) return { value: { version: 1, services: [] } };
  let bytes: Buffer, value: unknown;
  try { bytes = await bounded(path); value = JSON.parse(bytes.toString('utf8')); }
  catch { return error('registry_invalid', 'The selected connection registry cannot be read as a bounded JSON file.'); }
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'services'].includes(key)) || !Array.isArray(value.services) || value.services.length > 32) error('registry_invalid', 'The selected connection registry must use version 1 and up to 32 services.');
  const ids = new Set<string>();
  for (const item of value.services) {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id) || typeof item.configPath !== 'string' || !item.configPath.trim() || item.configPath.length > 4096 || /[\x00-\x1f\x7f]/.test(item.configPath) || Object.keys(item).some(key => !['id', 'name', 'configPath'].includes(key)) || item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 || /[\x00-\x1f\x7f]/.test(item.name))) error('registry_invalid', 'The selected connection registry contains an invalid or duplicate service.');
    ids.add(item.id);
  }
  return { value: value as unknown as Registry, bytes };
}
async function availableRegistry(path: string, id: string) {
  const current = await registry(path);
  if (current.value.services.some(service => service.id === id)) error('duplicate_service', 'A service already uses that ID. Choose another agent ID.');
  if (current.value.services.length >= 32) error('registry_full', 'The selected registry already contains the maximum of 32 services.');
  return current;
}
async function resourceFiles(directory: string): Promise<Resource[]> {
  const root = await realpath(directory); const files: Resource[] = []; let total = 0;
  async function visit(folder: string) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'dist', 'state', 'logs', '.npm-cache', 'tests'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) error('template_invalid', 'The service template must contain ordinary files and directories.');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await bounded(path, 2 * 1024 * 1024); total += bytes.length;
        if (files.length >= 256 || total > 10 * 1024 * 1024) error('template_invalid', 'The service template exceeds its bounded resource budget.');
        files.push({ name: relative(root, path).split(sep).join('/'), bytes });
      } else error('template_invalid', 'The service template contains an unsupported resource.');
    }
  }
  await visit(root);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/config.ts', 'src/server.ts', 'src/tools/workspace.ts']) if (!files.some(file => file.name === name)) error('template_missing', 'The independent service template is incomplete. Reinstall the updated extension package.');
  const packageFile = JSON.parse(files.find(file => file.name === 'package.json')!.bytes.toString('utf8'));
  if (packageFile.type !== 'module') error('template_invalid', 'The service template must declare an ES module package.');
  return files;
}
async function scriptPath(candidates: Array<string | undefined>, kind: 'pi' | 'npm'): Promise<string> {
  for (const candidate of [...new Set(candidates.filter((value): value is string => !!value))]) {
    if (!isAbsolute(candidate) || !/\.(?:mjs|cjs|js)$/i.test(candidate)) continue;
    try {
      const path = await realpath(candidate); if (!(await stat(path)).isFile()) continue;
      if (kind === 'npm' && basename(path) !== 'npm-cli.js') continue;
      if (kind === 'pi') {
        let parent = dirname(path), valid = false;
        for (let level = 0; level < 4; level++) {
          try { const pkg = JSON.parse((await bounded(join(parent, 'package.json'))).toString('utf8')); if (pkg.name === '@earendil-works/pi-coding-agent') { valid = true; break; } } catch { /* Continue to the package root. */ }
          parent = dirname(parent);
        }
        if (!valid) continue;
      }
      return path;
    } catch { /* Probe another installed JavaScript entry. */ }
  }
  return error('runtime_missing', kind === 'npm' ? 'The installed npm CLI JavaScript entry could not be found. Install Node.js with npm, then retry.' : 'The installed Pi CLI JavaScript entry could not be found. Set PI_CLI_PATH to its absolute dist/cli.js path, then retry.');
}
function runtimeCandidates(kind: 'pi' | 'npm'): string[] {
  const suffix = kind === 'pi' ? ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'] : ['npm', 'bin', 'npm-cli.js'];
  const roots = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).slice(0, 64)];
  return roots.flatMap(root => [join(root, 'node_modules', ...suffix), resolve(root, '../lib/node_modules', ...suffix)]);
}

/** Prepare a reviewable plan without creating files, installing packages or starting processes. */
export async function prepareAgentCreation(input: AgentCreationInput, context: AgentCreationContext): Promise<PreparedAgentCreation> {
  if (typeof input.id !== 'string' || !ID.test(input.id) || RESERVED.test(input.id)) error('id_invalid', 'Use an agent ID with a lowercase letter followed by lowercase letters, digits or hyphens (48 characters maximum; Windows device names are reserved).');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(input.name)) error('name_invalid', 'Use a nonempty agent name of up to 120 characters.');
  if (typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > 24000 || /\x00/.test(input.instructions)) error('instructions_invalid', 'Provide nonempty instructions of up to 24,000 characters.');
  if (typeof input.baseDir !== 'string' || !isAbsolute(input.baseDir) || input.baseDir.length > 4096 || /[\x00-\x1f\x7f]/.test(input.baseDir)) error('folder_invalid', 'Choose an absolute path to an existing base folder.');
  const task = input.task ?? 'coding', requestedModel = input.model ?? 'latest';
  if (!TASKS.includes(task) || input.thinkingLevel !== undefined && !EFFORTS.includes(input.thinkingLevel)) error('model_invalid', 'Choose a known task profile and a supported Pi reasoning-level name.');
  if (typeof requestedModel !== 'string' || !requestedModel || requestedModel.length > 256 || /[\s\x00-\x1f\x7f]/.test(requestedModel) || requestedModel.startsWith('latest') && !['latest', 'latest:sol', 'latest:astra', 'latest:luna'].includes(requestedModel)) error('model_invalid', 'Use latest, a supported latest:family policy, or an exact model ID.');
  if (input.repository !== undefined && (typeof input.repository !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository))) error('repository_invalid', 'Use a GitHub repository in owner/name form, or leave it empty for manual chat.');
  let baseDir: string;
  try { baseDir = await realpath(input.baseDir); if (!(await stat(baseDir)).isDirectory()) throw new Error(); }
  catch { return error('folder_invalid', 'The base folder must exist and be an accessible directory.'); }
  const projectDir = join(baseDir, '.pi', 'durable', input.id);
  // Reject redirected .pi/durable ancestors: this project belongs under the reviewed folder.
  for (const ancestor of [join(baseDir, '.pi'), join(baseDir, '.pi', 'durable')]) if (await exists(ancestor) && (!(await lstat(ancestor)).isDirectory() || (await lstat(ancestor)).isSymbolicLink() || !inside(baseDir, await realpath(ancestor)))) error('folder_redirected', 'The base folder .pi/durable path must remain inside the selected folder without symbolic-link redirection.');
  if (await exists(projectDir)) error('destination_exists', 'That agent project already exists in the selected folder. Choose another ID or folder.');
  let connectionsFile = resolve(context.cwd, context.connectionsFile ?? '.pi/durable-agents.json');
  if (await exists(connectionsFile)) connectionsFile = await realpath(connectionsFile);
  await availableRegistry(connectionsFile, input.id);
  let files: Resource[];
  try { files = await resourceFiles(context.serviceTemplateDir ?? join(context.extensionDir, 'service-template')); }
  catch (cause) { if (cause instanceof AgentCreationError) throw cause; return error('template_missing', 'The independent service template is unavailable. Reinstall the updated extension package.'); }
  // Freeze Node-only management resources alongside the reviewed service bytes.
  const consoleSource=dirname(fileURLToPath(import.meta.url));
  for(const name of ['agent-management.ts','client.ts','display.ts','control-cli.ts']){
    const bytes=await bounded(join(consoleSource,name),256*1024);
    files.push({name:'src/console/'+name,bytes});
  }
  const provider = context.provider ?? 'openai-codex';
  if (!['openai-codex', 'faux'].includes(provider)) error('provider_invalid', 'Agent creation supports Codex or an explicit offline acceptance fixture.');
  const npmCliPath = await scriptPath([context.npmCliPath, process.env.npm_execpath, ...runtimeCandidates('npm')], 'npm');
  const piCliPath = provider === 'faux' ? undefined : await scriptPath([context.piCliPath, process.env.PI_CLI_PATH, process.argv[1], ...runtimeCandidates('pi')], 'pi');
  const prepared = Object.freeze({ id: input.id, name: input.name.trim(), baseDir, instructions: input.instructions.trim(), projectDir, configPath: join(projectDir, 'config.json'), connectionsFile, target: `${input.id}/${input.id}`, provider, requestedModel, task, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), ...(input.repository ? { repository: input.repository.toLowerCase() } : {}) });
  plans.set(prepared, { files, npmCliPath, piCliPath, state: 'ready' });
  return prepared;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((accept, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('No local port assigned.')); return; }
      server.close(cause => cause ? reject(cause) : accept(address.port));
    });
  });
}
async function runNode(args: string[], cwd: string, logPath: string, signal?: AbortSignal, timeoutMs = 180_000) {
  checkAbort(signal);
  const output = openSync(logPath, 'wx', 0o600);
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', output, output], env: { ...process.env, npm_config_cache: join(cwd, '.npm-cache'), npm_config_update_notifier: 'false', FORCE_COLOR: '0' } });
      let settled = false, interrupted: Error | undefined;
      const finish = (cause?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); cause ? reject(cause) : accept(); };
      const cancel = () => { interrupted = new AgentCreationError('cancelled', 'Agent creation was cancelled.'); child.kill(); };
      const timer = setTimeout(() => { interrupted = new AgentCreationError('command_timeout', 'A project setup command timed out.'); child.kill(); }, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      child.once('error', () => finish(new AgentCreationError('command_failed', 'A project setup process could not be started.')));
      child.once('exit', code => finish(interrupted ?? (code === 0 ? undefined : new AgentCreationError('command_failed', 'A project setup command failed.'))));
      if (signal?.aborted) cancel();
    });
  } finally { closeSync(output); }
}
function hostSource() {
  return `// Run node agent-host.mjs or the compiled project-local control CLI. No extension or skill path is needed.
import {readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './dist/src/config.js';
import {AgentService} from './dist/src/server.js';
const project=dirname(fileURLToPath(import.meta.url)),configPath=join(project,'config.json'),nonce=randomUUID();
let service,ownerPath,providerKind,closed=false;
try{
  const config=await loadConfig(configPath);providerKind=config.provider.kind;service=await AgentService.open(config);
  const identity={pid:process.pid,nonce,configPath};service.setManagementOwner(identity);
  ownerPath=join(config.dataDir,'creation-owner.json');
  // State ownership excludes another live host; a stale crash receipt may be replaced.
  const receipt=JSON.stringify({version:1,...identity,url:service.url})+'\\n';
  await writeFile(join(config.dataDir,'last-owner.json'),receipt,{mode:0o600});
  await writeFile(ownerPath,receipt,{mode:0o600});
  let closing=false;const close=()=>{if(closing)return;closing=true;void service.close().catch(()=>{process.exitCode=1;});};
  process.once('SIGINT',close);process.once('SIGTERM',close);
  console.log(JSON.stringify({status:'running',pid:process.pid,url:service.url}));
  await service.closed;closed=true;
}catch(error){if(service)try{await service.close();closed=true;}catch{}console.error(error instanceof Error?error.message:'The independent agent service failed to start.');process.exitCode=1;}
finally{
  // This standalone process owns every Harness and provider session it opened.
  if(closed&&providerKind==='openai-codex')try{const sdk=await import('@earendil-works/pi-ai/api/openai-codex-responses');sdk.closeOpenAICodexWebSocketSessions();}catch{console.error('The owned Codex transport cleanup failed.');process.exitCode=1;}
  if(ownerPath)try{const current=JSON.parse(await readFile(ownerPath,'utf8'));if(current.pid===process.pid&&current.nonce===nonce)await rm(ownerPath,{force:true});}catch{}
}
// SDK transports may retain idle handles; all owned work and receipts are closed above.
for(const stream of [process.stdout,process.stderr])if(stream.writableLength&&!stream.destroyed)await new Promise(resolve=>{const timer=setTimeout(resolve,1000);stream.write('',()=>{clearTimeout(timer);resolve();});});
process.exit(process.exitCode??0);
`;
}
async function appendConnection(prepared: PreparedAgentCreation) {
  const path = prepared.connectionsFile, parent = dirname(path); await mkdir(parent, { recursive: true });
  const lockPath = path + '.creation.lock';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { return error('registry_busy', 'The connection registry is being updated. The new service is running; register its config after the other update finishes.'); }
  let temporary: string | undefined;
  try {
    const current = await availableRegistry(path, prepared.id);
    const relativeConfig = relative(parent, prepared.configPath);
    // Cross-volume Windows registrations use an absolute path; the client accepts both.
    current.value.services.push({ id: prepared.id, name: prepared.name, configPath: isAbsolute(relativeConfig) ? prepared.configPath : relativeConfig.split(sep).join('/') });
    const bytes = Buffer.from(JSON.stringify(current.value, null, 2) + '\n');
    if (bytes.length > CONFIG_LIMIT) error('registry_full', 'Adding the service would exceed the connection registry size limit.');
    temporary = join(parent, '.' + basename(path) + '.' + randomUUID() + '.tmp');
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const now = await registry(path);
    if ((current.bytes === undefined) !== (now.bytes === undefined) || current.bytes && now.bytes && hash(current.bytes) !== hash(now.bytes)) error('registry_changed', 'The connection registry changed during registration. The new service is running; retry registration with its saved config.');
    await rename(temporary, path); temporary = undefined;
  } finally { if (temporary) await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true }); }
}

/** Commit only after the user reviewed the plan. Never touch or restart an existing service. */
export async function createAgent(prepared: PreparedAgentCreation, options: CreateAgentOptions = {}): Promise<CreatedAgentReceipt> {
  const privatePlan = plans.get(prepared);
  if (!privatePlan || privatePlan.state !== 'ready') error('plan_invalid', 'Prepare and review a fresh creation plan before creating an agent.');
  checkAbort(options.signal); privatePlan.state = 'started';
  let created = false, pid: number | undefined;
  const progress = (message: string) => { try { options.onProgress?.(message); } catch { /* UI progress must not affect service ownership. */ } };
  try {
    await availableRegistry(prepared.connectionsFile, prepared.id);
    if (!samePath(await realpath(prepared.baseDir), prepared.baseDir)) error('folder_changed', 'The reviewed base folder changed. Prepare a fresh plan.');
    for (const ancestor of [join(prepared.baseDir, '.pi'), join(prepared.baseDir, '.pi', 'durable')]) if (await exists(ancestor) && (!(await lstat(ancestor)).isDirectory() || (await lstat(ancestor)).isSymbolicLink() || !inside(prepared.baseDir, await realpath(ancestor)))) error('folder_redirected', 'The reviewed .pi/durable destination was redirected. Prepare a fresh plan.');
    progress('Creating the independent agent project');
    await mkdir(dirname(prepared.projectDir), { recursive: true });
    if (!samePath(await realpath(dirname(prepared.projectDir)), dirname(prepared.projectDir))) error('folder_redirected', 'The reviewed .pi/durable destination changed during creation. Prepare a fresh plan.');
    await mkdir(prepared.projectDir); created = true;
    const port = await unusedPort();
    const authored = new Map<string, Buffer>(privatePlan.files.map(file => [file.name, file.bytes]));
    const serviceName = prepared.id.length <= 40 ? `durable-${prepared.id}` : `durable-${prepared.id.slice(0, 31)}-${hash(Buffer.from(prepared.id)).slice(0, 8)}`;
    const config = { version: 1, host: '127.0.0.1', port, dataDir: './state', serviceName, provider: prepared.provider === 'faux' ? { kind: 'faux' } : { kind: 'openai-codex', model: prepared.requestedModel, catalogMode: 'refresh', piCliPath: privatePlan.piCliPath }, github: { mode: prepared.repository ? 'poll' : 'off', intervalMs: 60_000, initialScan: 'baseline' }, agents: [{ id: prepared.id, name: prepared.name, instructions: 'Use the project-local prompt.', instructionsFile: `prompts/${prepared.id}.md`, workspaceRoot: prepared.baseDir, repositories: prepared.repository ? [prepared.repository] : [], modelChoice: { task: prepared.task, ...(prepared.thinkingLevel ? { thinkingLevel: prepared.thinkingLevel } : {}) } }] };
    authored.set('config.json', Buffer.from(JSON.stringify(config, null, 2) + '\n'));
    authored.set(`prompts/${prepared.id}.md`, Buffer.from(prepared.instructions + '\n'));
    authored.set('agent-host.mjs', Buffer.from(hostSource()));
    authored.set('managed-agent.json',Buffer.from(JSON.stringify({version:1,kind:'pi-durable-console-managed',agentId:prepared.id,serviceId:prepared.id,configFile:'config.json',dataDir:'state',hostFile:'agent-host.mjs',hostSha256:hash(authored.get('agent-host.mjs')!)},null,2)+'\n'));
    authored.set('.gitignore', Buffer.from('node_modules/\ndist/\nstate/\nlogs/\n.npm-cache/\ncreation-receipt.json\n'));
    const operations = `\n\n## Console-created service\n\nThis independent project serves ${prepared.id}. Its selected read-only workspace is ${prepared.baseDir}. Model policy ${prepared.requestedModel} uses task ${prepared.task}; the resolved conversation model is persisted in service state. Run commands from this directory.\n\nOperate with \`node dist/src/console/control-cli.js status|start|stop|restart|pause|resume|recover|logs\`. This compiled project-local CLI works without Pi, this extension or the generating skill. Stop requests drain accepted work and use authenticated ownership; a stale PID alone is not proof. \`archive --registry <connections.json>\` unregisters a stopped agent while preserving all files; \`restore --registry <connections.json>\` reconnects it without starting it. Creation does not install automatic login startup. Use the existing service lifecycle commands for an explicitly requested login service.\n\nThe Pi registry is ${prepared.connectionsFile}; the console target is ${prepared.target}. Logs are in \`logs/\`. \`creation-receipt.json\` records whether console registration completed. A setup failure retains this project for diagnosis and never restarts another service. Credentials remain in the installed Pi account and are read only when needed.\n`;
    authored.set('AGENTS.md', Buffer.from((authored.get('AGENTS.md')?.toString('utf8') ?? '# Independent Durable agent\n') + operations));
    for (const [name, bytes] of authored) { checkAbort(options.signal); const target = resolve(prepared.projectDir, name); if (!inside(prepared.projectDir, target)) error('template_invalid', 'A template resource escapes the independent project.'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
    await writeFile(join(prepared.projectDir, 'scaffold-manifest.json'), JSON.stringify({ schemaVersion: 1, template: 'pi-durable-console-created-service-v2', runtimeIndependent: true, createdAt: new Date().toISOString(), baseDir: prepared.baseDir, requestedModel: prepared.requestedModel, task: prepared.task, files: Object.fromEntries([...authored].map(([name, bytes]) => [name, hash(bytes)])) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const logs = join(prepared.projectDir, 'logs'); await mkdir(logs);
    progress('Installing project-local dependencies');
    await runNode([privatePlan.npmCliPath, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], prepared.projectDir, join(logs, 'install.log'), options.signal);
    progress('Building the independent service');
    await runNode([join(prepared.projectDir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], prepared.projectDir, join(logs, 'build.log'), options.signal);
    checkAbort(options.signal); progress('Starting the background service');
    const output = openSync(join(logs, 'host.stdout.log'), 'wx', 0o600), errors = openSync(join(logs, 'host.stderr.log'), 'wx', 0o600);
    try {
      const child = spawn(process.execPath, [join(prepared.projectDir, 'agent-host.mjs')], { cwd: prepared.projectDir, windowsHide: true, detached: true, shell: false, stdio: ['ignore', output, errors] });
      await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', () => reject(new AgentCreationError('start_failed', 'The independent service process could not be started.'))); });
      pid = child.pid; child.unref();
    } finally { closeSync(output); closeSync(errors); }
    if (!pid) error('start_failed', 'The independent service did not receive a process ID.');
    const connection: ServiceConnection = { id: prepared.id, name: prepared.name, configPath: prepared.configPath, dataDir: join(prepared.projectDir, 'state'), baseUrl: `http://127.0.0.1:${port}` };
    const client = new DurableClient(connection, { requestTimeoutMs: 2000 });
    let ready = false; const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      checkAbort(options.signal);
      try {
        const owner = JSON.parse((await bounded(join(connection.dataDir, 'creation-owner.json'), 4096)).toString('utf8'));
        if (owner.pid !== pid || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.nonce) || owner.configPath !== prepared.configPath || owner.url !== connection.baseUrl) error('owner_mismatch', 'An unexpected process owns the new service endpoint.');
        const remaining = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const verifySignal=options.signal?AbortSignal.any([options.signal,remaining]):remaining;
        const status=await client.status({signal:verifySignal});
        if(!object(status.owner)||status.owner.pid!==pid||status.owner.nonce!==owner.nonce||status.owner.configPath!==prepared.configPath)error('owner_mismatch','The authenticated lifecycle endpoint does not match the newly started owner.');
        const listed = await client.list({ signal: verifySignal });
        if (!listed.agents.some(agent => agent.id === prepared.id && agent.active !== false && agent.active !== 0)) error('owner_mismatch', 'The new service did not register the reviewed agent.');
        ready = true; break;
      } catch (cause) { if (cause instanceof AgentCreationError) throw cause; }
      try { process.kill(pid, 0); } catch { error('start_failed', 'The new service exited before becoming ready.'); }
      await delay(Math.max(1, Math.min(500, deadline - Date.now())), undefined, { signal: options.signal });
    }
    if (!ready) error('start_timeout', 'The new service did not become ready within 45 seconds.');
    const receipt: CreatedAgentReceipt = { target: prepared.target, configPath: prepared.configPath, projectDir: prepared.projectDir, baseDir: prepared.baseDir, connectionsFile: prepared.connectionsFile, pid, status: 'running', requestedModel: prepared.requestedModel, task: prepared.task, management:{descriptorPath:join(prepared.projectDir,'managed-agent.json'),controlCliPath:join(prepared.projectDir,'dist/src/console/control-cli.js')} };
    try {
      const snapshot = await client.snapshot(prepared.id, { signal: options.signal });
      if (object(snapshot.docs) && object(snapshot.docs['pi.agent'])) {
        const agent = snapshot.docs['pi.agent'], model = agent.model;
        if (object(model) && typeof model.provider === 'string' && typeof model.modelId === 'string' && /^[a-z0-9:_./-]{1,120}$/i.test(model.provider) && /^[a-z0-9:_./-]{1,200}$/i.test(model.modelId)) receipt.resolvedModel = `${model.provider}/${model.modelId}`;
        if (typeof agent.thinkingLevel === 'string' && EFFORTS.includes(agent.thinkingLevel as AgentThinkingLevel)) receipt.thinkingLevel = agent.thinkingLevel;
      }
    } catch { /* The requested policy remains explicit when an optional snapshot is unavailable. */ }
    await writeFile(join(prepared.projectDir, 'creation-receipt.json'), JSON.stringify({ ...receipt, registered: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    checkAbort(options.signal); progress('Registering the agent in this Pi console');
    await appendConnection(prepared);
    await writeFile(join(prepared.projectDir, 'creation-receipt.json'), JSON.stringify({ ...receipt, registered: true }, null, 2) + '\n', { mode: 0o600 });
    progress(`Agent ready: ${prepared.target}`); return receipt;
  } catch (cause) {
    const code = options.signal?.aborted ? 'cancelled' : cause instanceof AgentCreationError ? cause.code : (cause as NodeJS.ErrnoException).code === 'EEXIST' ? 'destination_exists' : 'creation_failed';
    const message = cause instanceof AgentCreationError ? cause.message : 'The independent agent could not be created.';
    throw new AgentCreationError(code, `${message}${created ? ` Project retained at ${prepared.projectDir}; inspect its logs before retrying.${pid ? ` Service PID ${pid} may still be running; no existing service was stopped.` : ''}` : ''}`, created ? prepared.projectDir : undefined, pid);
  }
}
