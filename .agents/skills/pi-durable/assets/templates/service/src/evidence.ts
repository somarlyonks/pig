// Build with npm run build. Keep public operational evidence, never provider thinking.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { AgentConfig, ServiceConfig } from './config.js';
import type { ModelChoice } from './model-selection.js';

type ChoicePolicy={model?:string;task?:string;effort?:string};
export type ModelResolutionEvidence={
  catalog:{source:string;digest:string;availability:string};
  selected:{model:{provider:string;modelId:string};effort:string;requestedEffort?:string;effectiveEffort?:string;reason:string};
  roles?:Array<{role:string;model:{provider:string;modelId:string};effort:string;reason:string}>;
};
function choicePolicy(choice:ModelChoice|undefined):ChoicePolicy|undefined{
  return choice?{...(choice.model?{model:choice.model}:{}),...(choice.task?{task:choice.task}:{}),...(choice.thinkingLevel?{effort:choice.thinkingLevel}:{})}:undefined;
}

export interface EvidenceRecord {
  id:string; at:string; agentId:string; kind:string; runId?:string; jobId?:string;
  conversationId?:number; submissionId?:number; details:Record<string,unknown>; version?:unknown;
  [key:string]:unknown;
}
export type VersionManifest = {
  version:1; digest:string; files:Array<{path:string;sha256:string;bytes:number}>;
  policy:{agentId:string;repositories:string[];workspaceRoot?:string;instructionsSha256:string;provider:{kind:string;model?:string;effort?:string;reflection?:ChoicePolicy};modelChoice?:ChoicePolicy;modelSelection?:ModelResolutionEvidence;subagents?:{roles:Array<{id:string;instructionsSha256:string;modelChoice?:ChoicePolicy}>;maxChildrenPerCall:number;maxChildrenPerRun:number;maxTaskChars:number;maxResultChars:number}};
};
const blockedKey=/(?:password|passwd|secret|token|api.?key|authorization|cookie|private.?key|environment|thinking|reasoning|chain.?of.?thought)/i;
export function redactEvidenceText(text:string):string {
  let value=text.replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]{8,})\b/g,'[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[=:]\s*)([^\s,;"'<>]+)/gi,'$1[REDACTED]');
  for(const [key,secret] of Object.entries(process.env))if(secret && secret.length>=8 && /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key))value=value.split(secret).join('[REDACTED]');
  return value;
}
/** Bound and redact evidence at the final storage boundary, including nested fields. */
export function sanitizeEvidence(value:Record<string,unknown>):Record<string,unknown>;
export function sanitizeEvidence(value:unknown):unknown;
export function sanitizeEvidence(value:unknown):unknown {
  let budget=12000;let nodes=0;const seen=new WeakSet<object>();
  function visit(item:unknown,depth:number):unknown {
    if(budget<=0||nodes++>=512)return '[TRUNCATED]';budget-=16;if(budget<=0)return '[TRUNCATED]';
    if(item===null || typeof item==='boolean')return item;
    if(typeof item==='number')return Number.isFinite(item)?item:String(item);
    if(typeof item==='string'){const clean=redactEvidenceText(item);const result=clean.slice(0,Math.min(2000,budget));budget-=result.length;return result+(result.length<clean.length?' [TRUNCATED]':'');}
    if(typeof item!=='object')return String(item).slice(0,100);
    if(seen.has(item))return '[CIRCULAR]';if(depth>=6)return '[DEPTH LIMIT]';seen.add(item);
    if(Array.isArray(item)){const result:unknown[]=[];for(const child of item.slice(0,32)){if(budget<=0||nodes>=512){result.push('[TRUNCATED]');break;}result.push(visit(child,depth+1));}return result;}
    const result:Record<string,unknown>=Object.create(null);
    for(const [rawKey,child] of Object.entries(item).slice(0,64)){
      if(budget<=0||nodes>=512){result.truncated='[TRUNCATED]';break;}
      const key=redactEvidenceText(rawKey).slice(0,100);budget-=key.length;
      if(blockedKey.test(key))result[key]='[REDACTED]';else result[key]=visit(child,depth+1);
    }
    return result;
  }
  return visit(value,0);
}
export function fingerprint(value:unknown):{sha256:string;bytes:number} {
  const encoded=typeof value==='string'?value:JSON.stringify(value)??String(value);
  return {sha256:createHash('sha256').update(encoded).digest('hex'),bytes:Buffer.byteLength(encoded)};
}
export function versionReference(version:VersionManifest){return {digest:version.digest,instructionsSha256:version.policy.instructionsSha256,provider:version.policy.provider,...(version.policy.modelSelection?{modelSelection:version.policy.modelSelection}:{})};}
export class EvidenceStore {
  private constructor(private db:DatabaseSync,readonly directory:string){}
  static async open(dataDir:string):Promise<EvidenceStore> {
    await mkdir(dataDir,{recursive:true});const db=new DatabaseSync(join(dataDir,'evidence.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,at TEXT NOT NULL,agentId TEXT NOT NULL,kind TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_agent ON evidence(agentId,at);
      CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'Evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'Evidence is append-only'); END;`);
    return new EvidenceStore(db,resolve(dataDir));
  }
  append(input:{agentId:string;kind:string;runId?:string;jobId?:string;conversationId?:number;submissionId?:number;details:Record<string,unknown>;version?:unknown}):EvidenceRecord {
    if(!/^[a-z][a-z0-9-]{0,47}$/.test(input.agentId)||!/^[a-z][a-z0-9_.-]{0,99}$/.test(input.kind))throw new Error('Evidence requires an agent identity and a bounded event kind.');
    const {details,version,...metadata}=input;const clean=sanitizeEvidence(metadata) as typeof metadata;
    const record:EvidenceRecord={...clean,id:randomUUID(),at:new Date().toISOString(),agentId:input.agentId,kind:input.kind,details:sanitizeEvidence(details),...(version===undefined?{}:{version:sanitizeEvidence(version)})};
    this.db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?)').run(record.id,record.at,record.agentId,record.kind,JSON.stringify(record));return record;
  }
  list(agentId:string,limit=100):EvidenceRecord[] {
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('Evidence limit must be from 1 to 10000.');
    return this.db.prepare('SELECT record FROM evidence WHERE agentId=? ORDER BY rowid DESC LIMIT ?').all(agentId,limit).map(row=>JSON.parse(String(row.record)) as EvidenceRecord);
  }
  has(agentId:string,id:string):boolean {return Boolean(this.db.prepare('SELECT 1 FROM evidence WHERE agentId=? AND id=?').get(agentId,id));}
  get(agentId:string,id:string):EvidenceRecord|undefined {const row=this.db.prepare('SELECT record FROM evidence WHERE agentId=? AND id=?').get(agentId,id);return row?JSON.parse(String(row.record)) as EvidenceRecord:undefined;}
  listConversation(agentId:string,conversationId:number,limit=20):EvidenceRecord[] {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Conversation evidence limit must be from 1 to 100.');
    return this.db.prepare("SELECT record FROM evidence WHERE agentId=? AND json_extract(record,'$.conversationId')=? ORDER BY rowid DESC LIMIT ?").all(agentId,conversationId,limit).map(row=>JSON.parse(String(row.record)) as EvidenceRecord);
  }
  saveVersion(version:VersionManifest):void {
    const {digest,...content}=version;if(!/^[a-f0-9]{64}$/.test(digest)||fingerprint(content).sha256!==digest)throw new Error('Invalid source version manifest.');
    const directory=join(this.directory,'versions');mkdirSync(directory,{recursive:true});
    try{writeFileSync(join(directory,`${digest}.json`),JSON.stringify(version,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
  close():void {this.db.close();}
}
/** Hash only portable project-owned source and policy; do not inspect credentials or state. */
export async function captureVersion(projectDir:string,agent:AgentConfig,provider:ServiceConfig['provider'],modelSelection?:ModelResolutionEvidence):Promise<VersionManifest> {
  const root=resolve(projectDir);const files:VersionManifest['files']=[];
  async function inspect(path:string):Promise<void>{
    let stat;try{stat=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink())throw new Error('Versioned source must not contain symbolic links.');
    if(stat.isDirectory()){for(const name of (await readdir(path)).sort()){
      if(['node_modules','state','artifacts','.cache','.git','dist'].includes(name)||name.startsWith('.env'))continue;
      await inspect(join(path,name));
    }return;}
    if(!stat.isFile())return;if(files.length>=256||stat.size>2*1024*1024)throw new Error('Versioned source exceeds the bounded manifest limit.');
    const content=await readFile(path);files.push({path:relative(root,path).split(sep).join('/'),sha256:createHash('sha256').update(content).digest('hex'),bytes:content.length});
  }
  for(const name of ['src','prompts','scripts','package.json','package-lock.json','tsconfig.json'])await inspect(join(root,name));
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const policy={agentId:agent.id,repositories:[...agent.repositories].sort(),...(agent.workspaceRoot?{workspaceRoot:agent.workspaceRoot}:{}),instructionsSha256:fingerprint(agent.instructions).sha256,provider:{kind:provider.kind,...(provider.model?{model:provider.model}:{}),...(provider.thinkingLevel?{effort:provider.thinkingLevel}:{}),...(provider.reflection?{reflection:choicePolicy(provider.reflection)}:{})},...(agent.modelChoice?{modelChoice:choicePolicy(agent.modelChoice)}:{}),...(modelSelection?{modelSelection}:{}),...(agent.subagents?{subagents:{roles:agent.subagents.roles.map(role=>({id:role.id,instructionsSha256:fingerprint(role.instructions).sha256,...(role.modelChoice?{modelChoice:choicePolicy(role.modelChoice)}:{})})).sort((a,b)=>a.id.localeCompare(b.id)),maxChildrenPerCall:agent.subagents.maxChildrenPerCall??4,maxChildrenPerRun:agent.subagents.maxChildrenPerRun??8,maxTaskChars:agent.subagents.maxTaskChars??6000,maxResultChars:agent.subagents.maxResultChars??12000}}:{})};
  const content={version:1 as const,files,policy};return {...content,digest:fingerprint(content).sha256};
}
