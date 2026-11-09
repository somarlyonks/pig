// Generated project: npm test. Offline lifecycle checks use the real pinned Harness.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineTask } from '@earendil-works/pi-durable';
import { AgentService } from '../src/server.js';
import type { AgentRuntime } from '../src/runtime.js';
import type { ServiceConfig } from '../src/config.js';

async function fixture(delayMs=0){
  await mkdir('artifacts',{recursive:true});const dataDir=await mkdtemp(resolve('artifacts/lifecycle-'));
  const config:ServiceConfig={version:1,host:'127.0.0.1',port:0,dataDir,provider:{kind:'faux',delayMs},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'reviewer',name:'Reviewer',instructions:'Keep the configured private prompt out of status.',repositories:['owner/repo']}]};
  const service=await AgentService.open(config),token=(await readFile(join(dataDir,'console-token'),'utf8')).trim();
  const call=async(path:string,body?:unknown)=>{const response=await fetch(service.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json() as any};};
  return {config,service,call};
}
async function until(predicate:()=>Promise<unknown>|unknown,timeout=6000){const deadline=Date.now()+timeout;while(!await predicate()){if(Date.now()>deadline)throw new Error('Lifecycle assertion timed out.');await delay(10);}}
const message=(requestId:string)=>({content:'Complete this bounded offline task.',requestId,whenBusy:'followUp'});
const event=()=>({id:'ignored',type:'pull_request.opened',repository:'owner/repo',number:1,title:'One task',url:'https://github.com/owner/repo/pull/1',headSha:'a'.repeat(40),createdAt:'2026-10-25T00:00:00Z'});

test('status inspects idle runtime without generation and excludes prompt/input/tool payloads',async()=>{
  const {service,call}=await fixture();
  try{
    assert.equal((await fetch(service.url+'/v1/status')).status,401);
    await until(async()=>(await call('/v1/status')).value.quiescent);
    const status=(await call('/v1/status')).value;
    assert.equal(status.supported,true);assert.equal(status.pid,process.pid);assert.equal(status.state,'running');assert.equal(status.accepting,true);assert.equal(status.agents[0].tasks.live,0);assert.equal(status.agents[0].unsettledSubmissions,0);assert.equal(status.agents[0].providerCalls,0);
    assert.ok(!JSON.stringify(status).includes('configured private prompt'));assert.ok(!JSON.stringify(status).includes('instructions'));
  }finally{await service.close();}
});

test('busy control and queued submissions prevent shutdown; a timeout pauses admission without aborting work',async()=>{
  const {service,call}=await fixture(250);
  try{
    const first=(await call('/v1/agents/reviewer/messages',message('first'))).value;
    const second=(await call('/v1/agents/reviewer/messages',message('second'))).value;
    await until(async()=>(await call('/v1/status')).value.activeGenerations>0);
    const status=(await call('/v1/status')).value;assert.equal(status.quiescent,false);assert.equal(status.agents[0].eventJobs.running??0,0);assert.ok(status.agents[0].unsettledSubmissions>=1);
    const blocked=await call('/v1/lifecycle/shutdown',{timeoutMs:0});assert.equal(blocked.status,409);assert.equal(blocked.value.error,'busy');assert.equal(blocked.value.status.paused,true);
    assert.equal((await call('/v1/agents/reviewer/messages',message('not-admitted'))).status,503);
    assert.equal((await call('/v1/events',event())).status,503);
    await until(async()=>(await call(`/v1/agents/reviewer/submissions/${first.submissionId}`)).value.status==='done');
    await until(async()=>(await call(`/v1/agents/reviewer/submissions/${second.submissionId}`)).value.status==='done');
    assert.equal(service.stats().reviewer.providerCalls,2);
    assert.equal((await call('/v1/lifecycle/resume',{})).status,200);
    assert.equal((await call('/v1/status')).value.accepting,true);
  }finally{await service.close();}
});

test('explicit pause survives restart and resume restores event work without idle calls',async()=>{
  const {config,service,call}=await fixture();
  await call('/v1/lifecycle/pause',{});assert.equal((await call('/v1/status')).value.paused,true);await service.close();
  const reopened=await AgentService.open(config),token=(await readFile(join(config.dataDir,'console-token'),'utf8')).trim();
  const request=async(path:string,body?:unknown)=>{const response=await fetch(reopened.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json() as any};};
  try{
    assert.equal((await request('/v1/status')).value.paused,true);assert.equal(reopened.stats().reviewer.providerCalls,0);
    assert.equal((await request('/v1/events',event())).status,503);assert.equal(reopened.catalog.jobs('reviewer').length,0);
    assert.equal((await request('/v1/lifecycle/resume',{})).status,200);assert.equal((await request('/v1/events',event())).status,202);
    await until(()=>reopened.catalog.jobs('reviewer')[0]?.status==='done');assert.equal(reopened.stats().reviewer.providerCalls,1);
    assert.deepEqual(JSON.parse(await readFile(join(config.dataDir,'lifecycle-control.json'),'utf8')),{version:1,paused:false});
  }finally{await reopened.close();}
});

test('managed lifecycle requires the exact owner and closed joins the completed API shutdown',async()=>{
  const {config,service,call}=await fixture(),owner={pid:process.pid,nonce:randomUUID(),configPath:join(config.dataDir,'config.json')};service.setManagementOwner(owner);
  try{
    assert.equal((await call('/v1/status')).value.owner.nonce,owner.nonce);
    assert.equal((await call('/v1/lifecycle/pause',{})).status,409);
    assert.equal((await call('/v1/lifecycle/pause',{expectedOwner:{...owner,nonce:randomUUID()}})).status,409);
    assert.equal((await call('/v1/status')).value.paused,false);
    assert.equal((await call('/v1/lifecycle/pause',{expectedOwner:owner})).status,200);
    assert.equal((await call('/v1/lifecycle/resume',{expectedOwner:owner})).status,200);
    await until(async()=>(await call('/v1/status')).value.quiescent);
    const result=await call('/v1/lifecycle/shutdown',{expectedOwner:owner,timeoutMs:1000});assert.equal(result.status,202);assert.equal(result.value.drained,true);assert.equal(result.value.pauseOnRestart,false);
    await service.closed;await service.close();
    assert.deepEqual(JSON.parse(await readFile(join(config.dataDir,'lifecycle-control.json'),'utf8')),{version:1,paused:false});
  }finally{await service.close();}
});

test('background tasks count as live even when ordinary conversation idle waits exclude them',async()=>{
  const {service,call}=await fixture();
  const runtime=(service as unknown as {runtimes:Map<string,AgentRuntime>}).runtimes.get('reviewer')!;
  const held=defineTask({name:'fixture.blocked-background',version:1,initial:()=>({phase:'hold' as const}),phases:{hold:async()=>{}},abort:async()=>{}});
  try{
    const id=await runtime.harness.commit(tx=>tx.createTask(held,{}, {conversationId:runtime.root.id,ownership:{kind:'conversation'},background:true}),context);
    const status=(await call('/v1/status')).value;
    assert.equal(status.agents[0].tasks.live,1);assert.equal(status.agents[0].tasks.background,1);assert.equal(status.agents[0].tasks.items[0].schedulerState,'blocked');assert.equal(status.quiescent,false);assert.equal(status.agents[0].providerCalls,0);
    assert.equal((await call('/v1/lifecycle/shutdown',{})).status,409);
    assert.ok(id);assert.equal((await call('/v1/agents/reviewer/abort',{})).status,200);
    assert.equal((await call('/v1/status')).value.agents[0].tasks.background,1);
    assert.equal((await call('/v1/agents/reviewer/abort',{background:true})).status,200);
    await until(async()=>(await call('/v1/status')).value.quiescent);
    assert.equal((await call('/v1/lifecycle/shutdown',{})).status,202);await service.closed;
  }finally{await service.close();}
});

test('bounded drain waits for accepted work and rejects concurrent lifecycle changes',async()=>{
  const {service,call}=await fixture(300);
  try{
    const admitted=(await call('/v1/agents/reviewer/messages',message('drain-one'))).value;
    const shutdown=call('/v1/lifecycle/shutdown',{timeoutMs:3000});
    await until(async()=>(await call('/v1/status')).value.state==='draining');
    assert.equal((await call('/v1/lifecycle/resume',{})).status,409);
    const result=await shutdown;assert.equal(result.status,202);assert.equal(result.value.status.quiescent,true);
    await service.closed;assert.equal(service.stats().reviewer.providerCalls,1);assert.ok(admitted.submissionId);
  }finally{await service.close();}
});

test('a poll completing after pause admits no event and advances no checkpoint',async()=>{
  const previous=globalThis.fetch;let finish!:(response:Response)=>void;let started=false;
  globalThis.fetch=((url:any,options:any)=>String(url).startsWith('https://api.github.com/')?new Promise<Response>(resolve=>{started=true;finish=resolve;}):previous(url,options)) as typeof fetch;
  let service:AgentService|undefined;
  try{
    await mkdir('artifacts',{recursive:true});const dataDir=await mkdtemp(resolve('artifacts/poll-pause-'));
    service=await AgentService.open({version:1,host:'127.0.0.1',port:0,dataDir,provider:{kind:'faux'},github:{mode:'poll',intervalMs:1000,initialScan:'enqueue'},agents:[{id:'reader',name:'Reader',instructions:'Read privately.',repositories:['owner/repo']}]});
    await until(()=>started);await service.pauseAdmissions();
    finish(new Response(JSON.stringify([{number:1,title:'One PR',html_url:'https://github.com/owner/repo/pull/1',head:{sha:'a'.repeat(40)},created_at:'2026-10-25T00:00:00Z'}]),{headers:{'Content-Type':'application/json'}}));
    await until(async()=>!(await service!.status()).polling);
    assert.equal(service.catalog.jobs('reader').length,0);assert.equal(service.catalog.state('owner/repo').initialized,false);assert.equal(service.stats().reader.providerCalls,0);
  }finally{globalThis.fetch=previous;if(service)await service.close();}
});

test('invalid persisted controls fail closed and release owner state for a corrected restart',async()=>{
  const {config,service}=await fixture();await service.close();
  await writeFile(join(config.dataDir,'lifecycle-control.json'),JSON.stringify({version:1,paused:'yes'}));
  await assert.rejects(AgentService.open(config),/Invalid persisted/);
  await rm(join(config.dataDir,'lifecycle-control.json'));
  const reopened=await AgentService.open(config);await reopened.close();
});
