// Generated project: npm test. No provider calls; selection uses explicit catalog evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxProvider} from '@earendil-works/pi-ai';
import {compatibleModel,describeModel,selectModel,TASK_MODEL_DEFAULTS} from '../src/model-selection.js';
import type {CatalogModel} from '../src/model-discovery.js';

const model=(id:string,extra:Partial<CatalogModel>={}):CatalogModel=>({
  id,name:id,provider:'openai-codex',api:'openai-codex-responses',reasoning:true,input:['text'],
  contextWindow:200000,maxTokens:32000,cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0},
  thinkingLevelMap:{off:null,minimal:'low',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'},...extra,
});
const catalog=[model('gpt-5.6-sol'),model('gpt-6-sol'),model('gpt-6.1-sol'),model('gpt-6-astra'),model('gpt-6-luna')];

test('latest selection chooses task tier first and newest semantic version within that tier',()=>{
  assert.equal(selectModel(catalog,{task:'coding'}).model.modelId,'gpt-6.1-sol');
  assert.equal(selectModel(catalog,{task:'routine'}).model.modelId,'gpt-6-luna');
  assert.equal(selectModel(catalog,{task:'review'}).model.modelId,'gpt-6-astra');
  assert.equal(selectModel(catalog,{task:'research'}).thinkingLevel,'xhigh');
  assert.equal(selectModel(catalog,{task:'reflection'}).thinkingLevel,'high');
  assert.equal(selectModel([model('gpt-6.2-sol'),model('gpt-6.10-sol'),model('gpt-6.9-sol')],{model:'latest:sol'}).model.modelId,'gpt-6.10-sol');
});

test('exact IDs and explicit family policies remain binding',()=>{
  assert.equal(selectModel(catalog,{model:'gpt-5.6-sol',task:'review'}).model.modelId,'gpt-5.6-sol');
  assert.equal(selectModel(catalog,{model:'openai-codex/gpt-6-sol'}).model.modelId,'gpt-6-sol');
  assert.equal(selectModel(catalog,{task:'review'},'latest:sol').model.modelId,'gpt-6.1-sol');
  assert.throws(()=>selectModel(catalog,{model:'gpt-9-sol'}),/exact model/);
  assert.throws(()=>selectModel(catalog.filter(item=>!item.id.endsWith('astra')),{model:'latest:astra'}),/No compatible/);
});

test('selection evidence is detached from a subsequently refreshed mutable catalog',()=>{
  const original=model('gpt-6.1-sol');
  const selected=selectModel([original],{});
  original.name='Changed after resolution';original.thinkingLevelMap!.low='high';
  assert.equal(selected.sourceModel.name,'gpt-6.1-sol');assert.equal(selected.sourceModel.thinkingLevelMap!.low,'low');
});

test('automatic selection excludes aliases, preview names, invalid snapshot dates and unsupported APIs',()=>{
  const choices=[model('gpt-6-sol'),model('gpt-99-sol-preview'),model('gpt-99-sol-latest'),model('gpt-99-sol-2026-02-31'),model('gpt-99-sol',{api:'openai-completions'}),model('gpt-99-sol-realtime'),model('gpt-99-unknown')];
  assert.equal(selectModel(choices,{model:'latest:sol'}).model.modelId,'gpt-6-sol');
  assert.equal(selectModel(choices,{model:'gpt-99-sol-preview'}).model.modelId,'gpt-99-sol-preview');
  assert.equal(compatibleModel(model('gpt-6-sol',{input:['image']})),false);
  assert.equal(compatibleModel(model('gpt-6-sol',{provider:'openai',api:'openai-completions'})),false);
});

test('same-generation dated releases order chronologically and deterministic ties do not use input order',()=>{
  const input=[model('gpt-6.1-sol'),model('gpt-6.1-sol-2026-09-01'),model('gpt-6.1-sol-2026-10-20')];
  assert.equal(selectModel(input,{model:'latest:sol'}).model.modelId,'gpt-6.1-sol-2026-10-20');
  assert.deepEqual(selectModel(input,{model:'latest:sol'}).model,selectModel([...input].reverse(),{model:'latest:sol'}).model);
});

test('plain latest discloses absent-tier fallback while unknown versions are never guessed',()=>{
  const result=selectModel([model('gpt-6.1-sol')],{task:'research'});
  assert.equal(result.model.modelId,'gpt-6.1-sol');assert.match(result.reason,/Preferred astra is absent/);
  assert.throws(()=>selectModel([model('brand-new-supreme')],{model:'latest'}),/No compatible/);
  assert.equal(selectModel([model('brand-new-supreme')],{model:'brand-new-supreme'}).model.modelId,'brand-new-supreme');
});

test('model-specific thinking maps are honored without treating effort as a universal intelligence score',()=>{
  const minimal=selectModel([model('gpt-6.1-sol')],{model:'gpt-6.1-sol',thinkingLevel:'minimal'});
  assert.equal(minimal.thinkingLevel,'minimal');assert.equal(minimal.requestedThinkingLevel,'minimal');assert.equal(minimal.effectiveThinkingLevel,'low');
  assert.match(minimal.reason,/maps to provider-native low/);
  assert.throws(()=>selectModel([model('gpt-6.1-sol')],{thinkingLevel:'off'}),/explicitly requested/);
  assert.throws(()=>selectModel(catalog,{thinkingLevel:'ultra' as never}),/Unknown Pi/);
  const noExtended=model('gpt-6.1-sol',{thinkingLevelMap:{off:null,max:null,xhigh:null}});
  const clamped=selectModel([noExtended],{task:'research'});assert.equal(clamped.thinkingLevel,'high');assert.equal(clamped.requestedThinkingLevel,'xhigh');
  assert.throws(()=>selectModel([noExtended],{thinkingLevel:'xhigh'}),/unsupported/);
});

test('nonreasoning exact models use off and explicit unsupported effort fails',()=>{
  const plain=model('small-exact-model',{reasoning:false,thinkingLevelMap:undefined});
  assert.equal(selectModel([plain],{model:plain.id}).thinkingLevel,'off');
  assert.throws(()=>selectModel([plain],{model:plain.id,thinkingLevel:'high'}),/unsupported/);
});

test('ambiguous providers, duplicates, empty catalogs and invalid policies fail closed',()=>{
  assert.throws(()=>selectModel([],{}),/nonempty/);
  assert.throws(()=>selectModel([model('gpt-6-sol'),model('gpt-6-sol')],{}),/duplicate/);
  assert.throws(()=>selectModel([model('gpt-6-sol'),model('gpt-6-sol',{provider:'openai',api:'openai-responses'})],{}),/exactly one provider/);
  assert.throws(()=>selectModel(catalog,{model:'latest:unknown'}),/Latest policy/);
  assert.throws(()=>selectModel(catalog,{task:'unknown' as never}),/Unknown model task/);
  assert.throws(()=>selectModel(catalog,{model:''}),/bounded exact/);
});

test('catalog descriptions disclose family policy, actual efforts, aliases and unknown metadata',()=>{
  const described=describeModel(model('gpt-6.1-sol-2026-10-20'));
  assert.equal(described.family,'sol');assert.equal(described.version,'6.1');assert.equal(described.snapshotDate,'2026-10-20');
  assert.equal(described.capabilityTier,'balanced');assert.match(described.capabilityBasis,/no intelligence score/);
  assert.equal(described.effectiveThinkingMap.minimal,'low');assert.equal(described.supportedThinkingLevels.includes('off'),false);
  const unknown=describeModel(model('unknown-model',{thinkingLevelMap:undefined}));
  assert.equal(unknown.capabilityTier,'unclassified');assert.equal(unknown.version,undefined);assert.equal(unknown.effectiveThinkingMap.high,'provider-default');
  assert.equal(TASK_MODEL_DEFAULTS.review.family,'astra');assert.equal(TASK_MODEL_DEFAULTS.routine.thinkingLevel,'low');
});

test('an actual offline faux model is compatible despite its unique per-provider API identity',()=>{
  const actual=fauxProvider({tokensPerSecond:Infinity}).getModel();
  assert.equal(compatibleModel(actual),true);assert.equal(describeModel(actual).compatibleWithHost,true);
  assert.equal(selectModel([actual],{model:actual.id}).thinkingLevel,'off');
  assert.equal(compatibleModel({...actual,provider:'openai'}),false);
});
