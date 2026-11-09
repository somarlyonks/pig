// Native Pi selectors are not height-bounded in older hosts. Page before rendering.
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { safeText } from './display.js';

export async function selectMenu(ctx:ExtensionCommandContext,title:string,choices:string[],options:{signal?:AbortSignal;pinned?:string[]}={}):Promise<string|undefined>{
  const pinned=options.pinned??[],size=4;
  const pages=Math.max(1,Math.ceil(choices.length/size));let page=0;
  while(!options.signal?.aborted){
    const visible=choices.slice(page*size,(page+1)*size),rows=[...visible,...pinned];
    const next='Next page →',previous='← Previous page';
    if(page>0)rows.push(previous);if(page+1<pages)rows.push(next);
    const width=Math.max(10,Math.min(100,(process.stdout.columns??48)-6));
    const labels=new Map<string,string>();
    for(const [index,value] of rows.entries()){
      let label=truncateToWidth(safeText(value,1024).replace(/[\r\n]/g,' '),width,'…');
      if(labels.has(label))label=truncateToWidth(`${index+1}. ${safeText(value,1024)}`,width,'…');
      labels.set(label,value);
    }
    const selected=await ctx.ui.select(`${title}${pages>1?` · ${page+1}/${pages}`:''}`,[...labels.keys()],{signal:options.signal});
    if(selected===undefined||options.signal?.aborted)return;
    const value=labels.get(selected);if(value===next){page++;continue;}if(value===previous){page--;continue;}
    return value;
  }
}
