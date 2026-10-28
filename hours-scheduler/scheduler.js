import { researchOpen } from './clock.js';
import { pathToFileURL } from 'node:url';

const projectId='a25947de-95ab-4852-bb8b-82ac2d962d2a';
const environmentId='49b5b59d-733a-4d13-ac67-07680a38d885';
const token=process.env.RAILWAY_PROJECT_TOKEN;
const targets=[
  {name:'SearXNG',id:'af1dd983-66dd-4018-ad20-6d82c4edb574',health:'http://searxng.railway.internal:8080/'},
  {name:'Crawl4AI',id:'a9fb5e37-7115-4b5a-9a2f-1707d098101e',health:'http://crawl4ai.railway.internal:11235/health'},
  {name:'Gateway',id:'1af72fca-0d6f-4975-9f70-9ba99c1fb5bf',health:'http://web-mcp-gateway.railway.internal:8080/health'}
];
const log=value=>console.log(JSON.stringify(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(query,variables={}) {
  const response=await fetch('https://backboard.railway.com/graphql/v2',{
    method:'POST',headers:{'Content-Type':'application/json','Project-Access-Token':token},
    body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)throw Error(`Railway API HTTP ${response.status}`);
  const result=await response.json();
  if(result.errors?.length||!result.data)throw Error('Railway rejected scheduler operation');
  return result.data;
}
export function createController({request=api,fetchFn=fetch,pauseFn=pause,logger=log,configuredTargets=targets,attempts=20}={}) {
  const stable=new Set(['SUCCESS','SLEEPING','CRASHED']);
  async function probe(target) {
    try {
      const response=await fetchFn(target.health,{signal:AbortSignal.timeout(3000),redirect:'error'});
      const observation={responded:true,healthy:response.ok,status:response.status};
      // Closing a response body must not turn an observed HTTP response into a
      // connection failure: even HTTP 500 proves a server is still responding.
      try{await response.body?.cancel();}catch{}
      return observation;
    }catch{return {responded:false,healthy:false};}
  }
  async function verify(target,expected) {
    let consecutive=0;
    for(let n=0;n<attempts;n++) {
      const observation=await probe(target);
      const matches=expected?observation.healthy:!observation.responded;
      if(matches)consecutive++;else consecutive=0;
      if(consecutive>=2){logger({service:target.name,event:'verified',reachable:expected});return;}
      if(n+1<attempts)await pauseFn(2000);
    }
    throw Error(`${target.name} did not become ${expected?'healthy':'unreachable'}`);
  }
  async function resolveTargets() {
    const resolved=[];
    for(const target of configuredTargets){
      try {
        const result=await request('query List($input:DeploymentListInput!) { deployments(input:$input,first:10) { edges { node { id status } } } }',{
          input:{projectId,environmentId,serviceId:target.id}
        });
        // A newer failed/building attempt can coexist with an older live build.
        // The API returns newest first; stop every stable overlap, start only
        // the most recent stable build, and never revive removed history.
        const deployments=result.deployments?.edges?.map(edge=>edge.node).filter(deployment=>stable.has(deployment.status));
        if(!deployments?.length)throw Error(`${target.name} has no stable deployment to control`);
        resolved.push({...target,deployments});
      }catch(error){resolved.push({...target,deployments:[],resolutionError:error.message});}
    }
    return resolved;
  }
  async function operate(action,resolved) {
    if(!['start','stop'].includes(action))throw Error('Invalid scheduler operation');
    const stop=action==='stop';
    const ordered=stop?[...resolved].reverse():resolved;
    const errors=[];
    const recordError=(target,error)=>{errors.push(error);logger({service:target.name,event:'error',message:error.message});};
    for(const target of ordered){
      if(target.resolutionError){recordError(target,Error(target.resolutionError));continue;}
      const selected=stop?target.deployments:target.deployments.slice(0,1);
      const field=stop?'deploymentStop':'deploymentRestart';
      for(const deployment of selected){
        try {
          const result=await request(`mutation Action($id:String!) { ${field}(id:$id) }`,{id:deployment.id});
          if(result[field]!==true)throw Error('Railway did not accept operation');
          logger({service:target.name,event:action,accepted:true});
        }catch(error){recordError(target,error);}
      }
      try{await verify(target,!stop);}catch(error){recordError(target,error);}
    }
    if(errors.length)throw new AggregateError(errors,`${errors.length} scheduler operation(s) failed`);
  }
  async function testCycle(resolved) {
    for(const target of resolved){
      if(target.resolutionError)throw Error(target.resolutionError);
      if(!(await probe(target)).healthy)throw Error(`${target.name} failed baseline; test cancelled`);
    }
    try{await operate('stop',resolved);logger({event:'full-stop-verified'});}
    finally{await operate('start',resolved);logger({event:'full-restoration-verified'});}
  }
  async function reconcile(action,resolved) {
    if(!['start','stop'].includes(action))throw Error('Invalid scheduler operation');
    const stop=action==='stop';
    const ordered=stop?[...resolved].reverse():resolved;
    const errors=[];
    for(const target of ordered){
      try{
        if(target.resolutionError)throw Error(target.resolutionError);
        const observation=await probe(target);
        if(!stop&&observation.healthy){logger({service:target.name,event:'already',action});continue;}
        if(stop&&!observation.responded){
          await verify(target,false);
          logger({service:target.name,event:'already',action});
          continue;
        }
        await operate(action,[target]);
      }catch(error){errors.push(error);logger({service:target.name,event:'error',message:error.message});}
    }
    if(errors.length)throw new AggregateError(errors,`${errors.length} service reconciliation(s) failed`);
  }
  return {probe,verify,resolveTargets,operate,reconcile,testCycle};
}
async function main(){
  if(!token)throw Error('Scheduler project token is missing');
  const scope=await api('query { projectToken { projectId environmentId } }');
  if(scope.projectToken?.projectId!==projectId||scope.projectToken?.environmentId!==environmentId)throw Error('Scheduler token scope mismatch');
  const action=researchOpen(new Date())?'start':'stop';
  const testDeadline=Number(process.env.TEST_CYCLE_UNTIL || 0);
  // Test authorization expires even if the orchestration is interrupted.
  const testCycle=testDeadline>Date.now() && testDeadline-Date.now()<=15*60*1000;
  log({event:'schedule',timeZone:'America/New_York',action,testCycle});
  const controller=createController();
  const resolved=await controller.resolveTargets();
  if(testCycle)await controller.testCycle(resolved);
  else await controller.reconcile(action,resolved);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().then(
    ()=>process.stdout.write(JSON.stringify({event:'complete'})+'\n',()=>process.exit(0)),
    error=>process.stderr.write(error.message+'\n',()=>process.exit(1))
  );
