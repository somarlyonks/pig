#!/usr/bin/env node
// Copied to the generated service's src/console; run node dist/src/console/control-cli.js <action>.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveManaged, connectionFromManagedConfig, inspectManaged, pauseManaged,
  manageLoginStartup,type LoginStartupAction,
  readManagedLogs, recoverManaged, restartManaged, restoreManaged, resumeManaged,
  startManaged, stopManaged,
} from './agent-management.js';

async function main(){
  const args=process.argv.slice(2),action=args[0]??'help';
  if(action==='help'||action==='--help'){
    console.log('Independent agent lifecycle: status, start, stop, restart, recover, pause, resume, logs, login-startup <plan|install|status|uninstall>, archive --registry <connections.json>, restore --registry <connections.json>. Optional --drain-ms <0..60000>. Source, state and logs are preserved on archive.');return;
  }
  const project=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const configPath=resolve(project,'config.json'),connection=await connectionFromManagedConfig(configPath);
  const flag=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const drain=flag('--drain-ms');if(drain!==undefined&&(!/^\d+$/.test(drain)||Number(drain)>60000))throw new Error('Use a drain timeout from 0 to 60000 milliseconds.');
  let result:unknown;
  if(action==='status')result=await inspectManaged(connection);
  else if(action==='start')result=await startManaged(connection);
  else if(action==='recover')result=await recoverManaged(connection);
  else if(action==='stop')result=await stopManaged(connection,{...(drain!==undefined?{drainTimeoutMs:Number(drain)}:{})});
  else if(action==='restart')result=await restartManaged(connection,{...(drain!==undefined?{drainTimeoutMs:Number(drain)}:{})});
  else if(action==='pause')result=await pauseManaged(connection);
  else if(action==='resume')result=await resumeManaged(connection);
  else if(action==='logs')result=await readManagedLogs(connection);
  else if(action==='login-startup')result=await manageLoginStartup(connection,(args[1]??'plan') as LoginStartupAction);
  else if(action==='archive'||action==='restore'){
    const registry=flag('--registry');if(!registry)throw new Error('Choose the exact console registry with --registry.');
    result=action==='archive'?await archiveManaged(connection,{connectionsFile:resolve(registry)}):await restoreManaged(configPath,{connectionsFile:resolve(registry)});
  }else throw new Error('Unknown lifecycle action. Run help.');
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'The lifecycle action failed.');process.exitCode=1;});
