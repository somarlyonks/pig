// Pi loads TypeScript directly. Lifecycle operations use authenticated ownership, never PID-only termination.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServiceConnection } from './client.js';
import { safeText } from './display.js';

export interface ManagedDescriptor {
  version: 1; kind: 'pi-durable-console-managed'; agentId: string; serviceId: string;
  configFile: 'config.json'; dataDir: 'state'; hostFile: 'agent-host.mjs'; hostSha256: string;
}
export interface ManagedProject {
  projectDir: string; configPath: string; dataDir: string; agentId: string;
  target: string; hostPath: string; descriptor: ManagedDescriptor;
}
export interface ConfiguredAgent {
  id: string; name: string; workspaceRoot?: string;
  modelChoice?: {model?:string;task?:string;thinkingLevel?:string};
}
export interface ManagedOwner {pid:number;nonce:string;configPath:string}
export interface ManagedInspection {
  managed: boolean; state: 'running'|'paused'|'stopped'|'unreachable'|'unmanaged';
  project?: ManagedProject; owner?: ManagedOwner; status?: Record<string,unknown>;
  lastKnownOwner?: {pid:number;configPath:string};
  reason?: string; agent?: ConfiguredAgent;
}
export interface ManagementOptions {signal?:AbortSignal;timeoutMs?:number;fetch?:typeof fetch}
export interface StopOptions extends ManagementOptions {drainTimeoutMs?:number}
export type LoginStartupAction='plan'|'install'|'status'|'uninstall';
export interface LoginStartupOptions extends ManagementOptions {
  /** Acceptance fixtures inject the native executor. Interactive callers omit it. */
  nativeRunner?:(project:ManagedProject,action:'install'|'start'|'status'|'uninstall',options:Record<string,unknown>,execute:boolean,signal?:AbortSignal)=>Promise<Record<string,unknown>>;
}
export class AgentManagementError extends Error {
  constructor(readonly code:string,message:string,readonly status?:number){super(message);this.name='AgentManagementError';}
}
const LIMIT=256*1024;
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const tasks=new Set(['routine','coding','review','research','reflection']);
const efforts=new Set(['off','minimal','low','medium','high','xhigh','max']);
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function hash(value:Uint8Array){return createHash('sha256').update(value).digest('hex');}
function fail(code:string,message:string):never{throw new AgentManagementError(code,message);}
function samePath(left:string,right:string){return process.platform==='win32'?resolve(left).toLowerCase()===resolve(right).toLowerCase():resolve(left)===resolve(right);}
function inside(root:string,target:string){const path=relative(root,target);return !isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);}
function abort(signal?:AbortSignal){if(signal?.aborted)fail('cancelled','The local management wait was cancelled. Inspect the service before repeating a lifecycle operation.');}
function validateOptions(options:ManagementOptions){abort(options.signal);if(options.timeoutMs!==undefined&&(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>60000))fail('input_invalid','Choose a lifecycle timeout from 1 to 60000 milliseconds.');}
async function bounded(path:string,limit=LIMIT):Promise<Buffer>{
  if(!(await lstat(path)).isFile())fail('config_invalid','Management requires ordinary project files.');
  const handle=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NONBLOCK|constants.O_NOFOLLOW));
  try{if(!(await handle.stat()).isFile())fail('config_invalid','Management requires ordinary project files.');const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const value=await handle.read(buffer,length,buffer.length-length,null);if(!value.bytesRead)break;length+=value.bytesRead;}
    if(length>limit)fail('file_too_large','A management file exceeds its bounded size limit.');return buffer.subarray(0,length);
  }finally{await handle.close();}
}
async function jsonFile(path:string,limit=LIMIT):Promise<unknown>{return JSON.parse((await bounded(path,limit)).toString('utf8'));}
async function atomicJson(path:string,value:unknown){
  try{if((await lstat(path)).isSymbolicLink())fail('path_redirected','A management artifact was redirected.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
async function safeDirectory(project:ManagedProject,path:string){await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink()||!inside(project.projectDir,await realpath(path)))fail('path_redirected','A managed project directory was redirected outside its ownership scope.');}
function validModel(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\s\x00-\x1f\x7f]/.test(value);}
async function localConfig(connection:ServiceConnection):Promise<Record<string,unknown>>{
  if(!isAbsolute(connection.configPath)||!isAbsolute(connection.dataDir))fail('config_invalid','The configured project paths must be absolute.');
  const value=await jsonFile(connection.configPath);
  if(!object(value)||value.version!==1||value.host!=='127.0.0.1'||!Number.isInteger(value.port)||Number(value.port)<1||Number(value.port)>65535||typeof value.dataDir!=='string'||!value.dataDir||!samePath(resolve(dirname(connection.configPath),value.dataDir),connection.dataDir)||connection.baseUrl!==`http://127.0.0.1:${value.port}`||!Array.isArray(value.agents)||value.agents.length>64)fail('config_invalid','The service configuration does not match this loopback connection.');
  return value;
}

/** Read safe configured identities even when the service is stopped. Never return prompts or account settings. */
export async function readConfiguredAgents(connection:ServiceConnection):Promise<ConfiguredAgent[]>{
  const value=await localConfig(connection),agents:ConfiguredAgent[]=[],ids=new Set<string>();
  for(const candidate of value.agents as unknown[]){
    if(!object(candidate)||typeof candidate.id!=='string'||!ID.test(candidate.id)||ids.has(candidate.id)||typeof candidate.name!=='string'||!candidate.name.trim()||candidate.name.length>120||/[\x00-\x1f\x7f]/.test(candidate.name))fail('config_invalid','A configured agent identity is invalid.');
    ids.add(candidate.id);const entry:ConfiguredAgent={id:candidate.id,name:candidate.name};
    if(typeof candidate.workspaceRoot==='string'&&isAbsolute(candidate.workspaceRoot)&&candidate.workspaceRoot.length<=4096&&!/[\x00-\x1f\x7f]/.test(candidate.workspaceRoot))entry.workspaceRoot=candidate.workspaceRoot;
    if(object(candidate.modelChoice)){
      const choice=candidate.modelChoice;entry.modelChoice={...(validModel(choice.model)?{model:choice.model}:{}),...(typeof choice.task==='string'&&tasks.has(choice.task)?{task:choice.task}:{}),...(typeof choice.thinkingLevel==='string'&&efforts.has(choice.thinkingLevel)?{thinkingLevel:choice.thinkingLevel}:{})};
    }
    agents.push(entry);
  }
  return agents;
}

/** Only factory-marked projects with their original management host can be controlled. */
export async function resolveManagedProject(connection:ServiceConnection):Promise<ManagedProject>{
  await localConfig(connection);
  const configPath=await realpath(connection.configPath),projectDir=await realpath(dirname(configPath));
  const marker=join(projectDir,'managed-agent.json');
  let descriptor:unknown;
  try{if((await lstat(marker)).isSymbolicLink())fail('unmanaged','The management descriptor must be a project-local ordinary file.');descriptor=await jsonFile(marker,16384);}
  catch(error){if(error instanceof AgentManagementError)throw error;fail('unmanaged','This service is not a lifecycle-managed console project. Existing external services remain read-only in this console.');}
  if(!object(descriptor)||descriptor.version!==1||descriptor.kind!=='pi-durable-console-managed'||typeof descriptor.agentId!=='string'||!ID.test(descriptor.agentId)||descriptor.serviceId!==connection.id||descriptor.configFile!=='config.json'||descriptor.dataDir!=='state'||descriptor.hostFile!=='agent-host.mjs'||typeof descriptor.hostSha256!=='string'||!/^[a-f0-9]{64}$/.test(descriptor.hostSha256))fail('unmanaged','The project management descriptor is invalid or belongs to another connection.');
  if(!samePath(configPath,join(projectDir,descriptor.configFile))||!samePath(connection.dataDir,join(projectDir,descriptor.dataDir)))fail('unmanaged','The management descriptor does not own these configuration and state paths.');
  try{if((await lstat(connection.dataDir)).isSymbolicLink()||!inside(projectDir,await realpath(connection.dataDir)))fail('path_redirected','The managed state directory was redirected outside its project.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const hostPath=join(projectDir,descriptor.hostFile);
  if((await lstat(hostPath)).isSymbolicLink()||!samePath(await realpath(hostPath),hostPath)||hash(await bounded(hostPath,128*1024))!==descriptor.hostSha256)fail('host_changed','The management host changed. Review the project before enabling lifecycle actions.');
  const agents=await readConfiguredAgents(connection);
  if(!agents.some(agent=>agent.id===descriptor.agentId))fail('unmanaged','The management descriptor agent is absent from this configuration.');
  return {projectDir,configPath,dataDir:connection.dataDir,agentId:descriptor.agentId,target:`${connection.id}/${descriptor.agentId}`,hostPath,descriptor:descriptor as unknown as ManagedDescriptor};
}
async function ownerRecord(project:ManagedProject):Promise<ManagedOwner|undefined>{
  let value:unknown;
  try{value=await jsonFile(join(project.dataDir,'creation-owner.json'),4096);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;fail('owner_invalid','The project process receipt cannot be verified.');}
  if(!object(value)||value.version!==1||!Number.isSafeInteger(value.pid)||Number(value.pid)<1||typeof value.nonce!=='string'||!/^[a-f0-9-]{36}$/i.test(value.nonce)||typeof value.configPath!=='string'||!samePath(value.configPath,project.configPath))fail('owner_invalid','The project process receipt does not match the managed project.');
  return {pid:Number(value.pid),nonce:value.nonce,configPath:value.configPath};
}
async function lastKnownOwner(project:ManagedProject):Promise<{pid:number;configPath:string}|undefined>{
  for(const file of [join(project.dataDir,'last-owner.json'),join(project.projectDir,'creation-receipt.json')]){
    let value:unknown;try{value=await jsonFile(file,16384);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!object(value)||!Number.isSafeInteger(value.pid)||Number(value.pid)<1||typeof value.configPath!=='string'||!samePath(value.configPath,project.configPath))fail('owner_invalid','A retained process receipt cannot be attributed to this project.');
    if(file.endsWith('creation-receipt.json')&&(typeof value.projectDir!=='string'||!samePath(value.projectDir,project.projectDir)||value.target!==project.target))fail('owner_invalid','The retained creation receipt belongs to another managed project.');
    return {pid:Number(value.pid),configPath:value.configPath};
  }
}
function alive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
async function request(connection:ServiceConnection,path:string,body:unknown,options:ManagementOptions={},timeoutMs?:number):Promise<Record<string,unknown>>{
  abort(options.signal);let token:string;
  try{token=(await bounded(join(connection.dataDir,'console-token'),256)).toString('utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error();}
  catch{fail('token_unavailable','The managed service token is unavailable. Start the service or inspect its local state.');}
  const duration=timeoutMs??options.timeoutMs??5000;
  if(!Number.isFinite(duration)||duration<1||duration>65000)fail('input_invalid','Choose a management timeout from 1 to 65000 milliseconds.');
  const deadline=AbortSignal.timeout(duration),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  try{
    const response=await(options.fetch??fetch)(connection.baseUrl+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal});
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>LIMIT)){await response.body?.cancel();fail('response_too_large','The management response exceeds its bounded size limit.');}
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>LIMIT)fail('response_too_large','The management response exceeds its bounded size limit.');chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!object(value))fail('response_invalid','The managed service returned an invalid status object.');
    if(!response.ok)throw new AgentManagementError(response.status===409?'busy':'request_failed',response.status===409?'The service is busy or its ownership changed. Inspect status and drain accepted work before retrying.':`The management request failed (HTTP ${response.status}).`,response.status);
    return value;
  }catch(error){if(error instanceof AgentManagementError)throw error;if(options.signal?.aborted)abort(options.signal);throw new AgentManagementError('unreachable','The managed endpoint could not be reached or verified. No process was terminated.');}
}
function matchesOwner(value:unknown,expected:ManagedOwner,configPath:string):value is ManagedOwner{return object(value)&&value.pid===expected.pid&&value.nonce===expected.nonce&&typeof value.configPath==='string'&&samePath(value.configPath,configPath);}
export async function inspectManaged(connection:ServiceConnection,options:ManagementOptions={}):Promise<ManagedInspection>{
  validateOptions(options);
  let project:ManagedProject;
  try{project=await resolveManagedProject(connection);}catch(error){return {managed:false,state:'unmanaged',reason:error instanceof AgentManagementError?error.message:'The local service configuration cannot be inspected.'};}
  const agent=(await readConfiguredAgents(connection)).find(item=>item.id===project.agentId);
  let owner:ManagedOwner|undefined;
  try{owner=await ownerRecord(project);}catch(error){return {managed:true,state:'unreachable',project,agent,reason:(error as Error).message};}
  try{
    const status=await request(connection,'/v1/status',undefined,options);
    if(!owner||!matchesOwner(status.owner,owner,project.configPath))return {managed:true,state:'unreachable',project,agent,owner,reason:'The endpoint identity does not match this project owner.'};
    return {managed:true,state:status.paused===true?'paused':'running',project,agent,owner,status};
  }catch(error){
    if(!owner){
      try{const last=await lastKnownOwner(project);if(last&&alive(last.pid))return {managed:true,state:'unreachable',project,agent,lastKnownOwner:last,reason:'A previously recorded process is still alive although its active owner receipt and endpoint are absent. No stopped state or PID-only termination is assumed.'};}
      catch{return {managed:true,state:'unreachable',project,agent,reason:'The retained process identity cannot be verified.'};}
    }
    const stopped=!owner||!alive(owner.pid);
    return {managed:true,state:stopped?'stopped':'unreachable',project,agent,owner,...(!stopped?{reason:error instanceof AgentManagementError?error.message:'The endpoint could not be verified.'}:{})};
  }
}
async function operation<T>(project:ManagedProject,work:()=>Promise<T>):Promise<T>{
  await safeDirectory(project,project.dataDir);const path=join(project.dataDir,'management.lock');let lock;
  try{lock=await open(path,'wx',0o600);}catch{fail('management_busy','Another lifecycle action holds this project lock. Inspect the retained lock before retrying.');}
  try{return await work();}finally{await lock.close();await rm(path,{force:true});}
}
/** Share the lifecycle exclusion lock with project-local quality and model-freeze operations. */
export async function withManagedOperation<T>(project:ManagedProject,work:()=>Promise<T>,options:{signal?:AbortSignal}={}):Promise<T>{
  abort(options.signal);return operation(project,async()=>{abort(options.signal);return work();});
}
async function startUnlocked(connection:ServiceConnection,project:ManagedProject,options:ManagementOptions,recover=false):Promise<ManagedInspection>{
  abort(options.signal);const current=await inspectManaged(connection,options);
  if(current.status?.state==='draining'||current.status?.state==='stopping')fail('busy','The current owner is draining or stopping. Wait for its lifecycle operation before starting again.');
  if(current.state==='running'||current.state==='paused')return current;
  if(current.state==='unreachable'&&!recover)fail('owner_unverified','The recorded owner cannot be verified. Use explicit recovery after inspecting status and logs; no PID-only termination is allowed.');
  abort(options.signal);
  const native=await readNativeMarker(project);
  if(native){
    if(native.phase!=='installed')fail('native_recovery_required','A login-startup operation was interrupted. Inspect or uninstall the owned native registration before starting.');
    await runNativeCommand(project,'start',native.options,true,options);
    return await waitForManagedOwner(connection,options);
  }
  const logs=join(project.projectDir,'logs');await safeDirectory(project,logs);
  for(const name of ['host.stdout.log','host.stderr.log'])try{if(!(await lstat(join(logs,name))).isFile())fail('path_redirected','The managed host log is not an ordinary local file.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const stdout=openSync(join(logs,'host.stdout.log'),'a',0o600),stderr=openSync(join(logs,'host.stderr.log'),'a',0o600);
  let pid:number|undefined;
  try{const child=spawn(process.execPath,[project.hostPath],{cwd:project.projectDir,windowsHide:true,detached:true,shell:false,stdio:['ignore',stdout,stderr]});await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',()=>reject(new AgentManagementError('start_failed','The managed host could not be started.')));});pid=child.pid;child.unref();}
  finally{closeSync(stdout);closeSync(stderr);}
  if(!pid)fail('start_failed','The managed host did not receive a process identity.');
  const deadline=Date.now()+(options.timeoutMs??45000);
  while(Date.now()<deadline){
    abort(options.signal);const value=await inspectManaged(connection,{...options,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
    if((value.state==='running'||value.state==='paused')&&value.owner?.pid===pid)return value;
    if(!alive(pid))fail('start_failed','The new host exited before becoming ready. Inspect the project logs; no other process was stopped.');
    await delay(Math.min(250,Math.max(1,deadline-Date.now())),undefined,{signal:options.signal});
  }
  fail('start_timeout',`The new owner did not become ready in time. Inspect project logs and PID ${pid}; an admitted recovery may still be running.`);
}
export async function startManaged(connection:ServiceConnection,options:ManagementOptions={}):Promise<ManagedInspection>{validateOptions(options);const project=await resolveManagedProject(connection);return operation(project,()=>startUnlocked(connection,project,options));}
/** Recovery retries the pinned host; the SQLite owner lock still excludes a second active owner. */
export async function recoverManaged(connection:ServiceConnection,options:ManagementOptions={}):Promise<ManagedInspection>{validateOptions(options);const project=await resolveManagedProject(connection);return operation(project,()=>startUnlocked(connection,project,options,true));}
async function requireRunning(connection:ServiceConnection,options:ManagementOptions){const current=await inspectManaged(connection,options);if(!current.managed||!current.project)fail('unmanaged',current.reason??'This service is not lifecycle-managed.');if(!current.owner||!['running','paused'].includes(current.state))fail('not_running','The managed owner is not reachable. Start or recover this project first.');return current as ManagedInspection&{project:ManagedProject;owner:ManagedOwner};}
async function mutate(connection:ServiceConnection,action:'pause'|'resume',options:ManagementOptions):Promise<ManagedInspection>{validateOptions(options);const project=await resolveManagedProject(connection);return operation(project,async()=>{const current=await requireRunning(connection,options);await request(connection,`/v1/lifecycle/${action}`,{expectedOwner:{pid:current.owner.pid,nonce:current.owner.nonce}},options);return inspectManaged(connection,options);});}
export async function pauseManaged(connection:ServiceConnection,options:ManagementOptions={}):Promise<ManagedInspection>{return mutate(connection,'pause',options);}
export async function resumeManaged(connection:ServiceConnection,options:ManagementOptions={}):Promise<ManagedInspection>{return mutate(connection,'resume',options);}
async function stopUnlocked(connection:ServiceConnection,project:ManagedProject,options:StopOptions):Promise<ManagedInspection>{
  const current=await inspectManaged(connection,options);if(current.state==='stopped')return current;
  if(!current.owner||!['running','paused'].includes(current.state))fail('owner_unverified','The owner is unreachable or does not match this project. No PID-only termination is allowed.');
  const drain=options.drainTimeoutMs??30000;if(!Number.isInteger(drain)||drain<0||drain>60000)fail('input_invalid','Choose a drain timeout from 0 to 60000 milliseconds.');
  await request(connection,'/v1/lifecycle/shutdown',{expectedOwner:{pid:current.owner.pid,nonce:current.owner.nonce},timeoutMs:drain},options,Math.min(65000,drain+5000));
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){abort(options.signal);const record=await ownerRecord(project);if(!record&&!alive(current.owner.pid))return {...current,state:'stopped',owner:undefined,status:undefined};if(record&&record.nonce!==current.owner.nonce)fail('owner_changed','Another owner appeared while stopping. It was not stopped.');await delay(100,undefined,{signal:options.signal});}
  fail('stop_unconfirmed','The shutdown was accepted but process exit is not confirmed. Inspect status before restarting.');
}
export async function stopManaged(connection:ServiceConnection,options:StopOptions={}):Promise<ManagedInspection>{validateOptions(options);const project=await resolveManagedProject(connection);return operation(project,()=>stopUnlocked(connection,project,options));}
export async function restartManaged(connection:ServiceConnection,options:StopOptions={}):Promise<ManagedInspection>{validateOptions(options);const project=await resolveManagedProject(connection);return operation(project,async()=>{await stopUnlocked(connection,project,options);return startUnlocked(connection,project,options);});}

async function logTail(handle:Awaited<ReturnType<typeof open>>,size:number,max:number):Promise<{text:string;truncated:boolean}>{
  const header=Buffer.alloc(3),observed=await handle.read(header,0,header.length,0);
  const little=observed.bytesRead>=2&&header[0]===0xff&&header[1]===0xfe;
  const big=observed.bytesRead>=2&&header[0]===0xfe&&header[1]===0xff;
  const offset=little||big?2:observed.bytesRead===3&&header[0]===0xef&&header[1]===0xbb&&header[2]===0xbf?3:0;
  let start=Math.max(offset,size-max);
  if(little||big)start+=(start-offset)%2;
  let length=Math.max(0,Math.min(max,size-start));if(little||big)length-=length%2;
  const buffer=Buffer.alloc(length),read=await handle.read(buffer,0,length,start);
  let content=buffer.subarray(0,read.bytesRead);if(little||big)content=content.subarray(0,content.length-content.length%2);
  if(big)content.swap16();
  return {text:safeText(content.toString(little||big?'utf16le':'utf8'),max),truncated:start>offset||size-start>content.length};
}
export async function readManagedLogs(connection:ServiceConnection,options:ManagementOptions&{maxBytes?:number}={}):Promise<{projectDir:string;files:Array<{name:string;text:string;truncated:boolean}>}>{
  abort(options.signal);
  const project=await resolveManagedProject(connection),max=options.maxBytes??16384;
  if(!Number.isInteger(max)||max<1||max>65536)fail('input_invalid','Choose a log tail size from 1 to 65536 bytes.');
  const files:Array<{name:string;text:string;truncated:boolean}>=[];
  for(const name of ['host.stdout.log','host.stderr.log','install.log','build.log','state/logs/service.stdout.log','state/logs/service.stderr.log']){
    abort(options.signal);
    const path=name.startsWith('state/')?join(project.projectDir,name):join(project.projectDir,'logs',name);let handle;
    try{if(!(await lstat(path)).isFile()||!inside(project.projectDir,await realpath(path)))fail('log_invalid','A project log path was redirected or is not an ordinary file.');handle=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NONBLOCK|constants.O_NOFOLLOW));const info=await handle.stat();if(!info.isFile())fail('log_invalid','Project logs must be ordinary files.');files.push({name,...await logTail(handle,info.size,max)});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    finally{await handle?.close();}
  }
  return {projectDir:project.projectDir,files};
}

/** Archive only unregisters a confirmed stopped project. Source, state, logs and receipts stay intact. */
export async function archiveManaged(connection:ServiceConnection,options:ManagementOptions&{connectionsFile:string}):Promise<{archived:true;projectDir:string;filesPreserved:true}>{
  const project=await resolveManagedProject(connection);
  return operation(project,async()=>{
    const current=await inspectManaged(connection,options);if(current.state!=='stopped')fail('not_stopped','Drain and stop this owner before archiving its console registration.');
    if(await readNativeMarker(project))fail('native_installed','Uninstall login startup before archiving this registration; all project files will remain intact.');
    abort(options.signal);
    const path=resolve(options.connectionsFile),lockPath=path+'.creation.lock';let lock;
    try{lock=await open(lockPath,'wx',0o600);}catch{fail('registry_busy','Another operation is updating the console registry.');}
    let temporary:string|undefined;
    try{
      const before=await bounded(path),value=JSON.parse(before.toString('utf8'));
      if(!object(value)||value.version!==1||!Array.isArray(value.services))fail('registry_invalid','The selected registry is invalid.');
      const matches=value.services.filter((item:unknown)=>object(item)&&item.id===connection.id);
      if(matches.length!==1||typeof matches[0].configPath!=='string'||!samePath(resolve(dirname(path),matches[0].configPath),project.configPath))fail('registry_changed','The exact managed connection is no longer present. No registration was removed.');
      const receipt={version:1,archivedAt:new Date().toISOString(),serviceId:connection.id,agentId:project.agentId,configPath:project.configPath,filesPreserved:true};
      await atomicJson(join(project.projectDir,'archive-receipt.json'),receipt);
      value.services=value.services.filter((item:unknown)=>!object(item)||item.id!==connection.id);
      temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
      if(hash(await bounded(path))!==hash(before))fail('registry_changed','The console registry changed during archive. No registration was removed.');
      abort(options.signal);
      await rename(temporary,path);temporary=undefined;
      return {archived:true,projectDir:project.projectDir,filesPreserved:true};
    }finally{if(temporary)await rm(temporary,{force:true});await lock.close();await rm(lockPath,{force:true});}
  });
}

/** Resolve a factory-marked configuration for an explicit reconnect review, without starting it. */
export async function connectionFromManagedConfig(configPath:string):Promise<ServiceConnection>{
  if(!isAbsolute(configPath))fail('input_invalid','Choose an absolute managed config.json path.');
  const path=await realpath(configPath),root=dirname(path),config=await jsonFile(path),marker=await jsonFile(join(root,'managed-agent.json'),16384);
  if(!object(config)||typeof config.dataDir!=='string'||config.host!=='127.0.0.1'||!Number.isInteger(config.port)||Number(config.port)<1||Number(config.port)>65535||!object(marker)||typeof marker.serviceId!=='string'||!ID.test(marker.serviceId))fail('unmanaged','Choose an existing factory-managed service configuration.');
  const connection:ServiceConnection={id:marker.serviceId,name:marker.serviceId,configPath:path,dataDir:resolve(root,config.dataDir),baseUrl:`http://127.0.0.1:${config.port}`};
  const project=await resolveManagedProject(connection),agent=(await readConfiguredAgents(connection)).find(item=>item.id===project.agentId);
  connection.name=agent?.name??connection.id;return connection;
}
/** Reattach an existing managed project. It remains stopped unless separately started. */
export async function restoreManaged(configPath:string,options:ManagementOptions&{connectionsFile:string}):Promise<{restored:true;target:string;projectDir:string;started:false}>{
  const connection=await connectionFromManagedConfig(configPath),project=await resolveManagedProject(connection);
  return operation(project,async()=>{
    abort(options.signal);const path=resolve(options.connectionsFile);await mkdir(dirname(path),{recursive:true});
    const lockPath=path+'.creation.lock';let lock;
    try{lock=await open(lockPath,'wx',0o600);}catch{fail('registry_busy','Another operation is updating the console registry.');}
    let temporary:string|undefined;
    try{
      let before:Buffer|undefined,value:Record<string,unknown>;
      try{before=await bounded(path);const read=JSON.parse(before.toString('utf8'));if(!object(read))throw new Error();value=read;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')fail('registry_invalid','The selected registry cannot be read.');value={version:1,services:[]};}
      if(value.version!==1||!Array.isArray(value.services)||value.services.length>=32)fail('registry_invalid','The selected registry must have room for a managed service.');
      if(value.services.some((item:unknown)=>object(item)&&item.id===connection.id))fail('duplicate_service','A registered service already uses that ID. No connection was replaced.');
      const local=relative(dirname(path),connection.configPath);
      value.services.push({id:connection.id,name:connection.name,configPath:isAbsolute(local)?connection.configPath:local.split(sep).join('/')});
      const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');if(bytes.length>LIMIT)fail('registry_invalid','The updated registry exceeds its bounded size limit.');
      temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
      let now:Buffer|undefined;try{now=await bounded(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if((before===undefined)!==(now===undefined)||before&&now&&hash(before)!==hash(now))fail('registry_changed','The registry changed during reconnect. No connection was replaced.');
      abort(options.signal);
      await rename(temporary,path);temporary=undefined;
      return {restored:true,target:project.target,projectDir:project.projectDir,started:false};
    }finally{if(temporary)await rm(temporary,{force:true});await lock.close();await rm(lockPath,{force:true});}
  });
}

interface NativeMarker {version:1;phase:'installing'|'installed'|'uninstalling';ownerId:string;options:Record<string,unknown>}
function nativeOwner(options:Record<string,unknown>):string{
  const names=[options.serviceName,options.projectDir,options.configPath,options.dataDir,options.entryPath];
  if(names.some(item=>typeof item!=='string'))fail('native_invalid','The login startup ownership fields are invalid.');
  const identity=(names as string[]).map(item=>process.platform==='win32'?resolve(item).toLowerCase():resolve(item));
  // The service name is an identity string, not a filesystem path.
  identity[0]=String(options.serviceName);
  return 'pi-durable-service:'+hash(Buffer.from(JSON.stringify(identity)));
}
function validateNativeOptions(project:ManagedProject,value:Record<string,unknown>){
  if(!['win32','darwin'].includes(String(value.platform))||value.platform!==process.platform||typeof value.nodePath!=='string'||!isAbsolute(value.nodePath)||typeof value.serviceName!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(value.serviceName)||!samePath(String(value.projectDir),project.projectDir)||!samePath(String(value.configPath),project.configPath)||!samePath(String(value.dataDir),project.dataDir)||!samePath(String(value.entryPath),project.hostPath))fail('native_invalid','The login startup marker belongs to another project or operating system.');
}
async function nativeOptions(project:ManagedProject):Promise<Record<string,unknown>>{
  if(process.platform!=='win32'&&process.platform!=='darwin')fail('platform_unsupported','Login startup is supported on native Windows or macOS. Background lifecycle remains available.');
  const config=await jsonFile(project.configPath);if(!object(config)||typeof config.serviceName!=='string')fail('native_invalid','A project-local serviceName is required for login startup.');
  const result={platform:process.platform,projectDir:project.projectDir,configPath:project.configPath,dataDir:project.dataDir,nodePath:process.execPath,serviceName:config.serviceName,entryPath:project.hostPath};
  validateNativeOptions(project,result);return result;
}
async function readNativeMarker(project:ManagedProject):Promise<NativeMarker|undefined>{
  let value:unknown;try{value=await jsonFile(join(project.projectDir,'native-service.json'),16384);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!object(value)||value.version!==1||!['installing','installed','uninstalling'].includes(String(value.phase))||typeof value.ownerId!=='string'||!object(value.options))fail('native_invalid','The login startup ownership marker is invalid.');
  validateNativeOptions(project,value.options);
  if(value.ownerId!==nativeOwner(value.options))fail('native_invalid','The login startup ownership marker does not match this project.');
  return value as unknown as NativeMarker;
}
async function runNativeCommand(project:ManagedProject,action:'install'|'start'|'status'|'uninstall',options:Record<string,unknown>,execute:boolean,context:LoginStartupOptions):Promise<Record<string,unknown>>{
  abort(context.signal);validateNativeOptions(project,options);
  const expected=nativeOwner(options);let result:Record<string,unknown>;
  if(context.nativeRunner)result=await context.nativeRunner(project,action,options,execute,context.signal);
  else{
    const cli=join(project.projectDir,'dist/src/cli.js');if(!(await lstat(cli)).isFile()||!inside(project.projectDir,await realpath(cli)))fail('native_invalid','Build the project-local service CLI before managing login startup.');
    const optionsFile=join(project.dataDir,'login-startup-options.json');await atomicJson(optionsFile,options);
    result=await new Promise<Record<string,unknown>>((accept,reject)=>{
      const child=spawn(process.execPath,[cli,'service',action,'--config',project.configPath,'--options',optionsFile,...(execute?['--execute']:[])],{cwd:project.projectDir,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let output='',bytes=0,settled=false;
      const finish=(error?:Error,value?:Record<string,unknown>)=>{if(settled)return;settled=true;clearTimeout(timer);context.signal?.removeEventListener('abort',cancel);error?reject(error):accept(value!);};
      const cancel=()=>{child.kill();finish(new AgentManagementError('cancelled','The login startup wait was cancelled. Inspect its retained intent marker before retrying.'));};
      const timer=setTimeout(()=>{child.kill();finish(new AgentManagementError('native_timeout','The native service command timed out. Inspect its retained intent marker before retrying.'));},65000);
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>LIMIT){child.kill();finish(new AgentManagementError('response_too_large','The native service receipt exceeds its size limit.'));}else output+=chunk.toString();});
      child.stderr.on('data',()=>{});
      child.once('error',()=>finish(new AgentManagementError('native_failed','The project-local native service command could not start.')));
      child.once('close',code=>{if(code!==0){finish(new AgentManagementError('native_failed','The owned native service action failed. Inspect the project service artifacts and native status.'));return;}try{const parsed=JSON.parse(output);if(!object(parsed))throw new Error();finish(undefined,parsed);}catch{finish(new AgentManagementError('native_invalid','The native service action returned an invalid receipt.'));}});
      context.signal?.addEventListener('abort',cancel,{once:true});if(context.signal?.aborted)cancel();
    });
  }
  if(!object(result.plan)||result.plan.ownerId!==expected||result.action!==action||result.executed!==execute)fail('native_invalid','The native service receipt does not match the reviewed project ownership.');
  // Deployment config can include prompts. Return only native ownership, plans and command results.
  return {action,executed:execute,plan:result.plan,...(Array.isArray(result.output)?{output:result.output}:{})};
}
async function waitForManagedOwner(connection:ServiceConnection,options:ManagementOptions):Promise<ManagedInspection>{
  const deadline=Date.now()+(options.timeoutMs??45000);
  while(Date.now()<deadline){abort(options.signal);const current=await inspectManaged(connection,{...options,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});if(current.state==='running'||current.state==='paused')return current;await delay(Math.max(1,Math.min(250,deadline-Date.now())),undefined,{signal:options.signal});}
  fail('native_start_unconfirmed','Login startup was requested, but its authenticated managed owner is not ready. Inspect the retained native marker and logs.');
}

/** Plan by default; installing and uninstalling operate only on this project's owned per-user job. */
export async function manageLoginStartup(connection:ServiceConnection,action:LoginStartupAction,options:LoginStartupOptions={}):Promise<Record<string,unknown>>{
  validateOptions(options);if(!['plan','install','status','uninstall'].includes(action))fail('input_invalid','Choose plan, install, status or uninstall for login startup.');
  const project=await resolveManagedProject(connection);
  return operation(project,async()=>{
    const saved=await readNativeMarker(project),selected=saved?.options??await nativeOptions(project);
    if(action==='plan')return {loginStartup:true,registered:saved?.phase==='installed',...(await runNativeCommand(project,'install',selected,false,options))};
    if(action==='status')return saved?{loginStartup:true,registered:true,phase:saved.phase,...(await runNativeCommand(project,'status',selected,true,options))}:{loginStartup:true,registered:false,phase:'not-managed-by-console',...(await runNativeCommand(project,'install',selected,false,options))};
    const markerPath=join(project.projectDir,'native-service.json');
    if(action==='install'){
      const current=await inspectManaged(connection,options);if(current.state!=='stopped')fail('not_stopped','Drain and stop this agent before installing login startup.');
      const planned=await runNativeCommand(project,'install',selected,false,options);abort(options.signal);
      const marker:NativeMarker={version:1,phase:'installing',ownerId:nativeOwner(selected),options:selected};await atomicJson(markerPath,marker);
      const result=await runNativeCommand(project,'install',selected,true,options);
      await atomicJson(markerPath,{...marker,phase:'installed'});const owner=await waitForManagedOwner(connection,options);
      return {loginStartup:true,registered:true,phase:'installed',owner,...result,reviewedOwnerId:(planned.plan as Record<string,unknown>).ownerId};
    }
    if(!saved)return {loginStartup:true,registered:false,phase:'not-managed-by-console',filesPreserved:true};
    const current=await inspectManaged(connection,options);
    if(current.state==='running'||current.state==='paused')await stopUnlocked(connection,project,{...options,drainTimeoutMs:30000});
    else if(current.state!=='stopped')fail('owner_unverified','Verify and drain the managed owner before removing its native registration.');
    const marker:NativeMarker={...saved,phase:'uninstalling'};await atomicJson(markerPath,marker);
    const result=await runNativeCommand(project,'uninstall',selected,true,options);await rm(markerPath,{force:true});
    return {loginStartup:true,registered:false,phase:'uninstalled',filesPreserved:true,...result};
  });
}
