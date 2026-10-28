import { boundaryAction } from './clock.js';

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
async function reachable(target) {
  try {return (await fetch(target.health,{signal:AbortSignal.timeout(3000),redirect:'error'})).ok;}
  catch{return false;}
}
async function verify(target,expected) {
  // Require two consecutive observations to reduce transient false results.
  let consecutive=0;
  for(let n=0;n<20;n++) {
    if(await reachable(target)===expected)consecutive++;else consecutive=0;
    if(consecutive>=2){log({service:target.name,event:'verified',reachable:expected});return;}
    await pause(2000);
  }
  throw Error(`${target.name} did not become ${expected?'reachable':'unreachable'}`);
}
async function resolveTargets() {
  const resolved=[];
  for(const target of targets){
    const result=await api('query List($input:DeploymentListInput!) { deployments(input:$input,first:1) { edges { node { id status } } } }',{
      input:{projectId,environmentId,serviceId:target.id}
    });
    const deployment=result.deployments?.edges?.[0]?.node;
    if(!deployment||!['SUCCESS','SLEEPING','CRASHED'].includes(deployment.status))throw Error(`${target.name} has no stable deployment to control`);
    resolved.push({...target,deployment:deployment.id});
  }
  return resolved;
}
async function operate(action,resolved) {
  const ordered=action==='stop'?[...resolved].reverse():resolved;
  const errors=[];
  for(const target of ordered){
    try {
      const stop=action==='stop';
      const field=stop?'deploymentStop':'deploymentRestart';
      const result=await api(`mutation Action($id:String!) { ${field}(id:$id) }`,{id:target.deployment});
      if(result[field]!==true)throw Error('Railway did not accept operation');
      log({service:target.name,event:action,accepted:true});
      await verify(target,!stop);
    }catch(error){errors.push(error);log({service:target.name,event:'error',message:error.message});}
  }
  if(errors.length)throw Error(`${errors.length} service operation(s) failed`);
}
async function main(){
  if(!token)throw Error('Scheduler project token is missing');
  const scope=await api('query { projectToken { projectId environmentId } }');
  if(scope.projectToken?.projectId!==projectId||scope.projectToken?.environmentId!==environmentId)throw Error('Scheduler token scope mismatch');
  const action=boundaryAction(new Date());
  const testDeadline=Number(process.env.TEST_CYCLE_UNTIL || 0);
  // Test authorization expires even if the orchestration is interrupted.
  const testCycle=testDeadline>Date.now() && testDeadline-Date.now()<=15*60*1000;
  log({event:'schedule',timeZone:'America/New_York',action,testCycle});
  if(!action&&!testCycle)return;
  const resolved=await resolveTargets();
  if(testCycle){
    for(const target of resolved)if(!await reachable(target))throw Error(`${target.name} failed baseline; test cancelled`);
    try{await operate('stop',resolved);log({event:'full-stop-verified'});}
    finally{await operate('start',resolved);log({event:'full-restoration-verified'});}
  }else await operate(action,resolved);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
