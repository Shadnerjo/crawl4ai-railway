// One controlled test: always attempt to restore SearXNG before exiting.
const token = process.env.RAILWAY_PROJECT_TOKEN;
const deploymentId = 'd4eb987a-6dee-499e-8cb6-ba887d155950';
async function api(query, variables = {}) {
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method:'POST', headers:{'Content-Type':'application/json','Project-Access-Token':token},
    body:JSON.stringify({query,variables}), signal:AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) throw new Error('Railway rejected stop/restart operation');
  return result.data;
}
async function reachable() {
  try { return (await fetch('http://searxng.railway.internal:8080/', {signal:AbortSignal.timeout(3000)})).ok; }
  catch { return false; }
}
async function waitFor(expected, attempts) {
  for (let n=0;n<attempts;n++) {
    if (await reachable() === expected) return true;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  return false;
}
let stopAttempted=false;
try {
  const scope = await api('query { projectToken { projectId environmentId } }');
  if (scope.projectToken?.projectId !== 'a25947de-95ab-4852-bb8b-82ac2d962d2a' || scope.projectToken?.environmentId !== '49b5b59d-733a-4d13-ac67-07680a38d885') throw new Error('Wrong credential scope');
  if (!await reachable()) throw new Error('Search baseline failed; stop test cancelled');
  console.log(JSON.stringify({test:'baseline',reachable:true}));
  stopAttempted=true;
  const stopped=await api('mutation Stop($id:String!) { deploymentStop(id:$id) }',{id:deploymentId});
  console.log(JSON.stringify({test:'stop-api',accepted:stopped.deploymentStop}));
  const unavailable=await waitFor(false,12);
  console.log(JSON.stringify({test:'stopped-http',unavailable}));
  if (!unavailable) process.exitCode=1;
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {
  if (stopAttempted) {
    try {
      const result=await api('mutation Restart($id:String!) { deploymentRestart(id:$id) }',{id:deploymentId});
      console.log(JSON.stringify({test:'restart-api',accepted:result.deploymentRestart}));
      const restored=await waitFor(true,24);
      console.log(JSON.stringify({test:'restored-http',reachable:restored}));
      if (!restored) process.exitCode=1;
    } catch {console.error('Restoration requires manual attention');process.exitCode=1;}
  }
}
