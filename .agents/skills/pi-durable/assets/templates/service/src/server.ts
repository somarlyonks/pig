// Build with npm run build. Loopback API for the service's own agent registry.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join,isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Catalog, type Job } from './catalog.js';
import { AgentRuntime } from './runtime.js';
import { loadServiceEnvironment, type ServiceConfig } from './config.js';
import { pollPullRequests, parseWebhook, GitHubEventError, type AgentEvent } from './github.js';
import { loadAdmissionPause,saveAdmissionPause } from './lifecycle.js';

export interface ManagementOwner {pid:number;nonce:string;configPath:string}

export class HttpError extends Error {constructor(readonly statusCode:number,message:string){super(message);}}
async function rawBody(request:IncomingMessage) {const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>1024*1024)throw new HttpError(413,'Request body exceeds 1 MiB.');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
function json(response:ServerResponse,value:unknown,status=200){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));}
export class AgentService {
  private runtimes=new Map<string,AgentRuntime>(); private running=new Map<string,Promise<void>>(); private stopping=false;
  private paused=false;private draining=false;private lifecycleBusy=false;private activeAdmissions=0;private managementOwner?:ManagementOwner;
  private closePromise?:Promise<void>;private resolveClosed!:()=>void;private rejectClosed!:(error:unknown)=>void;
  readonly closed=new Promise<void>((resolve,reject)=>{this.resolveClosed=resolve;this.rejectClosed=reject;});
  private timer?:NodeJS.Timeout; private polling=false; private nextPoll=new Map<string,number>(); private pollAbort=new AbortController();
  private server=createServer((request,response)=>{void this.handle(request,response);});
  private constructor(readonly config:ServiceConfig,readonly catalog:Catalog,private token:string){void this.closed.catch(()=>{});}
  static async open(config:ServiceConfig) {
    await loadServiceEnvironment(config.dataDir);
    if(config.github.mode==='webhook' && !process.env.GITHUB_WEBHOOK_SECRET)throw new Error('GITHUB_WEBHOOK_SECRET is required for webhook mode.');
    const catalog=await Catalog.open(config.dataDir,config.agents);let service:AgentService|undefined;
    try {
      const path=join(config.dataDir,'console-token');let token:string;
      try{token=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid console-token file.');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await writeFile(path,token+'\n',{flag:'wx',mode:0o600});}
      service=new AgentService(config,catalog,token);
      service.paused=await loadAdmissionPause(config.dataDir);
      for(const agent of config.agents)service.runtimes.set(agent.id,await AgentRuntime.open(config,agent));
      await new Promise<void>((resolve,reject)=>{service!.server.once('error',reject);service!.server.listen(config.port,config.host,()=>{service!.server.off('error',reject);resolve();});});
      service.kick();
      if(config.github.mode==='poll'){service.timer=setInterval(()=>{void service!.poll();},1000);void service.poll();}
      return service;
    }catch(error){if(service)await service.close();else catalog.close();throw error;}
  }
  get url(){const address=this.server.address();return `http://127.0.0.1:${typeof address==='object' && address ? address.port : this.config.port}`;}
  stats(){return Object.fromEntries([...this.runtimes].map(([id,runtime])=>[id,{providerCalls:runtime.calls}]));}
  setManagementOwner(owner:ManagementOwner){
    if(this.managementOwner||this.stopping||owner.pid!==process.pid||typeof owner.nonce!=='string'||!(/^[a-f0-9-]{36}$/i).test(owner.nonce)||typeof owner.configPath!=='string'||!isAbsolute(owner.configPath))throw new Error('Management owner must identify this process and its absolute configuration.');
    this.managementOwner=Object.freeze({pid:owner.pid,nonce:owner.nonce,configPath:owner.configPath});
  }
  async status(){
    const agents=await Promise.all(this.config.agents.map(async agent=>{const runtime=this.runtimes.get(agent.id)!,activity=await runtime.activity();return {id:agent.id,name:agent.name,...(agent.workspaceRoot?{workspaceRoot:agent.workspaceRoot}:{}),providerCalls:runtime.calls,eventJobs:this.catalog.counts(agent.id),...activity};}));
    const quiescent=!this.polling&&this.activeAdmissions===0&&this.running.size===0&&agents.every(agent=>agent.quiescent&&!(agent.eventJobs.queued||agent.eventJobs.running));
    return {supported:true,version:1,pid:process.pid,state:this.stopping?'stopping':this.draining?'draining':this.paused?'paused':'running',paused:this.paused,accepting:!this.stopping&&!this.paused,quiescent,polling:this.polling,activeAdmissions:this.activeAdmissions,
      provider:this.config.provider.kind,model:agents[0]?.model?.modelId??this.config.provider.model??'faux',modelPolicy:this.config.provider.model??'faux',watching:this.config.github.mode!=='off'&&!this.paused&&!this.stopping,activeGenerations:agents.reduce((sum,agent)=>sum+agent.tasks.runningGenerations,0),
      capabilities:['status','pause','resume','drained-shutdown','abort-background'],...(this.managementOwner?{owner:this.managementOwner}:{}),agents};
  }
  private requireAdmissions(){if(this.stopping)throw new HttpError(503,'Service is stopping.');if(this.paused)throw new HttpError(503,'New admissions are paused; accepted durable work continues draining.');}
  admit(event:AgentEvent){this.requireAdmissions();const ids=this.catalog.admit([event],this.config.agents);this.kick();return ids;}
  async pauseAdmissions(){
    this.paused=true;this.pollAbort.abort();await saveAdmissionPause(this.config.dataDir,true);
    for(const runtime of this.runtimes.values())runtime.trace('lifecycle.paused',{publicSummary:'New events and chat admissions paused; accepted durable work continues draining.'});
  }
  async resumeAdmissions(){
    if(this.stopping)throw new HttpError(503,'Service is stopping.');
    await saveAdmissionPause(this.config.dataDir,false);this.pollAbort=new AbortController();this.paused=false;
    for(const runtime of this.runtimes.values())runtime.trace('lifecycle.resumed',{publicSummary:'New event and chat admissions resumed.'});
    this.kick();if(this.config.github.mode==='poll')void this.poll();
  }
  private kick(){if(this.stopping)return;for(const agent of this.config.agents){if(this.running.has(agent.id))continue;const work=Promise.resolve().then(()=>this.drain(agent.id)).finally(()=>{this.running.delete(agent.id);if(!this.stopping&&this.catalog.next(agent.id))this.kick();});this.running.set(agent.id,work);}}
  private async drain(agentId:string){const runtime=this.runtimes.get(agentId)!;while(!this.stopping){const job=this.catalog.next(agentId);if(!job)return;this.catalog.update(job.id,'running');try{const result=await runtime.run(job,(conversationId,submissionId)=>this.catalog.update(job.id,'running',{conversationId,submissionId}));if(!this.stopping)this.catalog.update(job.id,result.status,result);}catch(error){if(!this.stopping)this.catalog.update(job.id,'failed',{error:error instanceof Error?error.message:'Task execution failed'});}}}
  async poll(){if(this.polling||this.stopping||this.paused)return;this.polling=true;
    try{for(const repository of [...new Set(this.config.agents.flatMap(a=>a.repositories))]){
      if(this.stopping||this.paused||Date.now()<(this.nextPoll.get(repository)??0))continue;
      try{const result=await pollPullRequests({repository,token:process.env.GITHUB_TOKEN,state:this.catalog.state(repository),initialScan:this.config.github.initialScan,maxPages:this.config.github.maxPages,signal:this.pollAbort.signal});if(this.stopping||this.paused)return;
        this.catalog.admit(result.events,this.config.agents,{repository,state:result.state});
        this.nextPoll.set(repository,Date.now()+Math.max(this.config.github.intervalMs,(result.state.minPollIntervalSeconds??0)*1000));this.kick();
      }catch(error){if(this.stopping||this.paused)return;const backoff=error instanceof GitHubEventError && error.retryAt?Date.parse(error.retryAt):Date.now()+Math.max(this.config.github.intervalMs,60000);this.nextPoll.set(repository,Math.max(Date.now()+1000,backoff));console.error(JSON.stringify({type:'poll-error',repository,code:error instanceof GitHubEventError?error.code:'network_error',retryAt:new Date(this.nextPoll.get(repository)!).toISOString()}));}
    }}finally{this.polling=false;}
  }
  private expectedOwner(value:unknown){
    const expected=value as Partial<ManagementOwner>|undefined;
    if(this.managementOwner){if(!expected||expected.pid!==this.managementOwner.pid||expected.nonce!==this.managementOwner.nonce)throw new HttpError(409,'The expected service owner does not match this process.');}
    else if(expected!==undefined)throw new HttpError(409,'This service has no registered console management owner.');
  }
  private async lifecycle(action:string,request:IncomingMessage,response:ServerResponse){
    const value=JSON.parse((await rawBody(request)).toString('utf8')) as Record<string,unknown>;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['expectedOwner','timeoutMs'].includes(key)))throw new HttpError(400,'Expected a bounded lifecycle request with expectedOwner and optional timeoutMs.');
    this.expectedOwner(value.expectedOwner);
    const timeoutMs=value.timeoutMs??0;
    if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<0||Number(timeoutMs)>60000||action!=='shutdown'&&value.timeoutMs!==undefined)throw new HttpError(400,'Shutdown timeoutMs must be an integer from 0 to 60000.');
    if(this.lifecycleBusy||this.stopping)throw new HttpError(409,'Another lifecycle operation is in progress.');
    this.lifecycleBusy=true;
    try{
      if(action==='pause'){await this.pauseAdmissions();json(response,await this.status());return;}
      if(action==='resume'){await this.resumeAdmissions();json(response,await this.status());return;}
      const wasPaused=this.paused;this.draining=true;await this.pauseAdmissions();
      const deadline=Date.now()+Number(timeoutMs);
      while(true){
        const status=await this.status();
        if(status.quiescent){
          // A normal restart retains an explicit pause, while an accepting owner
          // resumes its pre-stop policy. A crash or busy timeout stays paused.
          await saveAdmissionPause(this.config.dataDir,wasPaused);
          for(const runtime of this.runtimes.values())runtime.trace('lifecycle.shutdown',{publicSummary:'All event, control, child and background work drained before shutdown.'});
          response.once('finish',()=>{void this.close().catch(()=>{});});
          json(response,{accepted:true,drained:true,pauseOnRestart:wasPaused,status},202);return;
        }
        if(Date.now()>=deadline){
          this.draining=false;
          json(response,{error:'busy',message:'Accepted work is still active. Admissions remain paused; no task was aborted.',status:await this.status()},409);return;
        }
        await delay(Math.min(25,Math.max(1,deadline-Date.now())));
      }
    }finally{this.lifecycleBusy=false;if(!this.stopping)this.draining=false;}
  }
  private async handle(request:IncomingMessage,response:ServerResponse){try{
    const url=new URL(request.url??'/',this.url);
    if(request.method==='GET' && url.pathname==='/health'){json(response,{service:'pi-durable-agent-service',version:1});return;}
    if(request.method==='POST' && url.pathname==='/webhooks/github'){
      if(this.config.github.mode!=='webhook')throw new HttpError(404,'Webhook mode is disabled.');
      const event=parseWebhook(await rawBody(request),{event:String(request.headers['x-github-event']??''),signature:String(request.headers['x-hub-signature-256']??''),delivery:String(request.headers['x-github-delivery']??'')},process.env.GITHUB_WEBHOOK_SECRET!);
      json(response,{accepted:true,jobs:event?this.admit(event):[]},202);return;
    }
    const provided=Buffer.from(request.headers.authorization??'');const expected=Buffer.from(`Bearer ${this.token}`);
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new HttpError(401,'A local console bearer token is required.');
    if(request.headers.origin && request.headers.origin!==this.url)throw new HttpError(403,'Cross-origin requests are disabled.');
    if(request.method==='GET'&&url.pathname==='/v1/status'){json(response,await this.status());return;}
    const lifecycle=/^\/v1\/lifecycle\/(pause|resume|shutdown)$/.exec(url.pathname);
    if(request.method==='POST'&&lifecycle){await this.lifecycle(lifecycle[1],request,response);return;}
    if(request.method==='GET' && url.pathname==='/v1/agents'){json(response,{agents:this.catalog.agents().map(agent=>{const workspaceRoot=this.config.agents.find(item=>item.id===agent.id)?.workspaceRoot;return {...agent,...(workspaceRoot?{workspaceRoot}:{})};}),mode:this.config.provider.kind});return;}
    if(request.method==='POST' && url.pathname==='/v1/events'){
      const value=JSON.parse((await rawBody(request)).toString('utf8')) as AgentEvent;
      if(value.type!=='pull_request.opened'||!Number.isInteger(value.number)||value.number<1||!this.config.agents.some(a=>a.repositories.includes(String(value.repository).toLowerCase())))throw new HttpError(400,'Expected an allowlisted pull_request.opened event.');
      value.repository=value.repository.toLowerCase();value.id=`github:${value.repository}:pull_request:${value.number}:opened`;
      json(response,{jobs:this.admit(value)},202);return;
    }
    const match=/^\/v1\/agents\/([a-z][a-z0-9-]*)\/(jobs|chat|messages|evidence|feedback|submissions\/[0-9]+|abort)$/.exec(url.pathname);
    if(!match)throw new HttpError(404,'Unknown service route.');const runtime=this.runtimes.get(match[1]);if(!runtime)throw new HttpError(404,'Agent is not active in this configuration.');
    const jobId=url.searchParams.get('jobId')??undefined;
    if(jobId && !this.catalog.job(match[1],jobId))throw new HttpError(404,'Unknown job for this agent.');
    if(request.method==='GET'&&match[2]==='jobs'){json(response,{jobs:this.catalog.jobs(match[1])});return;}
    if(request.method==='GET'&&match[2]==='evidence'){const limit=Number(url.searchParams.get('limit')??100);if(!Number.isInteger(limit)||limit<1||limit>10000)throw new HttpError(400,'Evidence limit must be from 1 to 10000.');json(response,{records:runtime.evidence.list(match[1],limit)});return;}
    if(request.method==='POST'&&match[2]==='feedback'){
      const value=JSON.parse((await rawBody(request)).toString('utf8')) as Record<string,unknown>;
      if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>4000||!Array.isArray(value.evidenceIds)||value.evidenceIds.length>30||value.evidenceIds.some(id=>typeof id!=='string'||!runtime.evidence.has(match[1],id)))throw new HttpError(400,'Feedback requires a bounded summary and existing evidence IDs for this agent.');
      const receipt=runtime.trace('feedback.recorded',{summary:value.summary,evidenceIds:value.evidenceIds,source:'authenticated-local-user'},jobId?{jobId}:{});json(response,{evidenceId:receipt.id},201);return;
    }
    if(request.method==='GET'&&match[2]==='chat'){json(response,await runtime.snapshot(jobId));return;}
    if(request.method==='GET'&&match[2].startsWith('submissions/')){const status=await runtime.status(Number(match[2].split('/')[1]));if(!status)throw new HttpError(404,'Unknown submission.');json(response,status);return;}
    if(request.method==='POST'&&match[2]==='messages'){
      const value=JSON.parse((await rawBody(request)).toString('utf8')) as Record<string,unknown>;
      if(typeof value.content!=='string'||!value.content.trim()||value.content.length>100000||typeof value.requestId!=='string'||!value.requestId||!['followUp','steer','reject'].includes(String(value.whenBusy??'followUp')))throw new HttpError(400,'content, stable requestId and a valid whenBusy mode are required.');
      this.requireAdmissions();this.activeAdmissions++;
      try{const receipt=await runtime.submitHuman({content:value.content,requestId:value.requestId,whenBusy:(value.whenBusy??'followUp') as 'followUp'|'steer'|'reject'},jobId);json(response,receipt,202);return;}
      finally{this.activeAdmissions--;}
    }
    if(request.method==='POST'&&match[2]==='abort'){
      const value=JSON.parse((await rawBody(request)).toString('utf8')) as {background?:boolean};
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='background')||value.background!==undefined&&typeof value.background!=='boolean')throw new HttpError(400,'Abort accepts only an optional explicit background boolean.');
      await runtime.abort(jobId,{background:value.background??false});json(response,{aborted:true,background:value.background??false});return;
    }
    throw new HttpError(405,'Method not allowed.');
  }catch(error){if(!response.headersSent)json(response,{error:error instanceof Error?error.message:'Request failed'},(error as {statusCode?:number}).statusCode??(error instanceof SyntaxError?400:500));else response.end();}}
  close():Promise<void>{
    if(this.closePromise)return this.closePromise;this.stopping=true;if(this.timer)clearInterval(this.timer);this.pollAbort.abort();
    this.closePromise=(async()=>{if(this.server.listening)await new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve()));
      while(this.polling)await delay(10);await Promise.all([...this.runtimes.values()].map(runtime=>runtime.close()));await Promise.allSettled(this.running.values());this.catalog.close();})();
    this.closePromise.then(this.resolveClosed,this.rejectClosed);return this.closePromise;
  }
}
