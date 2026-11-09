// Build with npm run build. Resolve exact model choices before durable admission.
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { CatalogModel } from './model-discovery.js';

export type TaskProfile = 'routine'|'coding'|'review'|'research'|'reflection';
export interface ModelChoice {
  /** Exact model ID, provider/model ID, latest, or latest:sol|astra|luna. */
  model?:string;
  task?:TaskProfile;
  thinkingLevel?:ModelThinkingLevel;
}
export interface Selection {
  model:{provider:string;modelId:string};
  thinkingLevel:ModelThinkingLevel;
  requestedThinkingLevel:ModelThinkingLevel;
  /** Provider-native value from the catalog map, when explicitly supplied. */
  effectiveThinkingLevel?:string;
  reason:string;
  sourceModel:CatalogModel;
}
export type ModelFamily='sol'|'astra'|'luna';
type Family=ModelFamily;
type Versioned={model:CatalogModel;family:Family;version:number[];snapshot:number};
const levels:readonly ModelThinkingLevel[]=['off','minimal','low','medium','high','xhigh','max'];
export const TASK_MODEL_DEFAULTS:Readonly<Record<TaskProfile,Readonly<{family:ModelFamily;thinkingLevel:ModelThinkingLevel}>>>=Object.freeze({
  routine:Object.freeze({family:'luna',thinkingLevel:'low'}),
  coding:Object.freeze({family:'sol',thinkingLevel:'medium'}),
  review:Object.freeze({family:'astra',thinkingLevel:'high'}),
  research:Object.freeze({family:'astra',thinkingLevel:'xhigh'}),
  reflection:Object.freeze({family:'astra',thinkingLevel:'high'}),
});

/** This host implements these tool-capable transports, not every Pi catalog API. */
export function compatibleModel(model:CatalogModel):boolean {
  if(model.provider==='faux')return (model.api==='faux'||model.api.startsWith('faux:'))&&model.input.includes('text');
  const api:Record<string,string>={'openai-codex':'openai-codex-responses',openai:'openai-responses',anthropic:'anthropic-messages',faux:'faux'};
  return !!api[model.provider]&&model.api===api[model.provider]&&model.input.includes('text');
}

/** Recognize versioned stable GPT tiers; do not guess release order for unknown names. */
function versioned(model:CatalogModel):Versioned|undefined {
  const match=/^gpt-(\d+(?:\.\d+){0,3})-(sol|astra|luna)(?:-(\d{4})-(\d{2})-(\d{2}))?$/.exec(model.id);
  if(!match)return;
  const version=match[1].split('.').map(Number);
  if(version.some(part=>!Number.isSafeInteger(part)||part>1000000000))return;
  let snapshot=0;
  if(match[3]){
    const year=Number(match[3]),month=Number(match[4]),day=Number(match[5]);
    const date=new Date(Date.UTC(year,month-1,day));
    if(year<2000||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return;
    snapshot=year*10000+month*100+day;
  }
  return {model,family:match[2] as Family,version,snapshot};
}
function newest(a:Versioned,b:Versioned):number {
  for(let index=0;index<Math.max(a.version.length,b.version.length);index++){
    const difference=(b.version[index]??0)-(a.version[index]??0);if(difference)return difference;
  }
  return b.snapshot-a.snapshot||a.model.id.localeCompare(b.model.id);
}

/** Report catalog capabilities and declared task-tier classification, not benchmark scores. */
export function describeModel(model:CatalogModel){
  const parsed=versioned(model);
  const supportedThinkingLevels=getSupportedThinkingLevels({...model,baseUrl:''});
  const tier:Record<Family,'balanced'|'frontier'|'efficient'>={sol:'balanced',astra:'frontier',luna:'efficient'};
  const effectiveThinkingMap:Partial<Record<ModelThinkingLevel,string>>={};
  for(const level of supportedThinkingLevels){
    const native=model.thinkingLevelMap?.[level];
    effectiveThinkingMap[level]=typeof native==='string'?native:'provider-default';
  }
  return {
    family:parsed?.family,version:parsed?.version.join('.'),
    ...(parsed?.snapshot?{snapshotDate:String(parsed.snapshot).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3')}:{}),
    capabilityTier:parsed?tier[parsed.family]:'unclassified',
    capabilityBasis:parsed?'known-family task policy; no intelligence score':'unclassified; use an explicit model ID',
    supportedThinkingLevels,effectiveThinkingMap,compatibleWithHost:compatibleModel(model),
  };
}

/**
 * Family is an explicit task policy, not an inferred intelligence score.
 * Available means present in the supplied catalog; it is not an inference probe.
 */
export function selectModel(models:readonly CatalogModel[],choice:ModelChoice={},defaultModel?:string):Selection {
  const task=choice.task??'coding';
  if(!Object.hasOwn(TASK_MODEL_DEFAULTS,task))throw new Error('Unknown model task profile.');
  if(choice.thinkingLevel!==undefined&&!levels.includes(choice.thinkingLevel))throw new Error('Unknown Pi thinking level.');
  const requested=choice.model??defaultModel??'latest';
  if(typeof requested!=='string'||!requested.trim()||requested.length>256)throw new Error('Select one bounded exact model ID or latest policy.');
  const providers=new Set(models.map(model=>model.provider));
  if(providers.size!==1)throw new Error('Model selection requires a nonempty catalog for exactly one provider.');
  const unique=new Set<string>();
  for(const model of models){
    const key=`${model.provider}/${model.id}`;
    if(unique.has(key))throw new Error('Catalog contains an ambiguous duplicate model identity.');unique.add(key);
  }
  const compatible=models.filter(compatibleModel);
  let selected:CatalogModel|undefined,reason:string;
  if(requested==='latest'||requested.startsWith('latest:')){
    const explicit=requested==='latest'?undefined:requested.slice('latest:'.length);
    if(explicit!==undefined&&!['sol','astra','luna'].includes(explicit))throw new Error('Latest policy must select sol, astra or luna.');
    const preferred=(explicit??TASK_MODEL_DEFAULTS[task].family) as Family;
    const candidates=compatible.map(versioned).filter((item):item is Versioned=>!!item);
    const familyOrder:Family[]=explicit?[preferred]:[preferred,...(['sol','astra','luna'] as Family[]).filter(family=>family!==preferred)];
    let used:Family|undefined;
    for(const family of familyOrder){
      const matches=candidates.filter(candidate=>candidate.family===family).sort(newest);
      if(matches.length){selected=matches[0].model;used=family;break;}
    }
    if(!selected)throw new Error('No compatible stable versioned model satisfies the latest policy. Refresh the catalog or select a supported exact ID.');
    reason=`Latest known numeric version within ${used} for task ${task}.`;
    if(used!==preferred)reason+=` Preferred ${preferred} is absent; explicit fallback to ${used}.`;
    reason+=' Tier choice is task policy; cross-family version numbers do not rank intelligence. Catalog presence is not proof of account entitlement.';
  }else{
    selected=compatible.find(model=>model.id===requested||`${model.provider}/${model.id}`===requested);
    if(!selected)throw new Error('The exact model is absent or incompatible with this host. Refresh the catalog or change the explicit choice.');
    reason='Preserved the exact configured model; no silent upgrade or provider change.';
  }
  const requestedThinkingLevel=choice.thinkingLevel??TASK_MODEL_DEFAULTS[task].thinkingLevel;
  // Sanitized catalogs intentionally omit endpoints. The helper reads reasoning/map only.
  const descriptor:Model<Api>={...selected,baseUrl:''};
  const supported=getSupportedThinkingLevels(descriptor);
  if(!supported.length)throw new Error('The model catalog declares no supported thinking level.');
  if(choice.thinkingLevel!==undefined&&!supported.includes(choice.thinkingLevel))throw new Error('The explicitly requested thinking level is unsupported by the selected model.');
  const thinkingLevel=choice.thinkingLevel??clampThinkingLevel(descriptor,requestedThinkingLevel);
  if(thinkingLevel!==requestedThinkingLevel)reason+=` Default ${requestedThinkingLevel} effort is unavailable; using supported ${thinkingLevel}.`;
  const mapped=selected.thinkingLevelMap?.[thinkingLevel];
  const effectiveThinkingLevel=typeof mapped==='string'?mapped:undefined;
  if(effectiveThinkingLevel&&effectiveThinkingLevel!==thinkingLevel)reason+=` Pi ${thinkingLevel} maps to provider-native ${effectiveThinkingLevel}.`;
  return {model:{provider:selected.provider,modelId:selected.id},thinkingLevel,requestedThinkingLevel,...(effectiveThinkingLevel?{effectiveThinkingLevel}:{}),reason,sourceModel:structuredClone(selected)};
}
