// Generated console: npm test. Exercise paging before Pi's stock selector can overflow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { selectMenu } from '../src/menu-ui.js';

test('large inventories retain create/connect actions on every bounded page',async()=>{
  let pages=0;const create='+ Create new agent',connect='Reconnect managed project';
  const ctx:any={ui:{select:async(title:string,values:string[])=>{
    pages++;assert.ok(values.length<=9);assert.ok(values.includes(create)&&values.includes(connect));assert.match(title,/Inventory/);
    if(pages<4)return values.find(value=>value.startsWith('Next page'));
    return create;
  }}};
  const selected=await selectMenu(ctx,'Inventory',Array.from({length:30},(_,index)=>`agent-${index}/worker`),{pinned:[create,connect]});
  assert.equal(selected,create);assert.equal(pages,4);
});

test('bounded labels preserve the exact original identifier after selection',async()=>{
  const value='a-long-service-name/'.repeat(8)+'worker-進捗';
  const ctx:any={ui:{select:async(_title:string,choices:string[])=>{assert.ok(choices.every(choice=>visibleWidth(choice)<=Math.max(10,Math.min(100,(process.stdout.columns??48)-6))));return choices[0];}}};
  assert.equal(await selectMenu(ctx,'Choose',[value]),value);
});

test('paging cancellation and abort never select an unseen operation',async()=>{
  const controller=new AbortController();controller.abort();let called=0;
  const ctx:any={ui:{select:async()=>{called++;return undefined;}}};
  assert.equal(await selectMenu(ctx,'Choose',['Stop'],{signal:controller.signal}),undefined);assert.equal(called,0);
  assert.equal(await selectMenu(ctx,'Choose',['Stop']),undefined);assert.equal(called,1);
});
