// Build with npm run build. Verify observable task outcomes without model grading or shell execution.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, type ServiceConfig } from './config.js';
import { EvidenceStore, type EvidenceRecord } from './evidence.js';
import { WorkspaceReader } from './tools/workspace.js';

type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type DutyAssertion =
  | {id:string;kind:'output-contains'|'output-not-contains'|'output-equals';value:string}
  | {id:string;kind:'output-json-equals';path:string[];value:Json}
  | {id:string;kind:'workspace-file-equals';path:string;value:string};
export interface VerificationContract {version:1;enabled:boolean;agentId?:string;goal:string;assertions:DutyAssertion[]}
export interface VerificationInput {agentId:string;jobId?:string;submissionId?:number}
export interface DutyCheck {id:string;kind:DutyAssertion['kind'];passed:boolean;reason:string;observedSha256?:string}
export interface VerificationReceipt {
  version:1;id:string;at:string;agentId:string;jobId?:string;conversationId?:number;submissionId?:number;
  status:'passed'|'failed'|'inconclusive'|'unconfigured';reason:string;contractSha256?:string;
  outputSha256?:string;sourceVersion?:unknown;evidenceIds:string[];checks:DutyCheck[];evidenceId?:string;
}
export interface VerificationOptions {fetch?:typeof fetch;signal?:AbortSignal}
const LIMIT=256*1024;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const inside=(root:string,target:string)=>{const path=relative(root,target);return path===''||!isAbsolute(path)&&path!=='..'&&!path.startsWith('../')&&!path.startsWith('..\\');};
const id=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(value);
function only(value:Record<string,unknown>,keys:string[]){return Object.keys(value).every(key=>keys.includes(key));}
function text(value:unknown,max=12000){return typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');}
function local(value:unknown){return typeof value==='string'&&value.length>0&&value.length<=4096&&!isAbsolute(value)&&!/[\\:\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..');}
function jsonValue(value:unknown,depth=0):value is Json {
  if(depth>8)return false;
  if(value===null||typeof value==='boolean'||typeof value==='string')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.length<=100&&value.every(item=>jsonValue(item,depth+1));
  return record(value)&&Object.keys(value).length<=100&&Object.entries(value).every(([key,item])=>!['__proto__','prototype','constructor'].includes(key)&&jsonValue(item,depth+1));
}
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(record(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;return JSON.stringify(value);}
export function validateVerificationContract(value:unknown):VerificationContract {
  if(!record(value)||!only(value,['version','enabled','agentId','goal','assertions'])||value.version!==1||typeof value.enabled!=='boolean'||!text(value.goal)||!Array.isArray(value.assertions)||value.assertions.length>32||value.enabled&&(!id(value.agentId)||value.assertions.length===0)||value.agentId!==undefined&&!id(value.agentId))throw new Error('Use a version 1 duty contract with a goal, enabled flag, agent ID and concrete assertions.');
  const ids=new Set<string>();
  for(const item of value.assertions){
    if(!record(item)||!id(item.id)||ids.has(String(item.id))||typeof item.kind!=='string')throw new Error('Duty assertions require unique bounded IDs and supported kinds.');
    ids.add(item.id as string);
    if(['output-contains','output-not-contains','output-equals'].includes(item.kind)){
      if(!only(item,['id','kind','value'])||!text(item.value))throw new Error('Literal output assertions require a nonempty bounded value.');
    }else if(item.kind==='output-json-equals'){
      if(!only(item,['id','kind','path','value'])||!Array.isArray(item.path)||item.path.length>16||!item.path.every(key=>typeof key==='string'&&key.length>0&&key.length<=100&&!['__proto__','prototype','constructor'].includes(key))||!('value' in item)||!jsonValue(item.value)||Buffer.byteLength(JSON.stringify(item.value))>16000)throw new Error('JSON assertions require bounded own-property paths and a JSON value.');
    }else if(item.kind==='workspace-file-equals'){
      if(!only(item,['id','kind','path','value'])||!local(item.path)||typeof item.value!=='string'||Buffer.byteLength(item.value)>128*1024)throw new Error('Workspace assertions require a relative path and bounded exact text.');
    }else throw new Error('Unsupported duty assertion kind.');
  }
  if(Buffer.byteLength(JSON.stringify(value))>LIMIT)throw new Error('The duty contract exceeds the size limit.');
  return value as unknown as VerificationContract;
}
async function bounded(path:string,limit=LIMIT):Promise<Buffer>{const handle=await open(path,'r');try{const bytes=Buffer.alloc(limit+1);let length=0;while(length<bytes.length){const chunk=await handle.read(bytes,length,bytes.length-length,null);if(!chunk.bytesRead)break;length+=chunk.bytesRead;}if(length>limit)throw new Error('A verification file exceeds its size limit.');return bytes.subarray(0,length);}finally{await handle.close();}}
async function contractFile(projectDir:string){const root=await realpath(projectDir),path=join(root,'verification-contract.json');try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||!inside(root,await realpath(path)))throw new Error('The duty contract must be a regular project-local file.');return {path,bytes:await bounded(path)};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {path};throw error;}}
async function settings(configPath:string){const config=await loadConfig(configPath);return {config,projectDir:await realpath(dirname(resolve(configPath)))};}
export async function inspectVerification(configPath:string,agentId:string){
  const {config,projectDir}=await settings(configPath);if(!config.agents.some(agent=>agent.id===agentId))throw new Error('Unknown verification agent.');
  const file=await contractFile(projectDir);const contract=file.bytes?validateVerificationContract(JSON.parse(file.bytes.toString('utf8'))):undefined;
  const directory=join(config.dataDir,'quality',agentId);let names:string[]=[];
  try{names=(await readdir(directory)).filter(name=>/^\d{13}-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse().slice(0,20);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const receipts=await Promise.all(names.map(async name=>JSON.parse((await bounded(join(directory,name))).toString('utf8')) as VerificationReceipt));
  return {configured:!!contract?.enabled&&contract.agentId===agentId,contract:contract??{version:1,enabled:false,goal:'Define the observable duty before verification.',assertions:[]},...(file.bytes?{contractSha256:hash(file.bytes)}:{}),receipts};
}
export async function configureVerification(configPath:string,value:unknown){
  const {config,projectDir}=await settings(configPath),contract=validateVerificationContract(value);
  if(contract.agentId!==undefined&&!config.agents.some(agent=>agent.id===contract.agentId))throw new Error('Duty contract targets an unknown agent.');
  const file=await contractFile(projectDir),temporary=file.path+'.'+randomUUID()+'.tmp';const bytes=JSON.stringify(contract,null,2)+'\n';
  await writeFile(temporary,bytes,{flag:'wx',mode:0o600});try{await rename(temporary,file.path);}finally{await rm(temporary,{force:true});}
  const evidence=await EvidenceStore.open(config.dataDir);
  try{const event=evidence.append({agentId:contract.agentId??config.agents[0].id,kind:'verification.configured',details:{enabled:contract.enabled,contractSha256:hash(bytes),assertionCount:contract.assertions.length,publicSummary:'A local operator configured the observable duty contract.'}});return {configured:contract.enabled,contractSha256:hash(bytes),evidenceId:event.id};}finally{evidence.close();}
}
async function api(config:ServiceConfig,path:string,options:VerificationOptions):Promise<unknown>{
  const token=(await bounded(join(config.dataDir,'console-token'),256)).toString('utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('The service console credential is unavailable.');
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
  const response=await(options.fetch??fetch)(`http://127.0.0.1:${config.port}${path}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal});
  if(!response.ok){await response.body?.cancel();throw new Error('The selected durable task is unavailable.');}
  if(Number(response.headers.get('content-length')??0)>LIMIT){await response.body?.cancel();throw new Error('The task response exceeds the verification size limit.');}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let length=0;
  if(reader){try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>LIMIT)throw new Error('The task response exceeds the verification size limit.');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});}}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function evaluateDutyAssertions(contract:VerificationContract,output:string,workspaceRoot?:string):Promise<DutyCheck[]>{
  const result:DutyCheck[]=[];let workspace:WorkspaceReader|undefined;
  for(const item of contract.assertions){let passed=false,reason='The expected condition was not met.',observedSha256:string|undefined;
    try{
      if(item.kind==='output-contains')passed=output.includes(item.value);
      else if(item.kind==='output-not-contains')passed=!output.includes(item.value);
      else if(item.kind==='output-equals')passed=output===item.value;
      else if(item.kind==='output-json-equals'){
        let current:unknown=JSON.parse(output);
        for(const key of item.path){if(!current||typeof current!=='object'||!Object.prototype.hasOwnProperty.call(current,key))throw new Error();current=(current as Record<string,unknown>)[key];}
        passed=canonical(current)===canonical(item.value);
      }else if(item.kind==='workspace-file-equals'){
        if(!workspaceRoot)throw new Error();workspace??=await WorkspaceReader.open(workspaceRoot);const file=await workspace.read(item.path);observedSha256=hash(file.text);passed=file.text===item.value;
      }
      reason=passed?'The configured observable assertion passed.':reason;
    }catch{reason='The configured assertion could not be satisfied with bounded observable data.';}
    result.push({id:item.id,kind:item.kind,passed,reason,...(observedSha256?{observedSha256}:{})});
  }
  return result;
}
export async function verifyDuty(configPath:string,input:VerificationInput,options:VerificationOptions={}):Promise<VerificationReceipt>{
  const {config,projectDir}=await settings(configPath),agent=config.agents.find(item=>item.id===input.agentId);
  if(!agent||input.jobId!==undefined&&(typeof input.jobId!=='string'||!input.jobId||input.jobId.length>4096)||input.submissionId!==undefined&&(!Number.isSafeInteger(input.submissionId)||input.submissionId<1))throw new Error('Select a configured agent and valid task or submission identity.');
  const receipt:VerificationReceipt={version:1,id:randomUUID(),at:new Date().toISOString(),agentId:agent.id,...(input.jobId?{jobId:input.jobId}:{}),status:'inconclusive',reason:'No completed task was verified.',evidenceIds:[],checks:[]};
  const store=await EvidenceStore.open(config.dataDir);
  try{
    const file=await contractFile(projectDir),contract=file.bytes?validateVerificationContract(JSON.parse(file.bytes.toString('utf8'))):undefined;
    if(!contract?.enabled||contract.agentId!==agent.id){receipt.status='unconfigured';receipt.reason='Configure a concrete duty contract for this agent before claiming verified work.';}
    else{
      receipt.contractSha256=hash(file.bytes!);
      try{
        const suffix=input.jobId?`?jobId=${encodeURIComponent(input.jobId)}`:'';
        const snapshot=await api(config,`/v1/agents/${agent.id}/chat${suffix}`,options);
        if(!record(snapshot)||!record(snapshot.conversation)||!Number.isSafeInteger(snapshot.conversation.id))throw new Error('The service returned an invalid task conversation.');
        receipt.conversationId=Number(snapshot.conversation.id);
        const records=store.list(agent.id,1000);
        let submissionId=input.submissionId;
        if(input.jobId){const jobs=await api(config,`/v1/agents/${agent.id}/jobs`,options);if(!record(jobs)||!Array.isArray(jobs.jobs))throw new Error('Task metadata is unavailable.');const job=jobs.jobs.find(item=>record(item)&&item.id===input.jobId) as Record<string,unknown>|undefined;if(!job||job.status!=='done'||job.conversationId!==receipt.conversationId)throw new Error('The selected event job has not completed.');submissionId??=Number(job.submissionId);}
        const admissions=records.filter(item=>item.conversationId===receipt.conversationId&&['human.submitted','job.admitted'].includes(item.kind)&&(!input.jobId||item.jobId===input.jobId));
        submissionId??=admissions[0]?.submissionId;
        if(!Number.isSafeInteger(submissionId)||!submissionId)throw new Error('No attributable submission is available for verification.');
        const admission=admissions.find(item=>item.submissionId===submissionId);
        if(!admission||!record(admission.version)||!record(admission.version.conversationVersion)||typeof admission.version.conversationVersion.digest!=='string'||!/^[a-f0-9]{64}$/.test(admission.version.conversationVersion.digest))throw new Error('The submission is outside the bounded attributable/version evidence window.');
        receipt.submissionId=submissionId;receipt.evidenceIds=[admission.id];receipt.sourceVersion=admission.version;
        const submission=await api(config,`/v1/agents/${agent.id}/submissions/${submissionId}${suffix}`,options);
        if(!record(submission)||submission.status!=='done'||submission.conversationId!==receipt.conversationId||typeof submission.text!=='string')throw new Error('The selected submission has not completed in this conversation.');
        receipt.outputSha256=hash(submission.text);
        receipt.checks=await evaluateDutyAssertions(contract,submission.text,agent.workspaceRoot);
        if((await bounded(file.path)).compare(file.bytes!)!==0)throw new Error('The duty contract changed during verification.');
        receipt.status=receipt.checks.every(item=>item.passed)?'passed':'failed';receipt.reason=receipt.status==='passed'?'The selected completed task satisfies the configured assertions.':'The selected completed task failed one or more configured assertions.';
      }catch{receipt.status='inconclusive';receipt.reason='The selected task is unavailable, incomplete, changed or lacks attributable evidence; no quality pass is claimed.';}
    }
    const event=store.append({agentId:agent.id,kind:'verification.completed',...(receipt.jobId?{jobId:receipt.jobId}:{}),...(receipt.conversationId?{conversationId:receipt.conversationId}:{}),...(receipt.submissionId?{submissionId:receipt.submissionId}:{}),details:{status:receipt.status,contractSha256:receipt.contractSha256,outputSha256:receipt.outputSha256,checks:receipt.checks,evidenceIds:receipt.evidenceIds,publicSummary:receipt.reason},version:receipt.sourceVersion});receipt.evidenceId=event.id;
    const directory=join(config.dataDir,'quality',agent.id);await mkdir(directory,{recursive:true});await writeFile(join(directory,`${Date.now()}-${receipt.id}.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
  }finally{store.close();}
}
