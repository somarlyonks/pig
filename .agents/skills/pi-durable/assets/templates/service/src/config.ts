// Build with npm run build; run through the generated CLI.
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelChoice } from './model-selection.js';
import { validateWorkspaceRoot } from './tools/workspace.js';

export interface SubagentRole {id:string;instructions:string;instructionsFile?:string;modelChoice?:ModelChoice}
export interface AgentConfig {
  id: string; name: string; instructions: string; instructionsFile?: string; repositories: string[];
  modelChoice?:ModelChoice; workspaceRoot?:string;
  subagents?:{roles:SubagentRole[];maxChildrenPerCall?:number;maxChildrenPerRun?:number;maxTaskChars?:number;maxResultChars?:number};
}
export interface ServiceConfig {
  version: 1; host: '127.0.0.1'; port: number; dataDir: string; serviceName?:string;
  provider: { kind: 'faux' | 'openai' | 'anthropic' | 'openai-codex'; model?: string; delayMs?: number; piCliPath?: string;
    thinkingLevel?:ModelThinkingLevel;reflection?:ModelChoice;catalogMode?:'refresh'|'pi-cache'|'bundled';catalogFile?:string };
  github: { mode: 'off' | 'poll' | 'webhook'; intervalMs: number; initialScan: 'baseline' | 'enqueue'; maxPages?:number };
  agents: AgentConfig[]; projectDir?: string;
}
const thinkingLevels:readonly ModelThinkingLevel[]=['off','minimal','low','medium','high','xhigh','max'];
const taskProfiles=['routine','coding','review','research','reflection'];
function modelName(value:unknown):boolean{return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\s\x00-\x1f\x7f]/.test(value)&&(!value.startsWith('latest')||['latest','latest:sol','latest:astra','latest:luna'].includes(value));}
export function validateModelChoice(value:unknown):asserts value is ModelChoice|undefined{
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('modelChoice must be an object containing model, task, or thinkingLevel.');
  const choice=value as ModelChoice;
  if(Object.keys(choice).some(key=>!['model','task','thinkingLevel'].includes(key))||choice.model!==undefined&&!modelName(choice.model)||choice.task!==undefined&&!taskProfiles.includes(choice.task)||choice.thinkingLevel!==undefined&&!thinkingLevels.includes(choice.thinkingLevel))throw new Error('Invalid modelChoice model, task profile, or thinking level.');
}
/** Dynamic selection must be frozen before a paired improvement study. */
export function hasDynamicModels(config:ServiceConfig):boolean{
  const names=[config.provider.model,config.provider.reflection?.model,...config.agents.flatMap(agent=>[agent.modelChoice?.model,...(agent.subagents?.roles.map(role=>role.modelChoice?.model)??[])])];
  return names.some(model=>model==='latest'||model?.startsWith('latest:'));
}
/** Reflection is a service-level policy; resident-agent overrides do not change it. */
export function getReflectionModelChoice(config:ServiceConfig):ModelChoice{return {task:'reflection',...config.provider.reflection};}
export async function loadConfig(path: string): Promise<ServiceConfig> {
  const projectDir = dirname(resolve(path));
  const loadPrompt=async (item:{instructions:string;instructionsFile?:string})=>{
    if (item.instructionsFile === undefined) return;
    if (typeof item.instructionsFile !== 'string' || !/^prompts\/[a-z0-9][a-z0-9_./-]*\.md$/i.test(item.instructionsFile) || item.instructionsFile.split('/').includes('..')) throw new Error('instructionsFile must be a project-relative Markdown file under prompts/.');
    const root=await realpath(projectDir),target=await realpath(resolve(projectDir,item.instructionsFile)),local=relative(root,target);
    if (isAbsolute(local) || local.startsWith('..') || !local.replaceAll('\\','/').startsWith('prompts/')) throw new Error('instructionsFile must stay inside this project prompts directory.');
    item.instructions=await readFile(target,'utf8');
    if(!item.instructions.trim())throw new Error('instructionsFile must not be empty.');
  };
  const value = JSON.parse(await readFile(path, 'utf8')) as ServiceConfig;
  if (value.version !== 1 || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('Expected config version 1, loopback host, and a valid port.');
  if (typeof value.dataDir !== 'string' || !value.dataDir) throw new Error('dataDir is required.');
  if(value.serviceName!==undefined&&!/^[a-z][a-z0-9-]{0,47}$/.test(value.serviceName))throw new Error('serviceName must be a lowercase service identity.');
  if (!['faux','openai','anthropic','openai-codex'].includes(value.provider?.kind) || (value.provider.kind !== 'faux' && !modelName(value.provider.model))) throw new Error('Select faux or a real provider with an exact model or supported latest policy.');
  if(value.provider.thinkingLevel!==undefined&&!thinkingLevels.includes(value.provider.thinkingLevel))throw new Error('Unsupported provider thinkingLevel.');
  validateModelChoice(value.provider.reflection);
  if(value.provider.catalogMode!==undefined&&!['refresh','pi-cache','bundled'].includes(value.provider.catalogMode))throw new Error('catalogMode must be refresh, pi-cache, or bundled.');
  if(value.provider.catalogFile!==undefined){
    const file=value.provider.catalogFile;
    if(typeof file!=='string'||!file.endsWith('.json')||isAbsolute(file)||file.includes('\\')||file.includes(':')||file.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('catalogFile must be an existing project-relative JSON file.');
    const root=await realpath(projectDir),target=await realpath(resolve(projectDir,file)),local=relative(root,target);
    if(isAbsolute(local)||local==='..'||local.startsWith('..\\')||local.startsWith('../'))throw new Error('catalogFile must remain inside the generated project.');
    JSON.parse(await readFile(target,'utf8'));
  }
  if(value.provider.kind==='openai-codex'){
    const piCliPath=value.provider.piCliPath??process.env.PI_CLI_PATH;
    if(typeof piCliPath!=='string'||!isAbsolute(piCliPath)||!/\.(?:mjs|cjs|js)$/i.test(piCliPath))throw new Error('The Codex bridge requires an absolute installed Pi CLI JavaScript path in provider.piCliPath or PI_CLI_PATH.');
  }
  if (value.provider.delayMs !== undefined && (value.provider.kind !== 'faux' || !Number.isFinite(value.provider.delayMs) || value.provider.delayMs < 0 || value.provider.delayMs > 30000)) throw new Error('delayMs is an optional offline demo delay from 0 to 30000 ms.');
  if (!['off','poll','webhook'].includes(value.github?.mode) || !Number.isFinite(value.github.intervalMs) || value.github.intervalMs < 1000 || !['baseline','enqueue'].includes(value.github.initialScan)) throw new Error('Invalid GitHub configuration.');
  if(value.github.maxPages!==undefined&&(!Number.isInteger(value.github.maxPages)||value.github.maxPages<1||value.github.maxPages>10000))throw new Error('maxPages must be an integer from 1 to 10000.');
  if (!Array.isArray(value.agents) || value.agents.length === 0) throw new Error('At least one named agent is required.');
  const names = new Set<string>();
  for (const agent of value.agents) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(agent.id) || names.has(agent.id) || typeof agent.name !== 'string' || !agent.name || typeof agent.instructions !== 'string' || !Array.isArray(agent.repositories) || agent.repositories.some(r => typeof r !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(r))) throw new Error('Agent IDs must be unique lowercase names and repositories must use owner/name.');
    names.add(agent.id); agent.repositories = [...new Set(agent.repositories.map(r => r.toLowerCase()))];
    validateModelChoice(agent.modelChoice);
    if(agent.workspaceRoot!==undefined)agent.workspaceRoot=await validateWorkspaceRoot(agent.workspaceRoot);
    await loadPrompt(agent);
    if(agent.subagents!==undefined){
      const settings=agent.subagents;
      if(!settings||!Array.isArray(settings.roles)||settings.roles.length<1||settings.roles.length>8)throw new Error('subagents requires from 1 to 8 explicit specialist roles.');
      const roles=new Set<string>();
      for(const role of settings.roles){
        if(!role||!(/^[a-z][a-z0-9-]{0,47}$/).test(role.id)||roles.has(role.id)||typeof role.instructions!=='string')throw new Error('Subagent roles require unique lowercase IDs and explicit instructions.');
        roles.add(role.id);await loadPrompt(role);if(!role.instructions.trim())throw new Error('Subagent instructions must not be empty.');
        validateModelChoice(role.modelChoice);
      }
      for(const [key,minimum,maximum] of [['maxChildrenPerCall',1,8],['maxChildrenPerRun',1,32],['maxTaskChars',128,24000],['maxResultChars',256,48000]] as const){
        const limit=settings[key];if(limit!==undefined&&(!Number.isInteger(limit)||limit<minimum||limit>maximum))throw new Error(`subagents.${key} must be an integer from ${minimum} to ${maximum}.`);
      }
    }
  }
  value.dataDir = resolve(dirname(resolve(path)), value.dataDir);
  Object.defineProperty(value, 'projectDir', { value: projectDir, enumerable: false });
  return value;
}
export async function loadServiceEnvironment(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  let content: string;
  try { content = await readFile(resolve(dataDir, 'environment.env'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (!['GITHUB_TOKEN','GITHUB_WEBHOOK_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY'].includes(name)) throw new Error(`Unsupported service environment variable: ${name}`);
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
