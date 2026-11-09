#!/usr/bin/env node
// npm run build; npm start -- <command> --config config.json
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { AgentService } from './server.js';
import { runServiceAction, type ServiceAction } from './service-manager.js';

function option(args:string[],key:string){const index=args.indexOf(key);return index<0?undefined:args[index+1];}
async function main(){const args=process.argv.slice(2);const command=args[0]??'help';if(command==='help'){console.log('Commands: models <list|refresh|resolve|lock>, serve, list, jobs <agent>, traces <agent> [--output file], feedback <agent> --message <summary> [--evidence id,id], chat <agent> [--job <id>] [--message <text>] [--steer], abort <agent> [--job <id>], service <install|start|stop|status|uninstall> [--options local-options.json] [--platform win32|darwin] [--execute] [--output file]. Every command accepts --config file. Cross-platform plans should use JSON --options to preserve target paths.');return;}
  if(command==='models'){await(await import('./models-cli.js')).runModelsCommand(args.slice(1));return;}
  const configPath=resolve(option(args,'--config')??'config.json');const config=await loadConfig(configPath);
  if(command==='serve'){const service=await AgentService.open(config);console.log(JSON.stringify({status:'listening',url:service.url,agents:config.agents.map(a=>a.id),provider:config.provider.kind}));await new Promise<void>(resolve=>{let closing=false;const stop=()=>{if(closing)return;closing=true;void service.close().then(resolve,error=>{console.error(error.message);process.exitCode=1;resolve();});};process.once('SIGINT',stop);process.once('SIGTERM',stop);void service.closed.then(()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);resolve();});});process.exit(process.exitCode??0);return;}
  if(command==='service'){
    const action=args[1] as ServiceAction;if(!['install','start','stop','status','uninstall'].includes(action))throw new Error('Choose a service action.');
    const platform=option(args,'--platform')??process.platform;if(platform!=='win32'&&platform!=='darwin')throw new Error('Native service plans target win32 or darwin.');
    const optionsFile=option(args,'--options');
    const supplied=optionsFile?JSON.parse(await readFile(optionsFile,'utf8')) as Record<string,unknown>:{};
    const selected={platform,projectDir:option(args,'--project')??resolve(dirname(fileURLToPath(import.meta.url)),'../..'),configPath:option(args,'--target-config')??configPath,dataDir:option(args,'--state-dir')??config.dataDir,nodePath:option(args,'--node')??process.execPath,serviceName:option(args,'--name')??config.serviceName,homeDir:option(args,'--home'),userId:option(args,'--uid')?Number(option(args,'--uid')):undefined,...supplied};
    if(selected.platform!=='win32'&&selected.platform!=='darwin')throw new Error('Options platform must be win32 or darwin.');
    const executing=args.includes('--execute');
    if(executing&&(resolve(String(selected.configPath))!==configPath||resolve(String(selected.dataDir))!==config.dataDir||(config.serviceName??'pi-agent-service')!==(selected.serviceName??'pi-agent-service')))throw new Error('Apply deploymentConfig to the target config and use that --config before native execution.');
    const result=await runServiceAction(action,{...selected,execute:executing} as Parameters<typeof runServiceAction>[1]);
    const outputResult={...result,deploymentConfig:{...config,dataDir:selected.dataDir,serviceName:result.plan.serviceName}};
    const output=option(args,'--output');if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(outputResult,null,2)+'\n');}else console.log(JSON.stringify(outputResult,null,2));return;
  }
  const token=(await readFile(join(config.dataDir,'console-token'),'utf8')).trim();const base=`http://127.0.0.1:${config.port}`;
  async function call(path:string,body?:unknown){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json() as any;if(!response.ok)throw new Error(value.error??`HTTP ${response.status}`);return value;}
  if(command==='list'){console.log(JSON.stringify(await call('/v1/agents'),null,2));return;}
  const agent=args[1];if(!agent||!config.agents.some(a=>a.id===agent))throw new Error('Specify an active agent ID from config.json.');
  const prefix=`/v1/agents/${agent}`;const suffix=option(args,'--job')?`?jobId=${encodeURIComponent(option(args,'--job')!)}`:'';
  if(command==='jobs'){console.log(JSON.stringify(await call(prefix+'/jobs'),null,2));return;}
  if(command==='traces'){const value=await call(prefix+'/evidence');const output=option(args,'--output');if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(resolve(output),JSON.stringify(value,null,2)+'\n',{mode:0o600});}else console.log(JSON.stringify(value,null,2));return;}
  if(command==='feedback'){const summary=option(args,'--message');if(!summary)throw new Error('Provide feedback with --message.');console.log(JSON.stringify(await call(prefix+'/feedback'+suffix,{summary,evidenceIds:(option(args,'--evidence')??'').split(',').filter(Boolean)})));return;}
  if(command==='abort'){console.log(JSON.stringify(await call(prefix+'/abort'+suffix,{})));return;}
  if(command!=='chat')throw new Error('Unknown command. Run help.');
  const snapshot=await call(prefix+'/chat'+suffix);console.log(`Connected to ${agent}, conversation ${snapshot.conversation.id}.`);
  for(const entry of snapshot.entries)for(const message of entry.model??[])if(message.role==='user'||message.role==='assistant'){const text=typeof message.content==='string'?message.content:message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');if(text)console.log(`${message.role}: ${text}`);}
  async function send(content:string){const receipt=await call(prefix+'/messages'+suffix,{content,requestId:option(args,'--request-id')??randomUUID(),whenBusy:args.includes('--steer')?'steer':'followUp'});console.log(`Submission ${receipt.submissionId} admitted.`);while(true){const record=await call(prefix+`/submissions/${receipt.submissionId}`);if(record.status==='done'){console.log(record.text??'Completed without final prose.');return;}if(record.status==='unanswered')throw new Error(`Unanswered: ${record.reason}`);await new Promise(resolve=>setTimeout(resolve,250));}}
  const message=option(args,'--message');if(message){await send(message);return;}
  const input=createInterface({input:stdin,output:stdout});try{while(true){const text=await input.question('you> ');if(text==='/exit')break;if(text.trim())await send(text);}}finally{input.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
