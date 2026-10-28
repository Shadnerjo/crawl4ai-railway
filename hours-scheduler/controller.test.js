import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './scheduler.js';

const target=(id,name=id)=>({id,name,health:`http://${id}.example/health`});
const response=status=>({ok:status>=200&&status<300,status});
const unavailable=async()=>{throw Error('connection refused');};
const quiet={logger:()=>{},pauseFn:async()=>{},attempts:2};
const listed=nodes=>({deployments:{edges:nodes.map(node=>({node}))}});

test('an HTTP 500 or 503 never satisfies shutdown verification', async()=>{
  for(const status of [500,503]){
    const controller=createController({...quiet,fetchFn:async()=>response(status)});
    assert.deepEqual(await controller.probe(target('a')),{responded:true,healthy:false,status});
    await assert.rejects(controller.verify(target('a'),false),/did not become unreachable/);
    await assert.rejects(controller.verify(target('a'),true),/did not become healthy/);
  }
});

test('shutdown requires two consecutive connection failures and startup requires successful responses', async()=>{
  const observations=[null,500,null,null];
  let calls=0;
  const controller=createController({...quiet,attempts:4,fetchFn:async()=>{calls++;const status=observations.shift();if(status===null)throw Error('refused');return response(status);}});
  await controller.verify(target('a'),false);
  assert.equal(calls,4);
  await createController({...quiet,fetchFn:async()=>response(200)}).verify(target('a'),true);
});

test('resolution retains older stable live builds and excludes failed, building and removed attempts', async()=>{
  const controller=createController({...quiet,configuredTargets:[target('a')],request:async(query,variables)=>{
    assert.match(query,/first:10/);
    assert.equal(variables.input.serviceId,'a');
    return listed([{id:'building',status:'BUILDING'},{id:'failed',status:'FAILED'},{id:'live-new',status:'SUCCESS'},{id:'live-old',status:'SUCCESS'},{id:'removed',status:'REMOVED'}]);
  }});
  const resolved=await controller.resolveTargets();
  assert.deepEqual(resolved[0].deployments.map(d=>d.id),['live-new','live-old']);
});

test('a lookup failure does not stop other services from being shut down', async()=>{
  const stopped=[];
  const controller=createController({...quiet,configuredTargets:[target('a'),target('b'),target('c')],fetchFn:unavailable,request:async(query,variables)=>{
    if(query.startsWith('query')){
      if(variables.input.serviceId==='b')throw Error('lookup failed');
      return listed([{id:variables.input.serviceId+'-live',status:'SUCCESS'}]);
    }
    stopped.push(variables.id);return {deploymentStop:true};
  }});
  const resolved=await controller.resolveTargets();
  await assert.rejects(controller.operate('stop',resolved),AggregateError);
  assert.deepEqual(stopped,['c-live','a-live']);
});

test('shutdown attempts every stable overlap but startup restarts only the latest stable build', async()=>{
  const calls=[];
  let starting=false;
  const controller=createController({...quiet,fetchFn:async()=>{if(!starting)throw Error('refused');return response(200);},request:async(query,variables)=>{
    calls.push([query.includes('deploymentStop')?'stop':'start',variables.id]);
    return query.includes('deploymentStop')?{deploymentStop:true}:{deploymentRestart:true};
  }});
  const resolved=[{...target('a'),deployments:[{id:'new',status:'SUCCESS'},{id:'old',status:'SUCCESS'}]}];
  await controller.operate('stop',resolved);
  starting=true;
  await controller.operate('start',resolved);
  assert.deepEqual(calls,[['stop','new'],['stop','old'],['start','new']]);
});

test('one rejected overlap shutdown does not prevent the remaining builds from being stopped', async()=>{
  const calls=[];
  const controller=createController({...quiet,fetchFn:unavailable,request:async(_query,variables)=>{calls.push(variables.id);if(variables.id==='new')throw Error('rejected');return {deploymentStop:true};}});
  await assert.rejects(controller.operate('stop',[{...target('a'),deployments:[{id:'new'},{id:'old'}]}]),AggregateError);
  assert.deepEqual(calls,['new','old']);
});

test('test-cycle restoration runs even when stopping a service fails', async()=>{
  const calls=[];
  let baseline=true;
  let stopped=false;
  const controller=createController({...quiet,fetchFn:async()=>{if(!baseline&&stopped)throw Error('refused');return response(200);},request:async(query,variables)=>{
    baseline=false;
    if(query.includes('deploymentStop')){calls.push('stop');stopped=true;return {deploymentStop:false};}
    calls.push('start');stopped=false;return {deploymentRestart:true};
  }});
  await assert.rejects(controller.testCycle([{...target('a'),deployments:[{id:'live'}]}]),AggregateError);
  assert.deepEqual(calls,['stop','start']);
});

test('open reconciliation does not restart services that are already healthy',async()=>{
  const calls=[];
  const observations=[];
  const controller=createController({...quiet,logger:entry=>observations.push(entry),fetchFn:async()=>response(200),request:async()=>{calls.push('mutation');throw Error('unexpected mutation');}});
  await controller.reconcile('start',[{...target('a'),deployments:[{id:'live'}]}]);
  assert.deepEqual(calls,[]);
  assert.ok(observations.some(entry=>entry.event==='already'&&entry.action==='start'));
});

test('closed reconciliation verifies offline services without sending more stop mutations',async()=>{
  let probes=0;
  const calls=[];
  const controller=createController({...quiet,fetchFn:async()=>{probes++;throw Error('refused');},request:async()=>{calls.push('mutation');throw Error('unexpected mutation');}});
  await controller.reconcile('stop',[{...target('a'),deployments:[{id:'live'}]}]);
  assert.equal(probes,3); // Initial observation plus two consecutive verification probes.
  assert.deepEqual(calls,[]);
});

test('a responding HTTP 500 triggers stop reconciliation rather than being considered offline',async()=>{
  const calls=[];
  let stopped=false;
  const controller=createController({...quiet,fetchFn:async()=>{if(stopped)throw Error('refused');return response(500);},request:async(query,variables)=>{assert.match(query,/deploymentStop/);calls.push(variables.id);stopped=true;return {deploymentStop:true};}});
  await controller.reconcile('stop',[{...target('a'),deployments:[{id:'live'}]}]);
  assert.deepEqual(calls,['live']);
});

test('reconciliation preserves dependency order and continues after one service fails',async()=>{
  const started=[];
  const healthy=new Set();
  const controller=createController({...quiet,fetchFn:async url=>{const id=new URL(url).hostname.split('.')[0];if(!healthy.has(id))throw Error('refused');return response(200);},request:async(_query,variables)=>{started.push(variables.id);healthy.add(variables.id);return {deploymentRestart:true};}});
  const resolved=[{...target('a'),deployments:[{id:'a'}]},{...target('b'),resolutionError:'lookup failed',deployments:[]},{...target('c'),deployments:[{id:'c'}]}];
  await assert.rejects(controller.reconcile('start',resolved),AggregateError);
  assert.deepEqual(started,['a','c']);
});
