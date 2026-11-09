// Run npm test from the generated console. Uses only bounded local fixtures and owned Node children.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { dirname,join,normalize,resolve,sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  archiveManaged,connectionFromManagedConfig,inspectManaged,pauseManaged,readConfiguredAgents,
  readManagedLogs,recoverManaged,resolveManagedProject,restartManaged,restoreManaged,
  resumeManaged,startManaged,stopManaged,withManagedOperation,manageLoginStartup,type LoginStartupOptions,
} from '../src/agent-management.js';
import type { ServiceConnection } from '../src/client.js';

const token='a'.repeat(64);
async function json(path:string,value:unknown){await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value));}
async function port(){const server=createServer();return new Promise<number>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(error=>error?reject(error):accept(typeof address==='object'&&address?address.port:0));});});}
const host=`import{createServer}from'node:http';import{readFile,writeFile,mkdir,rm}from'node:fs/promises';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';import{randomUUID}from'node:crypto';
const project=dirname(fileURLToPath(import.meta.url)),configPath=join(project,'config.json'),config=JSON.parse(await readFile(configPath,'utf8')),state=join(project,'state'),nonce=randomUUID(),identity={pid:process.pid,nonce,configPath};await mkdir(state,{recursive:true});await writeFile(join(state,'console-token'),'a'.repeat(64));let paused=false;try{paused=JSON.parse(await readFile(join(state,'pause.json'),'utf8')).paused===true;}catch{}
const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='Bearer '+'a'.repeat(64)){res.writeHead(401);res.end('{}');return;}let busy=false;try{busy=JSON.parse(await readFile(join(state,'busy.json'),'utf8')).busy===true;}catch{};if(req.method==='GET'&&req.url==='/v1/status'){res.end(JSON.stringify({owner:identity,pid:process.pid,state:paused?'paused':'running',paused,quiescent:!busy,pending:busy?1:0}));return;}let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body||'{}');if(value.expectedOwner?.pid!==process.pid||value.expectedOwner?.nonce!==nonce){res.writeHead(409);res.end('{}');return;}if(req.url==='/fixture-orphan'){setInterval(()=>{},1000);res.end('{}',()=>{server.closeAllConnections();server.close(async()=>{await rm(join(state,'creation-owner.json'),{force:true});});});return;}if(req.url==='/v1/lifecycle/pause'||req.url==='/v1/lifecycle/resume'){paused=req.url.endsWith('pause');await writeFile(join(state,'pause.json'),JSON.stringify({paused}));res.end('{}');return;}if(req.url==='/v1/lifecycle/shutdown'){if(busy){paused=true;await writeFile(join(state,'pause.json'),JSON.stringify({paused}));res.writeHead(409);res.end(JSON.stringify({busy:true}));return;}res.end(JSON.stringify({accepted:true}),()=>{server.closeAllConnections();server.close(async()=>{const own=JSON.parse(await readFile(join(state,'creation-owner.json'),'utf8'));if(own.nonce===nonce)await rm(join(state,'creation-owner.json'),{force:true});});});return;}res.writeHead(404);res.end('{}');});await new Promise((ok,fail)=>{server.once('error',fail);server.listen(config.port,config.host,ok)});await writeFile(join(state,'creation-owner.json'),JSON.stringify({version:1,...identity,url:'http://127.0.0.1:'+config.port}));`;
async function fixture(){
  const artifacts=resolve('artifacts/management-tests');await mkdir(artifacts,{recursive:true});const project=await mkdtemp(join(artifacts,'case with spaces-'));
  const connection:ServiceConnection={id:'worker',name:'Worker',configPath:join(project,'config.json'),dataDir:join(project,'state'),baseUrl:`http://127.0.0.1:${await port()}`};
  const config={version:1,host:'127.0.0.1',port:Number(new URL(connection.baseUrl).port),dataDir:'state',serviceName:'durable-worker',agents:[{id:'worker',name:'Worker',instructions:'PRIVATE_PROMPT_MUST_NOT_LEAK',repositories:[],workspaceRoot:project,modelChoice:{task:'coding',model:'latest:sol'}}],provider:{kind:'faux',token:'PRIVATE_ACCOUNT_MUST_NOT_LEAK'}};
  await json(connection.configPath,config);await writeFile(join(project,'agent-host.mjs'),host);
  await json(join(project,'managed-agent.json'),{version:1,kind:'pi-durable-console-managed',agentId:'worker',serviceId:'worker',configFile:'config.json',dataDir:'state',hostFile:'agent-host.mjs',hostSha256:createHash('sha256').update(host).digest('hex')});
  const registry=join(project,'connections.json');await json(registry,{version:1,services:[{id:'worker',name:'Worker',configPath:'config.json'},{id:'other',configPath:'other.json'}]});
  async function close(){try{const owner=JSON.parse(await readFile(join(connection.dataDir,'creation-owner.json'),'utf8'));if(owner.configPath===connection.configPath&&Number.isInteger(owner.pid)&&owner.pid!==process.pid){try{await stopManaged(connection,{drainTimeoutMs:0});}catch{process.kill(owner.pid);}for(let index=0;index<50;index++){try{process.kill(owner.pid,0);}catch{break;}await delay(30);}}}catch{}assert.ok(resolve(project).startsWith(artifacts+sep));await rm(project,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
  return {project,connection,config,registry,close};
}

test('configured offline inventory exposes identity and scope without prompts or credentials',async()=>{const f=await fixture();try{const agents=await readConfiguredAgents(f.connection);assert.equal(agents[0].workspaceRoot,f.project);assert.equal(agents[0].modelChoice?.model,'latest:sol');assert.doesNotMatch(JSON.stringify(agents),/PRIVATE_/);assert.equal((await inspectManaged(f.connection)).state,'stopped');}finally{await f.close();}});
test('management requires an exact factory descriptor and pinned local host',async()=>{const f=await fixture();try{assert.equal((await resolveManagedProject(f.connection)).target,'worker/worker');await writeFile(join(f.project,'agent-host.mjs'),host+'\n// Changed');await assert.rejects(startManaged(f.connection),{code:'host_changed'});assert.equal((await inspectManaged(f.connection)).managed,false);await writeFile(join(f.project,'agent-host.mjs'),host);await rm(join(f.project,'managed-agent.json'));await assert.rejects(startManaged(f.connection),{code:'unmanaged'});}finally{await f.close();}});
test('cancelled and invalid start options create no process or management state',async()=>{const f=await fixture();try{const controller=new AbortController();controller.abort();await assert.rejects(startManaged(f.connection,{signal:controller.signal}),{code:'cancelled'});await assert.rejects(startManaged(f.connection,{timeoutMs:-1}),{code:'input_invalid'});await assert.rejects(readFile(join(f.connection.dataDir,'creation-owner.json')),{code:'ENOENT'});}finally{await f.close();}});
test('start is idempotent and pause survives an authenticated stop and restart',async()=>{const f=await fixture();try{const first=await startManaged(f.connection);assert.equal(first.state,'running');assert.ok(first.owner);const again=await startManaged(f.connection);assert.deepEqual(again.owner,first.owner);assert.equal((await pauseManaged(f.connection)).state,'paused');assert.equal((await stopManaged(f.connection,{drainTimeoutMs:0})).state,'stopped');const second=await startManaged(f.connection);assert.equal(second.state,'paused');assert.notEqual(second.owner?.nonce,first.owner?.nonce);assert.equal((await resumeManaged(f.connection)).state,'running');assert.equal((await restartManaged(f.connection,{drainTimeoutMs:0})).state,'running');}finally{await f.close();}});
test('busy shutdown leaves the authenticated owner alive and paused without a PID kill',async()=>{const f=await fixture();try{const first=await startManaged(f.connection);await json(join(f.connection.dataDir,'busy.json'),{busy:true});await assert.rejects(stopManaged(f.connection,{drainTimeoutMs:0}),{code:'busy'});const after=await inspectManaged(f.connection);assert.equal(after.state,'paused');assert.deepEqual(after.owner,first.owner);assert.equal(after.status?.quiescent,false);await json(join(f.connection.dataDir,'busy.json'),{busy:false});assert.equal((await stopManaged(f.connection,{drainTimeoutMs:0})).state,'stopped');}finally{await f.close();}});
test('a locally cancelled shutdown cannot be mistaken for a completed start while its owner drains',async()=>{const f=await fixture();try{const first=await startManaged(f.connection);const fetcher=(async()=>new Response(JSON.stringify({owner:first.owner,paused:true,state:'draining',quiescent:false}),{headers:{'content-type':'application/json'}})) as typeof fetch;await assert.rejects(startManaged(f.connection,{fetch:fetcher}),{code:'busy'});assert.deepEqual((await inspectManaged(f.connection)).owner,first.owner);}finally{await f.close();}});
test('an owner nonce mismatch refuses mutations and never terminates another process',async()=>{const f=await fixture();let owner:unknown;try{const first=await startManaged(f.connection);owner=JSON.parse(await readFile(join(f.connection.dataDir,'creation-owner.json'),'utf8'));await json(join(f.connection.dataDir,'creation-owner.json'),{...owner as object,nonce:randomUUID()});assert.equal((await inspectManaged(f.connection)).state,'unreachable');await assert.rejects(stopManaged(f.connection),{code:'owner_unverified'});assert.doesNotThrow(()=>process.kill(first.owner!.pid,0));}finally{if(owner)await json(join(f.connection.dataDir,'creation-owner.json'),owner);await f.close();}});
test('explicit recovery replaces a stale process receipt without terminating its PID',async()=>{const f=await fixture();try{await json(join(f.connection.dataDir,'creation-owner.json'),{version:1,pid:process.pid,nonce:randomUUID(),configPath:f.connection.configPath});await json(join(f.connection.dataDir,'console-token'),'unused');await assert.rejects(startManaged(f.connection),{code:'owner_unverified'});const current=await recoverManaged(f.connection);assert.equal(current.state,'running');assert.notEqual(current.owner?.pid,process.pid);assert.doesNotThrow(()=>process.kill(process.pid,0));}finally{await f.close();}});
test('missing active receipt and closed API do not report stopped while the recorded owned transport process lives',async()=>{
  const f=await fixture();let pid:number|undefined;
  try{
    const started=await startManaged(f.connection);pid=started.owner!.pid;
    await json(join(f.project,'creation-receipt.json'),{target:'worker/worker',projectDir:f.project,configPath:f.connection.configPath,pid});
    const response=await fetch(f.connection.baseUrl+'/fixture-orphan',{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify({expectedOwner:started.owner})});assert.equal(response.status,200);await response.arrayBuffer();
    for(let attempt=0;attempt<50;attempt++){try{await readFile(join(f.connection.dataDir,'creation-owner.json'));}catch{break;}await delay(20);}
    const inspected=await inspectManaged(f.connection);assert.equal(inspected.state,'unreachable');assert.equal(inspected.lastKnownOwner?.pid,pid);
    await assert.rejects(archiveManaged(f.connection,{connectionsFile:f.registry}),{code:'not_stopped'});assert.doesNotThrow(()=>process.kill(pid!,0));
  }finally{if(pid){try{process.kill(pid);}catch{}for(let attempt=0;attempt<50;attempt++){try{process.kill(pid,0);}catch{break;}await delay(20);}}await f.close();}
});
test('shared operation lock excludes concurrent lifecycle and quality actions',async()=>{const f=await fixture();try{const project=await resolveManagedProject(f.connection);await withManagedOperation(project,async()=>{await assert.rejects(startManaged(f.connection),{code:'management_busy'});});assert.equal((await startManaged(f.connection)).state,'running');}finally{await f.close();}});
test('log tails are bounded and redact credential/control forms',async()=>{const f=await fixture();try{await mkdir(join(f.project,'logs'));await writeFile(join(f.project,'logs/host.stderr.log'),'x'.repeat(10000)+'\nBearer secret-value\n\u001b[31mPUBLIC\u001b[0m');const result=await readManagedLogs(f.connection,{maxBytes:1000});assert.equal(result.files[0].truncated,true);assert.match(result.files[0].text,/PUBLIC/);assert.doesNotMatch(result.files[0].text,/secret-value|\u001b/);assert.ok(result.files[0].text.length<1100);}finally{await f.close();}});
test('native UTF-16 and UTF-8 log BOMs decode before redaction and truncated UTF-16 tails remain aligned',async()=>{
  const f=await fixture();
  try{
    const directory=join(f.connection.dataDir,'logs');await mkdir(directory,{recursive:true});
    const text='Caf\u00e9 \u65e5\u672c\nBearer private-token\n\u001b[31mDONE\u001b[0m';
    const le=Buffer.from(text,'utf16le'),be=Buffer.from(le);be.swap16();
    await writeFile(join(directory,'service.stdout.log'),Buffer.concat([Buffer.from([0xff,0xfe]),le]));
    await writeFile(join(directory,'service.stderr.log'),Buffer.concat([Buffer.from([0xfe,0xff]),be]));
    await mkdir(join(f.project,'logs'));await writeFile(join(f.project,'logs/host.stdout.log'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)]));
    const full=await readManagedLogs(f.connection,{maxBytes:1000});
    assert.equal(full.files.length,3);
    for(const file of full.files){assert.match(file.text,/Caf\u00e9 \u65e5\u672c/);assert.match(file.text,/Bearer \[REDACTED\]/);assert.match(file.text,/DONE/);assert.doesNotMatch(file.text,/private-token|\u001b|\ufeff|\ufffd/);assert.equal(file.truncated,false);}
    const tailText='x'.repeat(200)+'\u65e5\u672cEND',tail=Buffer.from(tailText,'utf16le');
    await writeFile(join(directory,'service.stdout.log'),Buffer.concat([Buffer.from([0xff,0xfe]),tail,Buffer.from([0x7f])]));
    const short=await readManagedLogs(f.connection,{maxBytes:21}),entry=short.files.find(item=>item.name==='state/logs/service.stdout.log')!;
    assert.equal(entry.truncated,true);assert.match(entry.text,/\u65e5\u672cEND$/);assert.doesNotMatch(entry.text,/\ufffd|\u0000|\u007f/);
  }finally{await f.close();}
});
test('archive unregisters only the stopped exact connection and reconnect preserves all project files',async()=>{const f=await fixture();try{const current=await startManaged(f.connection);await assert.rejects(archiveManaged(f.connection,{connectionsFile:f.registry}),{code:'not_stopped'});await stopManaged(f.connection,{drainTimeoutMs:0});await archiveManaged(f.connection,{connectionsFile:f.registry});const registry=JSON.parse(await readFile(f.registry,'utf8'));assert.deepEqual(registry.services,[{id:'other',configPath:'other.json'}]);assert.equal((await readFile(join(f.project,'agent-host.mjs'),'utf8')),host);const restored=await restoreManaged(f.connection.configPath,{connectionsFile:f.registry});assert.equal(restored.started,false);assert.equal((await inspectManaged(f.connection)).state,'stopped');assert.equal((await connectionFromManagedConfig(f.connection.configPath)).id,'worker');await assert.rejects(restoreManaged(f.connection.configPath,{connectionsFile:f.registry}),{code:'duplicate_service'});assert.ok((await readdir(f.project)).includes('archive-receipt.json'));assert.ok(current.owner);}finally{await f.close();}});

test('owned login startup plans, installs, routes starts, drains and uninstalls without calling an OS scheduler',{skip:process.platform!=='win32'&&process.platform!=='darwin'},async()=>{
  const f=await fixture(),calls:Array<{action:string;execute:boolean}>=[];let installed=false,lastPid:number|undefined;
  const options:LoginStartupOptions={nativeRunner:async(project,action,selected,execute)=>{
    calls.push({action,execute});const fields=[selected.serviceName,selected.projectDir,selected.configPath,selected.dataDir,selected.entryPath] as string[];
    const identity=fields.map(value=>process.platform==='win32'?normalize(value).toLowerCase():normalize(value));
    const ownerId='pi-durable-service:'+createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if(execute&&(action==='install'||action==='start')){
      if(action==='install'){const intent=JSON.parse(await readFile(join(project.projectDir,'native-service.json'),'utf8'));assert.equal(intent.phase,'installing');installed=true;}
      const child=spawn(process.execPath,[project.hostPath],{cwd:project.projectDir,windowsHide:true,stdio:'ignore'});await new Promise<void>((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});lastPid=child.pid;child.unref();
    }
    if(execute&&action==='uninstall'){assert.equal((await inspectManaged(f.connection)).state,'stopped');installed=false;}
    return {action,executed:execute,plan:{ownerId,platform:process.platform,installPath:join(project.projectDir,'native-fixture-plan'),target:selected.serviceName,artifacts:[],commands:{}},output:[{stdout:JSON.stringify({installed}),stderr:'',exitCode:0}]};
  }};
  try{
    const plan=await manageLoginStartup(f.connection,'plan',options);assert.equal(plan.executed,false);assert.equal((await inspectManaged(f.connection)).state,'stopped');await assert.rejects(readFile(join(f.project,'native-service.json')),{code:'ENOENT'});
    const installation=await manageLoginStartup(f.connection,'install',options);assert.equal(installation.registered,true);assert.equal((await inspectManaged(f.connection)).owner?.pid,lastPid);
    const before=calls.length;await assert.rejects(manageLoginStartup(f.connection,'install',options),{code:'not_stopped'});assert.equal(calls.length,before);
    await stopManaged(f.connection,{drainTimeoutMs:0});const restarted=await startManaged(f.connection,options);assert.equal(restarted.owner?.pid,lastPid);assert.equal(calls.filter(call=>call.action==='start').length,1);
    await stopManaged(f.connection,{drainTimeoutMs:0});await assert.rejects(archiveManaged(f.connection,{connectionsFile:f.registry}),{code:'native_installed'});
    const markerPath=join(f.project,'native-service.json'),valid=JSON.parse(await readFile(markerPath,'utf8'));await json(markerPath,{...valid,ownerId:'unrelated-owner'});
    const count=calls.length;await assert.rejects(startManaged(f.connection,options),{code:'native_invalid'});assert.equal(calls.length,count);await json(markerPath,valid);
    await manageLoginStartup(f.connection,'uninstall',options);assert.equal(installed,false);await assert.rejects(readFile(markerPath),{code:'ENOENT'});assert.equal((await manageLoginStartup(f.connection,'status',options)).registered,false);
  }finally{await f.close();}
});
