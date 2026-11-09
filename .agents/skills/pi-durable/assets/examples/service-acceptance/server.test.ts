// Generated project: npm test. These probes use the real durable runtime offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../src/server.js';
import { Catalog } from '../src/catalog.js';
import { loadConfig,type ServiceConfig } from '../src/config.js';
import type { AgentEvent } from '../src/github.js';

await mkdir('artifacts',{recursive:true});
async function config(extra:Partial<ServiceConfig>={}):Promise<ServiceConfig>{return {version:1,host:'127.0.0.1',port:0,dataDir:await mkdtemp(resolve('artifacts/service-')),provider:{kind:'faux'},github:{mode:'off',intervalMs:1000,initialScan:'baseline'},agents:[{id:'reviewer',name:'Reviewer',instructions:'Review privately.',repositories:['owner/repo']}],...extra};}
const event=(number=1):AgentEvent=>({id:`github:owner/repo:pull_request:${number}:opened`,type:'pull_request.opened',repository:'owner/repo',number,title:`PR ${number}`,url:`https://github.com/owner/repo/pull/${number}`,headSha:'abcdef123',createdAt:'2026-10-19T12:00:00Z'});
async function until(check:()=>Promise<unknown>|unknown){const deadline=Date.now()+10000;while(!await check()){if(Date.now()>deadline)throw new Error('Timed out waiting for the asserted service state.');await delay(10);}}
async function client(service:AgentService){const token=(await readFile(join(service.config.dataDir,'console-token'),'utf8')).trim();return async(path:string,body?:unknown)=>{const response=await fetch(service.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json() as any};};}

test('idle registry, event deduplication, task result, reconnectable job chat, human request deduplication',{timeout:20000},async()=>{
  const service=await AgentService.open(await config());const call=await client(service);
  try{
    await delay(60);assert.equal(service.stats().reviewer.providerCalls,0);
    assert.equal((await call('/v1/agents')).value.agents[0].id,'reviewer');
    assert.equal((await call('/v1/events',event())).value.jobs.length,1);
    assert.equal((await call('/v1/events',event())).value.jobs.length,0);
    await until(()=>service.catalog.jobs('reviewer')[0]?.status==='done');
    const job=service.catalog.jobs('reviewer')[0];assert.match(job.result??'',/OFFLINE DEMO/);assert.ok(job.conversationId);
    const path=`/v1/agents/reviewer/chat?jobId=${encodeURIComponent(job.id)}`;const first=(await call(path)).value;
    const message=`/v1/agents/reviewer/messages?jobId=${encodeURIComponent(job.id)}`;
    const receipt=(await call(message,{content:'Explain the result',requestId:'human-1',whenBusy:'followUp'})).value;
    const duplicate=(await call(message,{content:'Explain the result',requestId:'human-1'})).value;assert.equal(receipt.submissionId,duplicate.submissionId);
    await until(async()=>((await call(`/v1/agents/reviewer/submissions/${receipt.submissionId}`)).value.status==='done'));
    const reconnected=(await call(path)).value;assert.equal(reconnected.conversation.id,first.conversation.id);assert.match(JSON.stringify(reconnected),/Explain the result/);
    assert.notEqual((await call('/v1/agents/reviewer/chat')).value.conversation.id,first.conversation.id);
  }finally{await service.close();}
});

test('durable registry/thread map and queued jobs recover after graceful close',{timeout:20000},async()=>{
  const cfg=await config();let service=await AgentService.open(cfg);service.admit(event());
  await until(()=>service.catalog.jobs('reviewer')[0]?.status==='done');const job=service.catalog.jobs('reviewer')[0];await service.close();
  service=await AgentService.open(cfg);try{const call=await client(service);const thread=(await call(`/v1/agents/reviewer/chat?jobId=${encodeURIComponent(job.id)}`)).value;assert.equal(thread.conversation.id,job.conversationId);assert.equal(service.admit(event()).length,0);assert.equal(service.catalog.jobs('reviewer').length,1);await delay(30);assert.equal(service.stats().reviewer.providerCalls,0);}finally{await service.close();}
});

test('independent agents, repository routing and second-owner exclusion',{timeout:15000},async()=>{
  const cfg=await config();cfg.agents.push({...cfg.agents[0],id:'triager',name:'Triager'});const service=await AgentService.open(cfg);
  try{await assert.rejects(AgentService.open({...cfg,port:0}),/another owner/);assert.equal(service.admit(event()).length,2);assert.equal(service.admit({...event(2),repository:'other/repo'}).length,0);await until(()=>cfg.agents.every(a=>service.catalog.jobs(a.id)[0]?.status==='done'));assert.equal(service.stats().reviewer.providerCalls,1);assert.equal(service.stats().triager.providerCalls,1);}finally{await service.close();}
  const again=await AgentService.open(cfg);await again.close();
});

test('queue admission and polling checkpoint roll back together; old jobs remain addressable',{timeout:15000},async()=>{
  const cfg=await config();const catalog=await Catalog.open(cfg.dataDir,cfg.agents);try{
    const circular:any=event(2);circular.self=circular;
    assert.throws(()=>catalog.admit([event(),circular],cfg.agents,{repository:'owner/repo',state:{initialized:true,seen:[1]}}));assert.equal(catalog.jobs('reviewer').length,0);assert.equal(catalog.state('owner/repo').initialized,false);
    catalog.admit(Array.from({length:105},(_,i)=>event(i+1)),cfg.agents);assert.equal(catalog.jobs('reviewer').length,100);assert.ok(catalog.job('reviewer',`${event().id}:reviewer`));
  }finally{catalog.close();}
});

test('bearer auth, invalid messages, invalid configuration, and body validation',{timeout:15000},async()=>{
  const cfg=await config();const configPath=join(cfg.dataDir,'config.json');await writeFile(configPath,JSON.stringify({...cfg,host:'0.0.0.0'}));await assert.rejects(loadConfig(configPath),/loopback/);
  const service=await AgentService.open(cfg);try{assert.equal((await fetch(service.url+'/v1/agents')).status,401);const call=await client(service);assert.equal((await call('/v1/agents/reviewer/messages',{content:'hi'})).status,400);assert.equal((await call('/v1/events',{type:'push'})).status,400);assert.equal((await call('/v1/agents/missing/jobs')).status,404);}finally{await service.close();}
});

test('signed webhook admits one job and invalid signatures admit none',{timeout:15000},async()=>{
  const previous=process.env.GITHUB_WEBHOOK_SECRET;process.env.GITHUB_WEBHOOK_SECRET='test-webhook-secret';const cfg=await config({github:{mode:'webhook',intervalMs:1000,initialScan:'baseline'}});const service=await AgentService.open(cfg);
  try{const payload=Buffer.from(JSON.stringify({action:'opened',number:7,repository:{full_name:'owner/repo'},pull_request:{number:7,title:'new PR',html_url:'https://github.com/owner/repo/pull/7',head:{sha:'a'.repeat(40)},created_at:'2026-10-19T12:00:00Z'}}));const signature='sha256='+createHmac('sha256','test-webhook-secret').update(payload).digest('hex');
    const send=(sig:string)=>fetch(service.url+'/webhooks/github',{method:'POST',headers:{'X-GitHub-Event':'pull_request','X-GitHub-Delivery':'delivery-1','X-Hub-Signature-256':sig},body:payload});
    assert.equal((await send('sha256=bad')).status,401);assert.equal(service.catalog.jobs('reviewer').length,0);assert.equal((await send(signature)).status,202);assert.equal((await send(signature)).status,202);await until(()=>service.catalog.jobs('reviewer')[0]?.status==='done');assert.equal(service.catalog.jobs('reviewer').length,1);
  }finally{await service.close();if(previous===undefined)delete process.env.GITHUB_WEBHOOK_SECRET;else process.env.GITHUB_WEBHOOK_SECRET=previous;}
});

test('abrupt process death resumes the same job conversation/submission',{timeout:30000},async()=>{
  const cfg=await config({provider:{kind:'faux',delayMs:2000}});const file=join(cfg.dataDir,'config.json');await writeFile(file,JSON.stringify(cfg));
  const child=spawn(process.execPath,['dist/src/cli.js','serve','--config',file],{cwd:process.cwd(),stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='';let stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
  let originalId:number|undefined;
  try{await until(()=>{if(child.exitCode!==null)throw new Error(stderr);return stdout.includes('listening');});const address=JSON.parse(stdout.trim().split('\n')[0]);const token=(await readFile(join(cfg.dataDir,'console-token'),'utf8')).trim();await fetch(address.url+'/v1/events',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(event())});
    await until(async()=>{const r=await fetch(address.url+'/v1/agents/reviewer/jobs',{headers:{Authorization:`Bearer ${token}`}});const jobs=(await r.json() as any).jobs;originalId=jobs[0]?.conversationId;return originalId;});
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
  cfg.provider.delayMs=0;const service=await AgentService.open(cfg);try{await until(()=>service.catalog.jobs('reviewer')[0]?.status==='done');const job=service.catalog.jobs('reviewer')[0];assert.equal(job.conversationId,originalId);assert.equal(service.admit(event()).length,0);assert.equal(service.catalog.jobs('reviewer').length,1);assert.match(job.result??'',/OFFLINE DEMO/);}finally{await service.close();}
});
