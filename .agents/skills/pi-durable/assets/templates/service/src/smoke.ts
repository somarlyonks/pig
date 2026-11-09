// npm run build; node dist/src/smoke.js. No GitHub/model calls or OS registration.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { AgentService } from './server.js';

await mkdir('.cache',{recursive:true});const directory=await mkdtemp(resolve('.cache/smoke-'));
const source=await loadConfig(resolve('config.json'));const agent=structuredClone(source.agents[0]);
agent.repositories=[agent.repositories[0]??'smoke/example'];
const config={...source,agents:[agent],port:0,dataDir:directory,provider:{kind:'faux' as const},github:{...source.github,mode:'off' as const}};
let service:AgentService|undefined;
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+10000;while(!await check()){assert.ok(Date.now()<end,'Smoke deadline expired.');await delay(20);}}
try{
  service=await AgentService.open(config);
  const token=(await readFile(join(directory,'console-token'),'utf8')).trim();
  const call=async(path:string,body?:unknown)=>{const r=await fetch(service!.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,`HTTP ${r.status}`);return await r.json() as any;};
  await delay(60);assert.equal(service.stats()[agent.id].providerCalls,0);
  const event={type:'pull_request.opened',repository:agent.repositories[0],number:1,title:'Offline smoke PR',url:`https://github.com/${agent.repositories[0]}/pull/1`,headSha:'a'.repeat(40),createdAt:'2026-10-19T12:00:00Z'};
  assert.equal((await call('/v1/events',event)).jobs.length,1);assert.equal((await call('/v1/events',event)).jobs.length,0);
  await until(()=>service!.catalog.jobs(agent.id)[0]?.status==='done');
  const job=service.catalog.jobs(agent.id)[0];const suffix=`?jobId=${encodeURIComponent(job.id)}`;
  const chat=(await call(`/v1/agents/${agent.id}/chat${suffix}`)).conversation.id;
  const message={content:'Explain this offline result.',requestId:'smoke-human-1',whenBusy:'followUp'};
  const receipt=await call(`/v1/agents/${agent.id}/messages${suffix}`,message);const duplicate=await call(`/v1/agents/${agent.id}/messages${suffix}`,message);assert.equal(receipt.submissionId,duplicate.submissionId);
  await until(async()=>((await call(`/v1/agents/${agent.id}/submissions/${receipt.submissionId}`)).status==='done'));
  await service.close();service=await AgentService.open(config);
  assert.equal((await call(`/v1/agents/${agent.id}/chat${suffix}`)).conversation.id,chat);assert.equal(service.catalog.jobs(agent.id).length,1);assert.equal(service.stats()[agent.id].providerCalls,0);
  const result={passed:true,platform:process.platform,provider:'faux',eventJobs:1,duplicateJobs:0,sameTaskConversation:true,humanSubmissionDeduplicated:true,reopenProviderCalls:0,nativeServiceRegistered:false,stateDirectory:directory};
  await writeFile('.cache/smoke-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await service?.close();}
