// Generated project: npm test. Owned session cleanup uses the pinned SDK without network or real generation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxProvider, registerSessionResourceCleanup, type Provider } from '@earendil-works/pi-ai';
import { ownProviderSessions } from '../src/model-runtime.js';

function provider(){const base=fauxProvider({tokensPerSecond:Infinity});const stream=()=>({result:async()=>({})});return {model:base.getModel(),value:{...base.provider,stream,streamSimple:stream} as unknown as Provider};}
test('closing one provider disposes only its exact sessions and leaves another owner usable',()=>{
  const fixture=provider(),calls:Array<string|undefined>=[],active=new Set<string>();const unregister=registerSessionResourceCleanup(id=>{calls.push(id);if(id)active.delete(id);});
  const first=ownProviderSessions(fixture.value),second=ownProviderSessions(fixture.value);
  try{
    const a=crypto.randomUUID(),b=crypto.randomUUID();active.add(a);active.add(b);
    first.provider.streamSimple(fixture.model,{messages:[]},{sessionId:a});second.provider.streamSimple(fixture.model,{messages:[]},{sessionId:b});first.dispose();
    assert.deepEqual(calls,[a]);assert.equal(active.has(a),false);assert.equal(active.has(b),true);
    const c=crypto.randomUUID();active.add(c);second.provider.stream(fixture.model,{messages:[]},{sessionId:c});assert.equal(active.has(c),true);second.dispose();assert.deepEqual(new Set(calls),new Set([a,b,c]));assert.equal(active.size,0);
  }finally{first.dispose();second.dispose();unregister();}
});
test('a shared session stays alive until the last observed provider owner closes',()=>{
  const fixture=provider(),calls:Array<string|undefined>=[],id=crypto.randomUUID(),unregister=registerSessionResourceCleanup(session=>calls.push(session));
  const first=ownProviderSessions(fixture.value),second=ownProviderSessions(fixture.value);
  try{first.provider.streamSimple(fixture.model,{messages:[]},{sessionId:id});second.provider.streamSimple(fixture.model,{messages:[]},{sessionId:id});first.dispose();assert.equal(calls.length,0);second.dispose();assert.deepEqual(calls,[id]);}finally{first.dispose();second.dispose();unregister();}
});
test('providers without a session never invoke global cleanup and disposal is idempotent',()=>{
  const fixture=provider(),calls:Array<string|undefined>=[],unregister=registerSessionResourceCleanup(id=>calls.push(id)),owned=ownProviderSessions(fixture.value);
  try{owned.provider.streamSimple(fixture.model,{messages:[]});owned.dispose();owned.dispose();assert.deepEqual(calls,[]);assert.throws(()=>owned.provider.streamSimple(fixture.model,{messages:[]},{sessionId:crypto.randomUUID()}),/owner is closed/);}finally{unregister();}
});
test('one cleanup failure does not skip other owned sessions',()=>{
  const fixture=provider(),calls:Array<string|undefined>=[],bad=crypto.randomUUID(),good=crypto.randomUUID(),unregister=registerSessionResourceCleanup(id=>{calls.push(id);if(id===bad)throw new Error('Fixture cleanup failure.');}),owned=ownProviderSessions(fixture.value);
  try{owned.provider.streamSimple(fixture.model,{messages:[]},{sessionId:bad});owned.provider.streamSimple(fixture.model,{messages:[]},{sessionId:good});assert.throws(()=>owned.dispose(),AggregateError);assert.deepEqual(calls,[bad,good]);assert.doesNotThrow(()=>owned.dispose());}finally{unregister();}
});
