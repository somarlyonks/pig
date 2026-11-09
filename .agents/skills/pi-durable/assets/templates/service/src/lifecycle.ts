// Build with npm run build. Persistent local admission controls; no model calls.
import { constants } from 'node:fs';
import { open,rename,rm,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const CONTROL='lifecycle-control.json';
/** Missing control state preserves the ordinary accepting startup behavior. */
export async function loadAdmissionPause(dataDir:string):Promise<boolean>{
  let handle;
  try{handle=await open(join(dataDir,CONTROL),constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NONBLOCK|constants.O_NOFOLLOW));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  try{
    if(!(await handle.stat()).isFile())throw new Error('Lifecycle control must be a bounded regular JSON file.');
    const buffer=Buffer.alloc(4097);let length=0;
    while(length<buffer.length){const next=await handle.read(buffer,length,buffer.length-length,null);if(!next.bytesRead)break;length+=next.bytesRead;}
    if(length>4096)throw new Error('Lifecycle control exceeds its 4 KiB limit.');
    const value=JSON.parse(buffer.subarray(0,length).toString('utf8'));
    if(!value||value.version!==1||typeof value.paused!=='boolean'||Object.keys(value).some(key=>!['version','paused'].includes(key)))throw new Error('Invalid persisted lifecycle control.');
    return value.paused;
  }finally{await handle.close();}
}
export async function saveAdmissionPause(dataDir:string,paused:boolean):Promise<void>{
  const temporary=join(dataDir,`.${CONTROL}.${randomUUID()}.tmp`);
  try{await writeFile(temporary,JSON.stringify({version:1,paused})+'\n',{flag:'wx',mode:0o600});await rename(temporary,join(dataDir,CONTROL));}
  finally{await rm(temporary,{force:true});}
}
