#!/usr/bin/env node
// npm run models -- --help. Read-only listing; lock writes new project-owned files.
import {readFile,writeFile,rm} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig,loadServiceEnvironment,getReflectionModelChoice} from './config.js';
import {loadModelCatalog,fetchPublicModelCatalog,catalogDigest} from './model-runtime.js';
import {discoverPiModels} from './model-discovery.js';
import {describeModel,selectModel,TASK_MODEL_DEFAULTS,type ModelChoice,type TaskProfile} from './model-selection.js';
import type {ModelThinkingLevel} from '@earendil-works/pi-ai';

const help=`Project model catalog and explicit policy resolution:
  npm run models -- list --provider openai-codex [--source refresh|pi-cache] [--pi-cli ABSOLUTE_JS]
  npm run models -- resolve --provider openai-codex --task coding
  npm run models -- list --config config.codex.example.json [--source refresh|pi-cache|bundled]
  npm run models -- resolve --config config.codex.example.json [--task routine|coding|review|research|reflection] [--agent ID] [--role ID] [--model latest:sol|EXACT_ID] [--thinking LEVEL]
  npm run models -- refresh --config config.codex.example.json --output models.json
  npm run models -- lock --config config.codex.example.json --output config.resolved.json

--pi-cli ABSOLUTE_JS supplies the installed Pi CLI entry without changing files.
Listing does not invoke a model. Refresh reads public pi.dev metadata and writes
only the explicit output. It never updates the global Pi account/catalog store.
Lock writes a new config and sibling catalog snapshot, pinning every resident,
specialist and reflection choice. Use that config for reproducible evolution.
Catalog/auth presence is not proof of server entitlement. Reasoning effort is a
per-model work setting, not a universal intelligence score. See AGENTS.md.`;

export async function runModelsCommand(argv:string[]) {
  const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{config:{type:'string',default:'config.json'},provider:{type:'string'},source:{type:'string'},output:{type:'string'},task:{type:'string'},model:{type:'string'},thinking:{type:'string'},agent:{type:'string'},role:{type:'string'},'pi-cli':{type:'string'},help:{type:'boolean',short:'h'}}});
  if(values.help||!positionals.length||positionals[0]==='help'){console.log(help);return;}
  if(positionals.length!==1||!['list','resolve','refresh','lock'].includes(positionals[0]))throw new Error('Unknown models command; use --help.');
  const command=positionals[0],configPath=resolve(values.config!),project=dirname(configPath);
  if(values['pi-cli'])process.env.PI_CLI_PATH=values['pi-cli'];
  if(values.provider){
    if(!['list','refresh','resolve'].includes(command))throw new Error('Use a project config for model lock.');
    if(values.agent||values.role)throw new Error('Use a project config to resolve named agents or roles.');
    if(values.source&&!['refresh','pi-cache'].includes(values.source))throw new Error('Direct provider listing supports refresh or pi-cache.');
    const inventory=command!=='refresh'&&values.source==='pi-cache'?await discoverPiModels(values['pi-cli']??process.env.PI_CLI_PATH??'',{provider:values.provider}):await fetchPublicModelCatalog(values.provider);
    const catalog={...inventory,provider:values.provider,digest:catalogDigest(inventory.models)};
    if(command==='refresh'){
      if(!values.output)throw new Error('refresh requires --output.');
      const output=resolve(values.output);if(dirname(output)!==resolve('.')||!output.endsWith('.json'))throw new Error('Write a new sibling JSON snapshot in the caller project.');
      await writeFile(output,JSON.stringify(catalog,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({catalog:output,digest:catalog.digest,source:catalog.source,inferencePerformed:false},null,2));
    }else if(command==='resolve'){
      const selection=selectModel(catalog.models,{model:values.model??'latest',...(values.task?{task:values.task as TaskProfile}:{}),...(values.thinking?{thinkingLevel:values.thinking as ModelThinkingLevel}:{})});
      console.log(JSON.stringify({selection,catalog:{source:catalog.source,digest:catalog.digest,observedAt:catalog.observedAt,availability:catalog.availability},inferencePerformed:false},null,2));
    }else console.log(JSON.stringify({...catalog,models:catalog.models.map(model=>({...model,...describeModel(model)})),taskDefaults:TASK_MODEL_DEFAULTS,inferencePerformed:false},null,2));
    return;
  }
  const config=await loadConfig(configPath);
  if(values.source&&!['refresh','pi-cache','bundled'].includes(values.source))throw new Error('Select refresh, pi-cache or bundled catalog source.');
  if(command==='refresh'&&!values.output)throw new Error('refresh requires --output for a project-owned catalog snapshot.');
  // No environment/credential inspection is needed for public refresh or bundled listing.
  if(values.source==='pi-cache'||config.provider.catalogMode==='pi-cache')await loadServiceEnvironment(config.dataDir);
  const catalog=await loadModelCatalog(config,command==='refresh'?'refresh':values.source as 'refresh'|'pi-cache'|'bundled'|undefined);
  const defaultModel=config.provider.kind==='faux'?catalog.models[0]?.id:config.provider.model;
  const select=(choice:ModelChoice)=>selectModel(catalog.models,{...choice,thinkingLevel:choice.thinkingLevel??config.provider.thinkingLevel},defaultModel);
  let result:unknown;
  if(command==='list'){
    result={...catalog,models:catalog.models.map(model=>({...model,...describeModel(model)})),taskDefaults:TASK_MODEL_DEFAULTS,entitlement:'No model inference was performed.'};
  }else if(command==='resolve'){
    const agent=values.agent?config.agents.find(item=>item.id===values.agent):undefined;
    if(values.agent&&!agent)throw new Error('Unknown configured agent.');
    const role=values.role?agent?.subagents?.roles.find(item=>item.id===values.role):undefined;
    if(values.role&&!role)throw new Error('Select an existing --agent and --role.');
    const choice:ModelChoice={...agent?.modelChoice,...role?.modelChoice,...(values.task?{task:values.task as TaskProfile}:{}),...(values.model?{model:values.model}:{}),...(values.thinking?{thinkingLevel:values.thinking as ModelThinkingLevel}:{})};
    result={selection:select(choice),catalog:{source:catalog.source,digest:catalog.digest,observedAt:catalog.observedAt,availability:catalog.availability},inferencePerformed:false};
  }else{
    if(!values.output)throw new Error('This command requires an explicit output file.');
    const output=resolve(project,values.output);
    if(dirname(output)!==project||output===configPath)throw new Error('Write a new sibling JSON file beside the input config so project-relative paths remain valid.');
    if(!output.endsWith('.json'))throw new Error('Output must be a JSON file.');
    if(command==='refresh'){
      await writeFile(output,JSON.stringify(catalog,null,2)+'\n',{flag:'wx',mode:0o600});
      result={catalog:output,source:catalog.source,observedAt:catalog.observedAt,digest:catalog.digest,availability:catalog.availability,inferencePerformed:false};
    }else{
      const raw=JSON.parse(await readFile(configPath,'utf8'));
      const pins:Array<{target:string;selection:ReturnType<typeof select>}>=[];
      const global=select({});const reflection=select(getReflectionModelChoice(config));
      raw.provider.model=global.model.modelId;raw.provider.thinkingLevel=global.thinkingLevel;
      raw.provider.reflection={model:reflection.model.modelId,task:'reflection',thinkingLevel:reflection.thinkingLevel};
      for(let index=0;index<config.agents.length;index++){
        const agent=config.agents[index],picked=select(agent.modelChoice??{});pins.push({target:agent.id,selection:picked});
        raw.agents[index].modelChoice={...agent.modelChoice,model:picked.model.modelId,thinkingLevel:picked.thinkingLevel};
        for(let roleIndex=0;roleIndex<(agent.subagents?.roles.length??0);roleIndex++){
          const role=agent.subagents!.roles[roleIndex],chosen=select({...agent.modelChoice,...role.modelChoice});
          raw.agents[index].subagents.roles[roleIndex].modelChoice={...role.modelChoice,model:chosen.model.modelId,thinkingLevel:chosen.thinkingLevel};pins.push({target:`${agent.id}/${role.id}`,selection:chosen});
        }
      }
      const snapshotPath=output.replace(/\.json$/,'.models.json');raw.provider.catalogFile=basename(snapshotPath);
      let written=false;try{await writeFile(snapshotPath,JSON.stringify(catalog,null,2)+'\n',{flag:'wx',mode:0o600});written=true;await writeFile(output,JSON.stringify(raw,null,2)+'\n',{flag:'wx',mode:0o600});}
      catch(error){if(written)await rm(snapshotPath,{force:true});throw error;}
      result={config:output,catalog:snapshotPath,catalogDigest:catalog.digest,selections:pins,reflection,sourceActivated:false,inferencePerformed:false};
    }
  }
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runModelsCommand(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:'Model operation failed.');process.exitCode=1;});
