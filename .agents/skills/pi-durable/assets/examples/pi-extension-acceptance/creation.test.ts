// Run with npm test. All fixtures and owned child processes stay project-local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentCreationError, createAgent, prepareAgentCreation, type AgentCreationContext } from '../src/agent-creation.js';

const artifacts = resolve(process.cwd(), '../artifacts/extension-creation-tests');
async function json(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function text(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function fixture() {
  await mkdir(artifacts, { recursive: true }); const root = await mkdtemp(join(artifacts, 'case-'));
  const baseDir = join(root, 'workspace with spaces'); await mkdir(baseDir);
  const template = join(root, 'extension', 'service-template'); await mkdir(template, { recursive: true });
  await json(join(template, 'package.json'), { name: 'acceptance-service', type: 'module' });
  await json(join(template, 'package-lock.json'), { name: 'acceptance-service', lockfileVersion: 3 });
  await json(join(template, 'tsconfig.json'), {});
  for (const name of ['config', 'server', 'tools/workspace']) await text(join(template, 'src', name + '.ts'), '// Acceptance fixture; the fake compiler produces its bounded API.\n');
  const configSource = `import{readFile}from'node:fs/promises';import{dirname,resolve}from'node:path';export async function loadConfig(path){const value=JSON.parse(await readFile(path,'utf8'));value.dataDir=resolve(dirname(path),value.dataDir);return value;}`;
  const serverSource = `import{createServer}from'node:http';import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';export class AgentService{constructor(config){this.config=config;this.closed=new Promise(ok=>{this.resolveClosed=ok});this.server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+ 'a'.repeat(64)){res.writeHead(401);res.end('{}');return;}const path=new URL(req.url,this.url).pathname;res.setHeader('Content-Type','application/json');if(path==='/fixture-close'){setInterval(()=>{},1000);res.end('{}',()=>{void this.close();});}else if(path==='/v1/status')res.end(JSON.stringify({owner:this.owner,pid:process.pid,paused:false,quiescent:true,state:'running'}));else if(path==='/v1/agents')res.end(JSON.stringify({agents:config.agents.map(a=>({id:a.id,name:a.name,active:true})),mode:'faux'}));else if(path==='/v1/agents/'+config.agents[0].id+'/chat')res.end(JSON.stringify({conversation:{id:1},entries:[],docs:{'pi.agent':{model:{provider:'faux',modelId:'fixture'},thinkingLevel:'off'}}}));else{res.writeHead(404);res.end('{}');}});}setManagementOwner(owner){this.owner=owner;}static async open(config){await mkdir(config.dataDir,{recursive:true});await writeFile(join(config.dataDir,'console-token'),'a'.repeat(64));const service=new AgentService(config);await new Promise((ok,fail)=>{service.server.once('error',fail);service.server.listen(config.port,config.host,ok);});return service;}get url(){return'http://127.0.0.1:'+this.server.address().port;}async close(){this.server.closeAllConnections();await new Promise(ok=>this.server.close(ok));this.resolveClosed();}}`;
  await json(join(template, 'fixture-build.json'), { 'dist/src/config.js': configSource, 'dist/src/server.js': serverSource });
  const npmCliPath = join(root, 'runtime', 'npm-cli.js');
  const compiler = `const fs=require('node:fs');const path=require('node:path');const files=JSON.parse(fs.readFileSync('fixture-build.json','utf8'));for(const[name,bytes]of Object.entries(files)){fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,bytes);}`;
  await json(join(root, 'runtime', 'package.json'), { type: 'module' });
  await text(npmCliPath, `import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('node_modules/typescript/bin',{recursive:true});writeFileSync('node_modules/typescript/package.json',JSON.stringify({type:'commonjs'}));writeFileSync('node_modules/typescript/bin/tsc',${JSON.stringify(compiler)});`);
  const context: AgentCreationContext = { cwd: baseDir, extensionDir: join(root, 'extension'), npmCliPath, provider: 'faux' };
  const input = { id: 'my-helper', name: 'My helper', baseDir, instructions: 'Inspect the selected workspace and explain observable findings.' };
  return { root, template, baseDir, context, input, async close() { assert.ok(resolve(root).startsWith(artifacts + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function stop(pid: number) {
  try { process.kill(pid); } catch { return; }
  for (let attempt = 0; attempt < 50; attempt++) { try { process.kill(pid, 0); } catch { return; } await delay(50); }
  throw new Error('The owned acceptance service did not stop.');
}

test('creation preparation is read-only and shows the canonical folder, destination, registry and policy', async () => {
  const f = await fixture();
  try {
    const plan = await prepareAgentCreation(f.input, f.context);
    assert.equal(plan.baseDir, f.baseDir); assert.equal(plan.projectDir, join(f.baseDir, '.pi', 'durable', 'my-helper'));
    assert.equal(plan.connectionsFile, join(f.baseDir, '.pi', 'durable-agents.json'));
    assert.equal(plan.target, 'my-helper/my-helper'); assert.equal(plan.requestedModel, 'latest'); assert.equal(plan.task, 'coding'); assert.equal(plan.thinkingLevel, undefined);
    assert.deepEqual(await readdir(f.baseDir), []); assert.ok(Object.isFrozen(plan));
    assert.throws(() => { (plan as { requestedModel: string }).requestedModel = 'other'; }, TypeError);
  } finally { await f.close(); }
});

test('preparation rejects malformed IDs, Windows device names, bad policies and invalid repositories', async () => {
  const f = await fixture();
  try {
    for (const id of ['../other', 'Capital', 'con', 'prn', 'aux', 'nul', 'com1', 'lpt9', 'a'.repeat(49)]) await assert.rejects(prepareAgentCreation({ ...f.input, id }, f.context), { code: 'id_invalid' });
    for (const extra of [{ model: 'latest:unknown' }, { model: 'model --shell' }, { task: 'unsupported' }, { thinkingLevel: 'ultra' }]) await assert.rejects(prepareAgentCreation({ ...f.input, ...extra } as typeof f.input, f.context), { code: 'model_invalid' });
    await assert.rejects(prepareAgentCreation({ ...f.input, repository: 'https://example.com/repo' }, f.context), { code: 'repository_invalid' });
    await assert.rejects(prepareAgentCreation({ ...f.input, instructions: ' ' }, f.context), { code: 'instructions_invalid' });
    await assert.rejects(prepareAgentCreation({ ...f.input, name: 'Name\nInjected' }, f.context), { code: 'name_invalid' });
    assert.deepEqual(await readdir(f.baseDir), []);
  } finally { await f.close(); }
});

test('preparation requires an existing absolute folder and never overwrites an existing project', async () => {
  const f = await fixture();
  try {
    for (const baseDir of ['relative/folder', join(f.root, 'missing'), join(f.template, 'package.json')]) await assert.rejects(prepareAgentCreation({ ...f.input, baseDir }, f.context), { code: 'folder_invalid' });
    const destination = join(f.baseDir, '.pi', 'durable', f.input.id); await mkdir(destination, { recursive: true }); await text(join(destination, 'keep.txt'), 'preserve');
    await assert.rejects(prepareAgentCreation(f.input, f.context), { code: 'destination_exists' }); assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'preserve');
  } finally { await f.close(); }
});

test('preparation rejects redirected destination ancestors', async t => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'elsewhere'); await mkdir(outside);
    try { await symlink(outside, join(f.baseDir, '.pi'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EPERM') { t.skip('The host does not allow a directory symlink acceptance fixture.'); return; } throw cause; }
    await assert.rejects(prepareAgentCreation(f.input, f.context), { code: 'folder_redirected' }); assert.deepEqual(await readdir(outside), []);
  } finally { await f.close(); }
});

test('preparation rejects duplicate, full, credential-bearing and malformed registries', async () => {
  const f = await fixture();
  try {
    const connectionsFile = join(f.root, 'registry.json');
    await json(connectionsFile, { version: 1, services: [{ id: f.input.id, configPath: './existing.json' }] });
    await assert.rejects(prepareAgentCreation(f.input, { ...f.context, connectionsFile }), { code: 'duplicate_service' });
    await json(connectionsFile, { version: 1, services: Array.from({ length: 32 }, (_, i) => ({ id: `existing-${i}`, configPath: './existing.json' })) });
    await assert.rejects(prepareAgentCreation(f.input, { ...f.context, connectionsFile }), { code: 'registry_full' });
    for (const value of [{ version: 2, services: [] }, { version: 1, services: [{ id: 'existing', configPath: './existing.json', token: 'PRIVATE_FIXTURE_TOKEN' }] }, { version: 1, services: [{ id: 'existing', configPath: './existing.json' }, { id: 'existing', configPath: './other.json' }] }]) {
      await json(connectionsFile, value); await assert.rejects(prepareAgentCreation(f.input, { ...f.context, connectionsFile }), (cause: unknown) => cause instanceof AgentCreationError && cause.code === 'registry_invalid' && !cause.message.includes('PRIVATE_FIXTURE_TOKEN'));
    }
  } finally { await f.close(); }
});

test('preparation validates independent resources and installed JavaScript runtime entries', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareAgentCreation(f.input, { ...f.context, serviceTemplateDir: join(f.root, 'missing') }), { code: 'template_missing' });
    await rm(join(f.template, 'src/tools/workspace.ts'));
    await assert.rejects(prepareAgentCreation(f.input, f.context), { code: 'template_missing' });
    await text(join(f.template, 'src/tools/workspace.ts'), '// Restored fixture');
    const pi = join(f.root, 'installed-pi', 'dist', 'cli.js'); await text(pi, '// Pi fixture');
    await json(join(f.root, 'installed-pi', 'package.json'), { name: '@earendil-works/pi-coding-agent' });
    const plan = await prepareAgentCreation({ ...f.input, model: 'latest:sol', thinkingLevel: 'high', repository: 'Owner/Repo' }, { ...f.context, provider: 'openai-codex', piCliPath: pi });
    assert.equal(plan.provider, 'openai-codex'); assert.equal(plan.requestedModel, 'latest:sol'); assert.equal(plan.thinkingLevel, 'high'); assert.equal(plan.repository, 'owner/repo');
  } finally { await f.close(); }
});

test('cancelled or forged plans create nothing and a committed plan cannot be reused', async () => {
  const f = await fixture();
  try {
    const plan = await prepareAgentCreation(f.input, f.context);
    await assert.rejects(createAgent({ ...plan }), { code: 'plan_invalid' });
    await assert.rejects(createAgent(plan, { signal: AbortSignal.abort() }), { code: 'cancelled' });
    assert.deepEqual(await readdir(f.baseDir), []);
    const failedNpm = join(f.root, 'failure', 'npm-cli.js'); await text(failedNpm, 'process.exit(7);');
    const failingPlan = await prepareAgentCreation(f.input, { ...f.context, npmCliPath: failedNpm });
    await assert.rejects(createAgent(failingPlan), (cause: unknown) => cause instanceof AgentCreationError && cause.code === 'command_failed' && cause.projectDir === failingPlan.projectDir && cause.pid === undefined && cause.message.includes('Project retained'));
    await assert.rejects(createAgent(failingPlan), { code: 'plan_invalid' });
    assert.equal(JSON.parse(await readFile(failingPlan.configPath, 'utf8')).agents[0].workspaceRoot, f.baseDir);
    await assert.rejects(readFile(failingPlan.connectionsFile), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('cancelling an active setup process retains diagnostics without registering or starting a service', async () => {
  const f = await fixture();
  try {
    const slowNpm = join(f.root, 'slow-runtime', 'npm-cli.js'); await text(slowNpm, 'setTimeout(()=>{},60000);');
    const plan = await prepareAgentCreation(f.input, { ...f.context, npmCliPath: slowNpm });
    const controller = new AbortController();
    await assert.rejects(createAgent(plan, { signal: controller.signal, onProgress: message => { if (message.startsWith('Installing')) setTimeout(() => controller.abort(), 100); } }), (cause: unknown) => cause instanceof AgentCreationError && cause.code === 'cancelled' && cause.projectDir === plan.projectDir && cause.pid === undefined);
    assert.ok(JSON.parse(await readFile(join(plan.projectDir, 'scaffold-manifest.json'), 'utf8')).runtimeIndependent);
    await assert.rejects(readFile(plan.connectionsFile), { code: 'ENOENT' });
    await assert.rejects(readFile(join(plan.projectDir, 'state/creation-owner.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('a destination created after review is preserved and never reused', async () => {
  const f = await fixture();
  try {
    const plan = await prepareAgentCreation(f.input, f.context);
    await text(join(plan.projectDir, 'keep.txt'), 'Created by another operation after review.');
    await assert.rejects(createAgent(plan), (cause: unknown) => cause instanceof AgentCreationError && cause.code === 'destination_exists' && cause.projectDir === undefined);
    assert.deepEqual(await readdir(plan.projectDir), ['keep.txt']);
    assert.equal(await readFile(join(plan.projectDir, 'keep.txt'), 'utf8'), 'Created by another operation after review.');
  } finally { await f.close(); }
});

test('creation starts an independent no-inference service, preserves registry entries and survives a stale owner receipt', async () => {
  const f = await fixture(); let pid: number | undefined;
  try {
    const connectionsFile = join(f.root, 'custom registry', 'connections.json');
    await json(connectionsFile, { version: 1, services: [{ id: 'existing', name: 'Existing pilot', configPath: '../existing/config.json' }] });
    const plan = await prepareAgentCreation({ ...f.input, repository: 'Owner/Repo' }, { ...f.context, connectionsFile });
    // Prepared plans freeze resource bytes; later template changes cannot affect reviewed output.
    await text(join(f.template, 'src/tools/workspace.ts'), 'UNREVIEWED_MODIFICATION');
    const progress: string[] = [];
    const receipt = await createAgent(plan, { onProgress: message => { progress.push(message); if (message.startsWith('Building')) throw new Error('A detached UI should not change process ownership.'); } });
    pid = receipt.pid; assert.equal(receipt.status, 'running'); assert.equal(receipt.target, 'my-helper/my-helper'); assert.equal(receipt.resolvedModel, 'faux/fixture'); assert.equal(receipt.thinkingLevel, 'off');
    assert.ok(progress.some(message => message.startsWith('Agent ready')));
    const config = JSON.parse(await readFile(receipt.configPath, 'utf8'));
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.github.mode, 'poll'); assert.equal(config.github.initialScan, 'baseline'); assert.deepEqual(config.agents[0].repositories, ['owner/repo']); assert.equal(config.agents[0].workspaceRoot, f.baseDir); assert.deepEqual(config.agents[0].modelChoice, { task: 'coding' });
    assert.equal(await readFile(join(plan.projectDir, 'src/tools/workspace.ts'), 'utf8'), '// Acceptance fixture; the fake compiler produces its bounded API.\n');
    assert.equal(await readFile(join(plan.projectDir, `prompts/${f.input.id}.md`), 'utf8'), f.input.instructions + '\n');
    const registered = JSON.parse(await readFile(connectionsFile, 'utf8'));
    assert.deepEqual(registered.services[0], { id: 'existing', name: 'Existing pilot', configPath: '../existing/config.json' });
    assert.equal(registered.services[1].id, f.input.id); assert.equal(resolve(dirname(connectionsFile), registered.services[1].configPath), receipt.configPath);
    assert.equal(JSON.parse(await readFile(join(plan.projectDir, 'creation-receipt.json'), 'utf8')).registered, true);
    const manifest = JSON.parse(await readFile(join(plan.projectDir, 'scaffold-manifest.json'), 'utf8')); assert.equal(manifest.runtimeIndependent, true); assert.ok(manifest.files['agent-host.mjs']); assert.ok(manifest.files['managed-agent.json']); assert.ok(manifest.files['src/console/control-cli.ts']); assert.ok(manifest.files['src/console/agent-management.ts']); assert.ok(receipt.management?.controlCliPath); assert.ok(manifest.files['src/tools/workspace.ts']);
    await assert.rejects(createAgent(plan), { code: 'plan_invalid' });
    await stop(pid); pid = undefined;
    // A forced shutdown on Windows can retain this file. A new exclusive owner replaces it.
    await json(join(plan.projectDir, 'state/creation-owner.json'), { pid: 123456, nonce: 'stale-crash-fixture' });
    const child = spawn(process.execPath, [join(plan.projectDir, 'agent-host.mjs')], { cwd: plan.projectDir, windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); }); pid = child.pid; assert.ok(pid);
    let owner: { pid: number } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) { try { owner = JSON.parse(await readFile(join(plan.projectDir, 'state/creation-owner.json'), 'utf8')); if (owner?.pid === pid) break; } catch {} await delay(50); }
    assert.equal(owner?.pid, pid);
  } finally { if (pid) await stop(pid); await f.close(); }
});

test('registration failure retains the new running service and exact recovery receipt', async () => {
  const f = await fixture(); let pid: number | undefined;
  try {
    const plan = await prepareAgentCreation(f.input, f.context);
    await text(plan.connectionsFile + '.creation.lock', 'Another explicit registry writer');
    await assert.rejects(createAgent(plan), (cause: unknown) => { if (!(cause instanceof AgentCreationError)) return false; pid = cause.pid; return cause.code === 'registry_busy' && !!pid && cause.projectDir === plan.projectDir; });
    const receipt = JSON.parse(await readFile(join(plan.projectDir, 'creation-receipt.json'), 'utf8')); assert.equal(receipt.registered, false); assert.equal(receipt.pid, pid); assert.equal(receipt.configPath, plan.configPath);
    await assert.rejects(readFile(plan.connectionsFile), { code: 'ENOENT' });
  } finally { if (pid) await stop(pid); await f.close(); }
});

test('the standalone host exits after closed work even when a provider retains an idle transport handle',async()=>{
  const f=await fixture();let pid:number|undefined;
  try{
    const plan=await prepareAgentCreation(f.input,f.context),receipt=await createAgent(plan);pid=receipt.pid;
    const config=JSON.parse(await readFile(receipt.configPath,'utf8'));
    const response=await fetch(`http://127.0.0.1:${config.port}/fixture-close`,{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(64)}});
    assert.equal(response.status,200);await response.arrayBuffer();
    let exited=false;for(let attempt=0;attempt<100;attempt++){try{process.kill(pid,0);}catch{exited=true;break;}await delay(25);}
    assert.equal(exited,true,'An idle transport must not retain the standalone owner after service.closed.');
    await assert.rejects(readFile(join(plan.projectDir,'state/creation-owner.json')),{code:'ENOENT'});
    const last=JSON.parse(await readFile(join(plan.projectDir,'state/last-owner.json'),'utf8'));assert.equal(last.pid,pid);assert.equal(last.configPath,plan.configPath);pid=undefined;
  }finally{if(pid)await stop(pid);await f.close();}
});
