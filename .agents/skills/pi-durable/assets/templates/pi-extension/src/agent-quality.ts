// Pi loads TypeScript directly. Project-local verification and explicitly requested evolution.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServiceConnection } from './client.js';
import { inspectManaged, resolveManagedProject, withManagedOperation, type ManagedProject } from './agent-management.js';
import { safeText } from './display.js';

export interface QualityOptions {signal?:AbortSignal;timeoutMs?:number}
export interface VerifyAgentOptions extends QualityOptions {jobId?:string;submissionId?:number}
export interface QualityReceipt {version:1;id:string;at:string;agentId:string;status:'passed'|'failed'|'inconclusive'|'unconfigured';reason:string;jobId?:string;conversationId?:number;submissionId?:number;contractSha256?:string;outputSha256?:string;evidenceIds:string[];checks:Array<{id:string;kind:string;passed:boolean;reason:string}>;evidenceId?:string;sourceVersion?:unknown}
export interface QualityInspection {configured:boolean;contract:Record<string,unknown>;receipts:QualityReceipt[];contractSha256?:string}
export interface EvolutionCommand {action:'history'|'request'|'reflect'|'propose'|'evaluate'|'promote'|'rollback'|'recover';requestId?:string;proposalId?:string;input?:Record<string,unknown>;generate?:boolean}
export class AgentQualityError extends Error {constructor(readonly code:string,message:string){super(message);this.name='AgentQualityError';}}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const equalPath=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
const LIMIT=2*1024*1024;
function fail(code:string,message:string):never{throw new AgentQualityError(code,message);}
function abort(signal?:AbortSignal){if(signal?.aborted)fail('cancelled','The local quality operation was cancelled. Inspect its saved receipts before repeating a mutation.');}
async function bounded(path:string,limit=LIMIT){const file=await open(path,'r');try{if(!(await file.stat()).isFile())fail('input_invalid','Quality operations require ordinary local files.');const buffer=Buffer.alloc(limit+1);let size=0;while(size<buffer.length){const chunk=await file.read(buffer,size,buffer.length-size,null);if(!chunk.bytesRead)break;size+=chunk.bytesRead;}if(size>limit)fail('input_invalid','A quality operation file exceeds its bounded size limit.');return buffer.subarray(0,size);}finally{await file.close();}}
async function local(project:ManagedProject,path:string){const target=resolve(project.projectDir,path),part=relative(project.projectDir,target);if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep)||(await lstat(target)).isSymbolicLink()||!equalPath(await realpath(target),target))fail('input_invalid','Quality execution requires a regular project-local script.');return target;}
async function run(project:ManagedProject,script:string,args:string[],options:QualityOptions={},json=true):Promise<any>{
  abort(options.signal);const path=await local(project,script),timeoutMs=options.timeoutMs??(script.includes('evolve-cli')?15*60_000:120_000);
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30*60_000)fail('input_invalid','Choose a quality-operation timeout from 100 milliseconds to 30 minutes.');
  const directory=join(project.dataDir,'quality','console-logs');await mkdir(directory,{recursive:true});const key=`${Date.now()}-${randomUUID()}`;
  let stdout='',stderr='',overflow=false,timedOut=false;
  const outcome=await new Promise<{code:number|null;cancelled:boolean}>((accept,reject)=>{
    const child=spawn(process.execPath,[path,...args],{cwd:project.projectDir,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,FORCE_COLOR:'0'}});let cancelled=false,done=false;
    const cancel=()=>{cancelled=true;child.kill();};const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    options.signal?.addEventListener('abort',cancel,{once:true});
    const finish=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);};
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    child.stdout?.on('data',(text:string)=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(text)>LIMIT){overflow=true;child.kill();}else stdout+=text;});
    child.stderr?.on('data',(text:string)=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(text)>LIMIT){overflow=true;child.kill();}else stderr+=text;});
    child.once('error',()=>{if(done)return;done=true;finish();reject(new AgentQualityError('execution_failed','The local project operation could not be started.'));});
    child.once('close',code=>{if(done)return;done=true;finish();accept({code,cancelled});});if(options.signal?.aborted)cancel();
  });
  await writeFile(join(directory,key+'.stdout.log'),stdout,{flag:'wx',mode:0o600});await writeFile(join(directory,key+'.stderr.log'),stderr,{flag:'wx',mode:0o600});
  if(outcome.cancelled||timedOut||overflow||outcome.code!==0){const detail=outcome.cancelled?'cancelled':timedOut?'timed out':overflow?'exceeded its output budget':'failed';fail('execution_failed',`The project operation ${detail}. Inspect ${join(directory,key)}.*.log before repeating it.${stderr?` ${safeText(stderr.trim(),2000)}`:''}`);}
  if(!json)return {passed:true,logPrefix:join(directory,key)};
  try{return JSON.parse(stdout);}catch{fail('invalid_response',`The project operation returned invalid JSON. Inspect ${join(directory,key)}.stdout.log.`);}
}
async function inputFile(project:ManagedProject,value:unknown){const encoded=JSON.stringify(value);if(!encoded||Buffer.byteLength(encoded)>512*1024)fail('input_invalid','Provide bounded JSON input of at most 512 KiB.');const directory=join(project.dataDir,'evolution','console-inputs');await mkdir(directory,{recursive:true});const path=join(directory,randomUUID()+'.json');await writeFile(path,encoded+'\n',{flag:'wx',mode:0o600});return path;}
function validId(value:unknown){return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value);}
async function stopped(connection:ServiceConnection,options:QualityOptions){const status=await inspectManaged(connection,{signal:options.signal});if(!status.managed||status.state!=='stopped')fail('service_running','Drain and stop the managed service before freezing models, activating source or rebuilding.');}

export async function inspectQuality(connection:ServiceConnection,options:QualityOptions={}):Promise<QualityInspection>{
  const project=await resolveManagedProject(connection);
  const result=await run(project,'dist/src/verify-cli.js',['inspect','--config',project.configPath,'--agent',project.agentId],options);
  if(!object(result)||typeof result.configured!=='boolean'||!object(result.contract)||!Array.isArray(result.receipts))fail('invalid_response','The project returned an invalid duty-contract status.');
  return result as unknown as QualityInspection;
}
export async function configureVerification(connection:ServiceConnection,contract:unknown,options:QualityOptions={}){
  const project=await resolveManagedProject(connection);abort(options.signal);
  if(!object(contract)||contract.agentId!==undefined&&contract.agentId!==project.agentId)fail('input_invalid','The duty contract must target the selected managed agent.');
  return withManagedOperation(project,async()=>{const path=await inputFile(project,contract);
    const result=await run(project,'dist/src/verify-cli.js',['configure','--config',project.configPath,'--input',path],options);
    if(!object(result)||typeof result.configured!=='boolean'||typeof result.contractSha256!=='string'||!/^[a-f0-9]{64}$/.test(result.contractSha256))fail('invalid_response','The project did not attest its configured duty contract.');
    return result;
  },options);
}
export async function verifyAgent(connection:ServiceConnection,options:VerifyAgentOptions={}):Promise<QualityReceipt>{
  const project=await resolveManagedProject(connection),args=['verify','--config',project.configPath,'--agent',project.agentId];
  if(options.jobId!==undefined){if(typeof options.jobId!=='string'||!options.jobId||options.jobId.length>4096)fail('input_invalid','Choose a bounded task ID.');args.push('--job',options.jobId);}
  if(options.submissionId!==undefined){if(!Number.isSafeInteger(options.submissionId)||options.submissionId<1)fail('input_invalid','Choose a positive submission ID.');args.push('--submission',String(options.submissionId));}
  const result=await run(project,'dist/src/verify-cli.js',args,options);
  if(!object(result)||result.agentId!==project.agentId||typeof result.id!=='string'||typeof result.at!=='string'||typeof result.reason!=='string'||!Array.isArray(result.evidenceIds)||!['passed','failed','inconclusive','unconfigured'].includes(String(result.status))||!Array.isArray(result.checks)||options.jobId!==undefined&&result.jobId!==options.jobId||options.submissionId!==undefined&&result.submissionId!==undefined&&result.submissionId!==options.submissionId)fail('invalid_response','The project returned a verification for a different target or an invalid status.');
  if(result.status==='passed'&&(!Number.isSafeInteger(result.submissionId)||!Number.isSafeInteger(result.conversationId)||typeof result.outputSha256!=='string'||!/^[a-f0-9]{64}$/.test(result.outputSha256)||typeof result.contractSha256!=='string'||!/^[a-f0-9]{64}$/.test(result.contractSha256)||!result.checks.length||!result.checks.every(item=>object(item)&&item.passed===true)))fail('invalid_response','A verification pass requires attributable task identities, content hashes and passing assertions.');
  return result as unknown as QualityReceipt;
}
export async function runEvolution(connection:ServiceConnection,command:EvolutionCommand,options:QualityOptions={}){
  const project=await resolveManagedProject(connection);abort(options.signal);
  if(!['history','request','reflect','propose','evaluate','promote','rollback','recover'].includes(command.action)||command.generate!==undefined&&typeof command.generate!=='boolean'||command.generate&&command.action!=='reflect')fail('input_invalid','Choose an explicit supported evolution action.');
  if(command.action==='request'&&(!object(command.input)||command.input.agentId!==project.agentId))fail('input_invalid','The improvement request must explicitly target this agent.');
  const args=[command.action,'--config',project.configPath,'--agent',project.agentId];
  if(['reflect','propose'].includes(command.action)){if(!validId(command.requestId))fail('input_invalid','Select an exact request ID.');args.push('--request',command.requestId!);}
  if(['evaluate','promote','rollback'].includes(command.action)){if(!validId(command.proposalId))fail('input_invalid','Select an exact proposal ID.');args.push('--proposal',command.proposalId!);}
  if(['request','propose'].includes(command.action)){if(!object(command.input))fail('input_invalid','Provide the complete bounded request or proposal JSON.');if(command.action==='propose'&&command.input.requestId!==command.requestId)fail('input_invalid','The proposal must cite the selected request ID.');args.push('--input',await inputFile(project,command.input));}
  if(command.generate)args.push('--generate');
  if(['promote','rollback','recover'].includes(command.action))return withManagedOperation(project,async()=>{await stopped(connection,options);return run(project,'dist/src/evolve-cli.js',args,options);},options);
  return run(project,'dist/src/evolve-cli.js',args,options);
}
function dynamic(raw:Record<string,unknown>){const provider=object(raw.provider)?raw.provider:{};const agents=Array.isArray(raw.agents)?raw.agents:[];const names=[provider.model,...(object(provider.reflection)?[provider.reflection.model]:[]),...agents.flatMap(agent=>object(agent)?[...(object(agent.modelChoice)?[agent.modelChoice.model]:[]),...(object(agent.subagents)&&Array.isArray(agent.subagents.roles)?agent.subagents.roles.flatMap(role=>object(role)&&object(role.modelChoice)?[role.modelChoice.model]:[]):[])]:[])];return names.some(name=>typeof name==='string'&&(name==='latest'||name.startsWith('latest:')));}

/** Explicitly freeze current exact models before a reproducible study; never starts the host. */
export async function freezeModelsForEvolution(connection:ServiceConnection,options:QualityOptions={}){
  const project=await resolveManagedProject(connection);
  return withManagedOperation(project,async()=>{
    await stopped(connection,options);const before=await bounded(project.configPath),raw=JSON.parse(before.toString('utf8')) as Record<string,unknown>;
    if(!object(raw.provider))fail('input_invalid','The model policy is unavailable.');
    if(raw.provider.kind==='faux'||!dynamic(raw)&&(typeof raw.provider.catalogFile==='string'||raw.provider.catalogMode==='bundled'))return {alreadyFrozen:true,configPath:project.configPath,configSha256:hash(before),sourceActivated:false,inferencePerformed:false};
    const name=`config.freeze.${randomUUID()}.json`,output=join(project.projectDir,name);
    const result=await run(project,'dist/src/models-cli.js',['lock','--config',project.configPath,'--output',output],options);
    const frozen=await bounded(output),value=JSON.parse(frozen.toString('utf8')) as Record<string,unknown>;
    if(!object(value.provider)||dynamic(value)||typeof value.provider.catalogFile!=='string'||dirname(value.provider.catalogFile)!=='.'||withoutModelPolicy(value)!==withoutModelPolicy(raw))fail('invalid_response','The frozen model configuration changed project, task permissions or agent identity.');
    JSON.parse((await bounded(await local(project,value.provider.catalogFile))).toString('utf8'));
    await stopped(connection,options);if(!(await bounded(project.configPath)).equals(before))fail('config_changed','The configuration changed during model freezing. The inactive snapshot is retained for review.');
    const directory=join(project.dataDir,'evolution','model-locks');await mkdir(directory,{recursive:true});const key=randomUUID(),backup=join(directory,key+'.original.json');await writeFile(backup,before,{flag:'wx',mode:0o600});
    await rename(output,project.configPath);
    const receipt={alreadyFrozen:false,configPath:project.configPath,configSha256:hash(frozen),originalConfigSha256:hash(before),backup,catalog:join(project.projectDir,value.provider.catalogFile),selections:result.selections,reflection:result.reflection,inferencePerformed:false,sourceActivated:false};
    await writeFile(join(directory,key+'.receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
  },options);
}
function withoutModelPolicy(value:Record<string,unknown>){
  const clean=JSON.parse(JSON.stringify(value)) as Record<string,unknown>;
  if(object(clean.provider))for(const key of ['model','thinkingLevel','catalogFile','reflection'])delete clean.provider[key];
  if(Array.isArray(clean.agents))for(const agent of clean.agents)if(object(agent)){delete agent.modelChoice;if(object(agent.subagents)&&Array.isArray(agent.subagents.roles))for(const role of agent.subagents.roles)if(object(role))delete role.modelChoice;}
  const stable=(item:unknown):string=>Array.isArray(item)?`[${item.map(stable).join(',')}]`:object(item)?`{${Object.keys(item).sort().map(key=>`${JSON.stringify(key)}:${stable(item[key])}`).join(',')}}`:JSON.stringify(item);
  return stable(clean);
}

/** Rebuild and smoke the exact stopped source after a passing promotion or rollback. */
export async function rebuildAgent(connection:ServiceConnection,options:QualityOptions={}){
  const project=await resolveManagedProject(connection);
  return withManagedOperation(project,async()=>{await stopped(connection,options);const compiler=await run(project,'node_modules/typescript/bin/tsc',['-p','tsconfig.json'],options,false);const smoke=await run(project,'dist/src/smoke.js',[],options);if(!object(smoke)||smoke.passed!==true)fail('smoke_failed','The rebuilt source did not pass its independent faux smoke.');return {passed:true,compiler,smoke,serviceStarted:false};},options);
}
