const token = process.env.RAILWAY_PROJECT_TOKEN;
if (!token) throw new Error('Project token is missing');
async function api(query, variables = {}) {
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST', headers: {'Content-Type':'application/json','Project-Access-Token':token},
    body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(e=>e.message).join('; '));
  return result.data;
}
try {
  const scope = await api('query { projectToken { projectId environmentId } }');
  console.log(JSON.stringify({scope:scope.projectToken}));
  for (const name of ['Deployment','DeploymentInstance','DeploymentInstanceStatus']) {
    const data = await api('query Inspect($name:String!) { __type(name:$name) { name fields { name type { kind name ofType { kind name ofType { kind name } } } } enumValues { name } } }', {name});
    const type = data.__type;
    console.log(JSON.stringify({type:name, fields:type?.fields?.filter(f=>/instance|replica|status|stop|region|id/i.test(f.name)), enumValues:type?.enumValues}));
  }
} catch(error) { console.error(error.message); process.exitCode=1; }
