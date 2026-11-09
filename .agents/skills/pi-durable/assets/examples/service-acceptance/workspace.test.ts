// Generated project: npm test. These tests use only temporary local workspaces and faux models.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,mkdtemp,readFile,realpath,symlink,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT as background } from '@earendil-works/chord/context';
import { loadConfig,type ServiceConfig } from '../src/config.js';
import { AgentRuntime } from '../src/runtime.js';
import { AgentService } from '../src/server.js';
import { createWorkspaceTools,validateWorkspaceRoot,WorkspaceReader,WORKSPACE_MAX_FILE_BYTES } from '../src/tools/workspace.js';

async function fixture(){
  await mkdir('artifacts',{recursive:true});const project=await mkdtemp(resolve('artifacts/workspace-'));
  const workspace=join(project,'workspace with spaces');await mkdir(workspace);await mkdir(join(workspace,'src'));
  await writeFile(join(workspace,'src/note.md'),'# Workspace evidence\nUnicode: café 日本語\n');
  const config:ServiceConfig={version:1,host:'127.0.0.1',port:0,dataDir:'state',provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'reader',name:'Reader',instructions:'Inspect requested source.',repositories:[],workspaceRoot:workspace}]};
  const path=join(project,'config.json');await writeFile(path,JSON.stringify(config));return {project,workspace,config,path};
}

test('workspace root validates absolute existing directories and canonicalizes directory aliases',async()=>{
  const {project,workspace,path,config}=await fixture();const loaded=await loadConfig(path);
  assert.equal(loaded.agents[0].workspaceRoot,await realpath(workspace));
  const alias=join(project,'alias');await symlink(workspace,alias,process.platform==='win32'?'junction':'dir');
  assert.equal(await validateWorkspaceRoot(alias),await realpath(workspace));
  for(const invalid of ['.',join(project,'missing'),join(workspace,'src/note.md'),42,'bad\npath'])await assert.rejects(validateWorkspaceRoot(invalid));
  config.agents[0].workspaceRoot='.';await writeFile(path,JSON.stringify(config));await assert.rejects(loadConfig(path),/absolute existing directory/);
  delete config.agents[0].workspaceRoot;await writeFile(path,JSON.stringify(config));assert.equal((await loadConfig(path)).agents[0].workspaceRoot,undefined);
});

test('workspace reads Unicode text and lists one directory with bounded output',async()=>{
  const {workspace}=await fixture(),reader=await WorkspaceReader.open(workspace);
  const text=await reader.read('src/note.md');assert.match(text.text,/café 日本語/);assert.equal(text.path,'src/note.md');assert.equal(text.bytes,Buffer.byteLength(text.text));
  for(let index=0;index<5;index++)await writeFile(join(workspace,`file-${index}.txt`),'test');
  const listing=await reader.list('.',2);assert.equal(listing.entries.length,2);assert.equal(listing.truncated,true);
  assert.deepEqual((await reader.list('src')).entries,[{name:'note.md',kind:'file'}]);
  for(const limit of [0,201,1.5])await assert.rejects(reader.list('.',limit),/listing limit/);
});

test('workspace paths reject traversal, absolute paths, alternate streams and platform separators',async()=>{
  const {workspace,project}=await fixture(),reader=await WorkspaceReader.open(workspace);
  await writeFile(join(project,'outside.txt'),'OUTSIDE');
  for(const path of ['../outside.txt','src/../../outside.txt','src//note.md','src/./note.md','src\\note.md','/etc/passwd','C:/Windows/system.ini','src/note.md:private','src/\u0000bad'])await assert.rejects(reader.read(path),/workspace-relative|permitted read scope/);
});

test('workspace hides credentials, dependencies, Git data and private durable state, including aliases',async()=>{
  const {workspace,project}=await fixture(),reader=await WorkspaceReader.open(workspace);
  for(const directory of ['.git','node_modules','.ssh','.pi/durable/reader','.pi/agent','.codex']){await mkdir(join(workspace,directory),{recursive:true});await writeFile(join(workspace,directory,'hidden.txt'),'PRIVATE');}
  for(const file of ['.env','.env.local','credentials.json','auth.json','console-token','private.pem','private.key'])await writeFile(join(workspace,file),'PRIVATE');
  for(const path of ['.git/hidden.txt','node_modules/hidden.txt','.ssh/hidden.txt','.pi/durable/reader/hidden.txt','.pi/agent/hidden.txt','.codex/hidden.txt','.env','.env.local','credentials.json','auth.json','console-token','private.pem','private.key'])await assert.rejects(reader.read(path),/permitted read scope/);
  const listing=await reader.list('.');assert.ok(listing.entries.every(entry=>!['.git','node_modules','.ssh','.codex','.env','.env.local','credentials.json','auth.json','console-token','private.pem','private.key'].includes(entry.name)));
  assert.equal((await reader.list('.pi')).entries.length,0);
  const alias=join(workspace,'apparently-public');await symlink(join(workspace,'.pi/durable'),alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(reader.read('apparently-public/reader/hidden.txt'),/permitted read scope/);
  const external=join(project,'outside');await mkdir(external);await writeFile(join(external,'outside.txt'),'OUTSIDE');
  await symlink(external,join(workspace,'escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(reader.read('escape/outside.txt'),/permitted read scope/);await assert.rejects(reader.list('escape'),/permitted read scope/);
  await assert.rejects(validateWorkspaceRoot(join(workspace,'.pi/durable')),/private state or credential/);
});

test('workspace rejects oversized, binary, malformed UTF-8 and directory reads',async()=>{
  const {workspace}=await fixture(),reader=await WorkspaceReader.open(workspace);
  await writeFile(join(workspace,'large.txt'),Buffer.alloc(WORKSPACE_MAX_FILE_BYTES+1,65));
  await writeFile(join(workspace,'binary.dat'),Buffer.from([65,0,66]));await writeFile(join(workspace,'invalid.txt'),Buffer.from([0xc3,0x28]));
  await assert.rejects(reader.read('large.txt'),/read limit/);await assert.rejects(reader.read('binary.dat'),/UTF-8 text/);await assert.rejects(reader.read('invalid.txt'),/UTF-8 text/);await assert.rejects(reader.read('src'),/regular file/);await assert.rejects(reader.list('src/note.md'),/requires a directory/);
  await writeFile(join(workspace,'boundary.txt'),'x'.repeat(WORKSPACE_MAX_FILE_BYTES));assert.equal((await reader.read('boundary.txt')).bytes,WORKSPACE_MAX_FILE_BYTES);
});

test('workspace tools expose only bounded list/read and apply the same path checks to direct calls',async()=>{
  const {workspace}=await fixture(),tools=await createWorkspaceTools(workspace);
  assert.deepEqual(tools.map(tool=>tool.name),['workspace_list','workspace_read']);
  const read=await tools[1].execute({path:'src/note.md'},{} as any,background);assert.match(JSON.stringify(read),/Workspace evidence/);
  await assert.rejects(tools[1].execute({path:'../outside.txt'},{} as any,background),/permitted read scope/);
});

test('agent runtime attaches the chosen workspace and tools, and legacy agents retain their previous instructions',async()=>{
  const {config,path}=await fixture(),loaded=await loadConfig(path),runtime=await AgentRuntime.open(loaded,loaded.agents[0]);
  try{
    assert.equal(runtime.version.policy.workspaceRoot,loaded.agents[0].workspaceRoot);const agent=await runtime.root.agent(background);assert.match(agent.instructions??'',/Workspace root:/);assert.match(agent.instructions??'',/read-only/);assert.ok(agent.tools.some(tool=>tool.name==='workspace_read'));assert.ok(agent.tools.some(tool=>tool.name==='workspace_list'));assert.equal(runtime.calls,0);
  }finally{await runtime.close();}
  const old={...config,agents:[{...config.agents[0],workspaceRoot:undefined}]};await writeFile(path,JSON.stringify(old));const oldLoaded=await loadConfig(path),legacy=await AgentRuntime.open(oldLoaded,oldLoaded.agents[0]);
  try{const agent=await legacy.root.agent(background);assert.equal(agent.instructions,'Inspect requested source.');assert.ok(agent.tools.every(tool=>!tool.name.startsWith('workspace_')));assert.equal(legacy.calls,0);}finally{await legacy.close();}
});

test('authenticated registry exposes the chosen workspace for console inventory',async()=>{
  const {path}=await fixture(),loaded=await loadConfig(path),service=await AgentService.open(loaded);
  try{
    const token=(await readFile(join(loaded.dataDir,'console-token'),'utf8')).trim();
    const response=await fetch(service.url+'/v1/agents',{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);
    const body=await response.json() as {agents:Array<{id:string;workspaceRoot?:string}>};
    assert.equal(body.agents[0].workspaceRoot,loaded.agents[0].workspaceRoot);
    assert.equal(service.stats().reader.providerCalls,0);
  }finally{await service.close();}
});

test('POSIX named pipes are rejected without a blocking open',{skip:process.platform==='win32'},async t=>{
  const {workspace}=await fixture();
  const fifo=spawnSync('mkfifo',[join(workspace,'named-pipe')],{timeout:3000,encoding:'utf8'});
  assert.equal(fifo.status,0,fifo.stderr);
  const module=pathToFileURL(resolve('src/tools/workspace.ts')).href;
  // Separate module-loader latency from the bounded filesystem operation.
  const script=`import assert from 'node:assert/strict';import {WorkspaceReader} from ${JSON.stringify(module)};const reader=await WorkspaceReader.open(${JSON.stringify(workspace)});const started=performance.now();await assert.rejects(reader.read('named-pipe'),/regular file/);const elapsedMs=performance.now()-started;assert.ok(elapsedMs<1000,'FIFO rejection exceeded its one-second read bound: '+elapsedMs);console.log(JSON.stringify({fifoRejected:true,readElapsedMs:elapsedMs}));`;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:30000,encoding:'utf8'});
  assert.equal(result.status,0,result.error?.message??result.stderr);
  t.diagnostic(result.stdout.trim());
});
