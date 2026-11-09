// Build with npm run build. Catalog I/O stays in the generated project/state.
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createModels,fauxProvider,cleanupSessionResources,type Model,type Api,type Provider} from '@earendil-works/pi-ai';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {createCodexProvider} from './codex-provider.js';
import {discoverPiModels,sanitizeCatalogModels,type CatalogModel} from './model-discovery.js';
import {compatibleModel,selectModel,type ModelChoice} from './model-selection.js';
import type {ServiceConfig} from './config.js';

export interface ModelCatalog {
  version:1;source:'pi-public'|'pi-rpc'|'bundled'|'snapshot';observedAt:string;
  provider:string;models:CatalogModel[];digest:string;
  availability:'configured-not-probed'|'catalog-only';lastModified?:string;warning?:string;
}
const hash=(models:readonly CatalogModel[])=>createHash('sha256').update(JSON.stringify([...models].sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
export {hash as catalogDigest};
const sessionOwners=new Map<string,Set<symbol>>();
/** Dispose only sessions observed by this provider instance, after its Harness has closed. */
export function ownProviderSessions(provider:Provider){
  const owner=Symbol('model-runtime'),sessions=new Set<string>();let disposed=false;
  const remember=(options:{sessionId?:string}|undefined)=>{
    if(disposed)throw new Error('The model runtime owner is closed.');
    const id=options?.sessionId;if(!id)return;
    sessions.add(id);let owners=sessionOwners.get(id);if(!owners){owners=new Set();sessionOwners.set(id,owners);}owners.add(owner);
  };
  const wrapped:Provider={...provider,
    stream(model,context,options){remember(options);return provider.stream(model,context,options);},
    streamSimple(model,context,options){remember(options);return provider.streamSimple(model,context,options);},
  };
  const dispose=()=>{if(disposed)return;disposed=true;const errors:unknown[]=[];for(const id of sessions){const owners=sessionOwners.get(id);owners?.delete(owner);if(owners?.size)continue;sessionOwners.delete(id);try{cleanupSessionResources(id);}catch(error){errors.push(error);}}sessions.clear();if(errors.length)throw new AggregateError(errors,'Owned model session cleanup failed.');};
  return {provider:wrapped,dispose};
}
function baseProvider(config:ServiceConfig):Provider {
  return config.provider.kind==='faux'?fauxProvider({tokensPerSecond:Infinity}).provider:
    config.provider.kind==='openai-codex'?createCodexProvider(config.provider.piCliPath):
      config.provider.kind==='openai'?openaiProvider():anthropicProvider();
}
function snapshot(value:unknown,provider:string):ModelCatalog {
  if(!value||typeof value!=='object')throw new Error('Expected a model catalog snapshot.');
  const input=value as Record<string,unknown>;
  if(input.version!==1||input.provider!==provider||typeof input.observedAt!=='string'||!Number.isFinite(Date.parse(input.observedAt)))throw new Error('Model catalog identity or observation time is invalid.');
  const models=sanitizeCatalogModels(input.models,provider);
  if(!models.length||input.digest!==hash(models))throw new Error('Model catalog digest mismatch or empty provider catalog.');
  return {version:1,source:'snapshot',provider,observedAt:input.observedAt,models,digest:hash(models),availability:'catalog-only'};
}
/** Public metadata only; this request sends no account credentials and never follows redirects. */
export async function fetchPublicModelCatalog(provider:string,fetcher:typeof fetch=fetch):Promise<ModelCatalog> {
  if(!['openai-codex','openai','anthropic'].includes(provider))throw new Error('Public refresh supports only this host\'s configured providers.');
  const response=await fetcher(`https://pi.dev/api/models/providers/${provider}?types=chat`,{redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Public model catalog refresh failed.');
  if(Number(response.headers.get('content-length')??0)>2*1024*1024)throw new Error('Public model catalog exceeds the size limit.');
  const reader=response.body?.getReader();if(!reader)throw new Error('Public model catalog has no body.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>2*1024*1024)throw new Error('Public model catalog exceeds the size limit.');chunks.push(item.value);}}finally{await reader.cancel();}
  let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Public model catalog is not valid JSON.');}
  const models=sanitizeCatalogModels(input,provider).filter(compatibleModel);
  if(!models.length)throw new Error('The public catalog has no model compatible with this host.');
  const modified=response.headers.get('last-modified');
  return {version:1,source:'pi-public',provider,observedAt:new Date().toISOString(),models,digest:hash(models),availability:'catalog-only',...(modified&&Number.isFinite(Date.parse(modified))?{lastModified:new Date(modified).toISOString()}:{})};
}
export async function loadModelCatalog(config:ServiceConfig,override?:'refresh'|'pi-cache'|'bundled'):Promise<ModelCatalog> {
  const provider=baseProvider(config),kind=provider.id;
  if(config.provider.catalogFile&&!override)return snapshot(JSON.parse(await readFile(resolve(config.projectDir??process.cwd(),config.provider.catalogFile),'utf8')),kind);
  const mode=override??config.provider.catalogMode??(config.provider.model?.startsWith('latest')?'refresh':config.provider.kind==='openai-codex'?'pi-cache':'bundled');
  if(config.provider.kind!=='faux'&&mode==='refresh')return fetchPublicModelCatalog(kind);
  if(config.provider.kind!=='faux'&&mode==='pi-cache'){
    const inventory=await discoverPiModels(config.provider.piCliPath??process.env.PI_CLI_PATH??'',{provider:kind});
    if(!inventory.models.length)throw new Error('Pi lists no configured models for this provider. Check account readiness or select an explicit catalog source.');
    return {...inventory,provider:kind,digest:hash(inventory.models)};
  }
  const models=sanitizeCatalogModels(provider.getModels(),kind);
  return {version:1,source:'bundled',provider:kind,observedAt:new Date().toISOString(),models,digest:hash(models),availability:'catalog-only',warning:'Bundled catalog may be older than the provider. Refresh before claiming latest availability.'};
}
/** Merge historical definitions for recovery, but select new work only from the current catalog. */
export async function buildModelRuntime(config:ServiceConfig,choice:ModelChoice={}) {
  if(config.provider.kind==='faux')throw new Error('Keep the offline faux runtime separate from live model resolution.');
  const owned=ownProviderSessions(baseProvider(config));const provider=owned.provider,catalog=await loadModelCatalog(config),models=createModels();
  const directory=join(config.dataDir,'model-catalog',provider.id);await mkdir(directory,{recursive:true});
  const known=new Map<string,Model<Api>>(provider.getModels().map(model=>[model.id,model]));
  const endpoint=provider.baseUrl??provider.getModels()[0]?.baseUrl;
  if(!endpoint)throw new Error('The configured provider has no supported runtime endpoint.');
  const register=(items:readonly CatalogModel[])=>{for(const item of items){if(item.provider!==provider.id||!compatibleModel(item))continue;const prior=known.get(item.id);known.set(item.id,{...prior,...item,baseUrl:prior?.baseUrl??endpoint});}};
  const records=(await readdir(directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
  if(records.length>128)throw new Error('Review retained model catalog history before adding further versions.');
  for(const name of records){const path=join(directory,name);if((await lstat(path)).isSymbolicLink())throw new Error('Historical catalog snapshots cannot be symlinks.');const previous=snapshot(JSON.parse(await readFile(path,'utf8')),provider.id);register(previous.models);}
  register(catalog.models);
  models.setProvider({...provider,getModels:()=>[...known.values()]});
  const auth=await models.checkAuth(provider.id);
  if(!auth)throw new Error('The selected model provider has no configured credential.');
  catalog.availability='configured-not-probed';
  try{await writeFile(join(directory,`${catalog.digest}.json`),JSON.stringify(catalog,null,2)+'\n',{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const select=(next:ModelChoice={})=>selectModel(catalog.models,{...next,thinkingLevel:next.thinkingLevel??config.provider.thinkingLevel},config.provider.model);
  const selection=select(choice);
  const {models:_entries,...summary}=catalog;
  return {models,selection,catalog:summary,select,dispose:owned.dispose};
}
