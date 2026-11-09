// Build with npm run build. Read-only Pi RPC inventory; never submits a prompt.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute } from 'node:path';
import type { Api, ModelCost, ModelInputModality, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

/** Safe catalog metadata. Executable endpoint/header configuration stays in its owning runtime. */
export interface CatalogModel {
  id:string;provider:string;name:string;api:Api;reasoning:boolean;
  input:ModelInputModality[];contextWindow:number;maxTokens:number;cost:ModelCost;
  thinkingLevelMap?:ThinkingLevelMap;
}
export interface PiModelInventory {
  version:1;source:'pi-rpc';observedAt:string;models:CatalogModel[];
  availability:'configured-not-probed';
}
const levels:readonly ModelThinkingLevel[]=['off','minimal','low','medium','high','xhigh','max'];
const maxStdout=8*1024*1024,maxStderr=64*1024;
const invalidMetadata=()=>new Error('Pi model inventory returned invalid model metadata.');
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalidMetadata();
  return value as Record<string,unknown>;
}
function text(value:unknown,maximum:number):string{
  if(typeof value!=='string'||!value.trim()||value.length>maximum||/[\x00-\x1f\x7f]/u.test(value)||/\b(?:Bearer\s+\S+|sk-(?:ant-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,})\b/i.test(value))throw invalidMetadata();
  return value;
}
function number(value:unknown,positive=false):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e12||(positive&&(!Number.isSafeInteger(value)||value<1)))throw invalidMetadata();
  return value;
}
function cost(value:unknown):ModelCost{
  const source=record(value),rates={input:number(source.input),output:number(source.output),cacheRead:number(source.cacheRead),cacheWrite:number(source.cacheWrite)};
  if(source.tiers===undefined)return rates;
  if(!Array.isArray(source.tiers)||source.tiers.length>32)throw invalidMetadata();
  return {...rates,tiers:source.tiers.map(item=>{
    const tier=record(item);return{inputTokensAbove:number(tier.inputTokensAbove,true),input:number(tier.input),output:number(tier.output),cacheRead:number(tier.cacheRead),cacheWrite:number(tier.cacheWrite)};
  })};
}
function projectModel(value:unknown):CatalogModel{
  const source=record(value);
  if(typeof source.reasoning!=='boolean'||!Array.isArray(source.input)||source.input.length<1||source.input.length>2||source.input.some(input=>input!=='text'&&input!=='image'))throw invalidMetadata();
  const model:CatalogModel={id:text(source.id,256),provider:text(source.provider,96),name:text(source.name,512),api:text(source.api,96) as Api,reasoning:source.reasoning,input:[...new Set(source.input)] as ModelInputModality[],contextWindow:number(source.contextWindow,true),maxTokens:number(source.maxTokens,true),cost:cost(source.cost)};
  if(/\s/u.test(model.id)||!/^[a-z0-9][a-z0-9_-]*$/i.test(model.provider))throw invalidMetadata();
  if(source.thinkingLevelMap!==undefined){
    const mapping=record(source.thinkingLevelMap),safe:ThinkingLevelMap={};
    for(const level of levels)if(Object.hasOwn(mapping,level))safe[level]=mapping[level]===null?null:text(mapping[level],64);
    model.thinkingLevelMap=safe;
  }
  return model;
}

/** Project only public model metadata from an already parsed catalog array. */
export function sanitizeCatalogModels(value:unknown,provider?:string):CatalogModel[]{
  if(provider!==undefined&&!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(provider))throw new Error('Model discovery requires an exact bounded provider ID.');
  if(!Array.isArray(value)||value.length>10000)throw invalidMetadata();
  const selected=value.filter(model=>provider===undefined||record(model).provider===provider).map(projectModel);
  const identities=new Set<string>();
  for(const model of selected){const identity=`${model.provider}\0${model.id}`;if(identities.has(identity))throw invalidMetadata();identities.add(identity);}
  return selected;
}

/** Enumerate configured chat models without generation, OAuth refresh, ambient extensions or credential output. */
export async function discoverPiModels(piCliPath:string,options:{provider?:string;timeoutMs?:number;signal?:AbortSignal}={}):Promise<PiModelInventory>{
  if(typeof piCliPath!=='string'||!isAbsolute(piCliPath)||!['.js','.mjs','.cjs'].includes(extname(piCliPath).toLowerCase()))throw new Error('Model discovery requires an absolute installed Pi CLI JavaScript entry path.');
  if(options.provider!==undefined&&!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(options.provider))throw new Error('Model discovery requires an exact bounded provider ID.');
  const timeoutMs=options.timeoutMs??15000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>60000)throw new Error('Model discovery timeoutMs must be an integer from 50 to 60000.');
  if(options.signal?.aborted)throw new Error('Pi model inventory was cancelled.');
  const requestId=`durable-models-${randomUUID()}`;
  return await new Promise<PiModelInventory>((resolve,reject)=>{
    const args=[piCliPath,'--offline','--mode','rpc','--no-session','--no-approve','--no-context-files','--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--no-themes'];
    const child=spawn(process.execPath,args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PI_OFFLINE:'1',PI_TELEMETRY:'0'}});
    let buffer='',stdoutBytes=0,stderrBytes=0,responseCount=0,result:PiModelInventory|undefined,failure:Error|undefined,closed=false;
    let forceTimer:NodeJS.Timeout|undefined;
    const stop=(error?:Error)=>{
      if(error&&!failure)failure=error;
      if(closed)return;
      child.stdin.end();child.kill();
      forceTimer??=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},250);
    };
    const timer=setTimeout(()=>stop(new Error('Pi model inventory timed out.')),timeoutMs);
    const abort=()=>stop(new Error('Pi model inventory was cancelled.'));
    options.signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>stop(new Error('Pi model inventory could not start.')));
    child.stdin.on('error',()=>{if(!result&&!failure)stop(new Error('Pi model inventory input could not be delivered.'));});
    child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>maxStderr)stop(new Error('Pi model inventory exceeded its output limit.'));});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      stdoutBytes+=Buffer.byteLength(chunk);if(stdoutBytes>maxStdout){stop(new Error('Pi model inventory exceeded its output limit.'));return;}
      buffer+=chunk;
      for(let index;(index=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;
        let value:unknown;try{value=JSON.parse(line);}catch{stop(new Error('Pi model inventory emitted invalid JSON.'));return;}
        if(!value||typeof value!=='object'||Array.isArray(value))continue;
        const response=value as Record<string,unknown>;
        if(response.id!==requestId)continue;
        responseCount++;if(responseCount>1){stop(new Error('Pi model inventory returned duplicate responses.'));continue;}
        if(response.type!=='response'||response.command!=='get_available_models'||response.success!==true){stop(new Error('Pi model inventory request failed.'));continue;}
        try{
          const data=record(response.data),selected=sanitizeCatalogModels(data.models,options.provider);
          result={version:1,source:'pi-rpc',observedAt:new Date().toISOString(),models:selected,availability:'configured-not-probed'};
          stop();
        }catch{stop(invalidMetadata());}
      }
    });
    child.on('close',()=>{
      closed=true;clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);options.signal?.removeEventListener('abort',abort);
      if(failure)reject(failure);else if(result)resolve(result);else reject(new Error('Pi model inventory exited without a matching response.'));
    });
    child.stdin.write(JSON.stringify({id:requestId,type:'get_available_models'})+'\n');
  });
}
