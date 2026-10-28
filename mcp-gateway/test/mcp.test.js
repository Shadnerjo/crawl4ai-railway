import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

test('MCP authentication, discovery and failure handling', async t => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], { env: { PATH: process.env.PATH, PORT: String(port), MCP_STATIC_TOKEN: 'test-only-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let started = false;
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(base + '/health')).ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(started, true, 'server started');
  const send = (body, auth) => fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  assert.equal((await send(list)).status, 401);
  assert.equal((await send(list, 'Bearer wrong')).status, 401);
  const init = await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, 'Bearer test-only-token');
  assert.equal(init.status, 200);
  assert.ok((await init.json()).result.serverInfo);
  const response = await send(list, 'Bearer test-only-token');
  const tools = (await response.json()).result.tools.map(tool => tool.name);
  assert.deepEqual(tools.sort(), ['scrape_web', 'search_web']);
  const missingSearch = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'example' } } }, 'Bearer test-only-token');
  assert.equal((await missingSearch.json()).result.isError, true);
});

test('OAuth JWTs require correct signature, issuer, audience, subject and scope', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keys = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  keys.listen(0, '127.0.0.1');
  await once(keys, 'listening');
  t.after(() => keys.close());
  const issuer = `http://127.0.0.1:${keys.address().port}/`;
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const resource = `http://127.0.0.1:${port}/mcp`;
  const child = spawn(process.execPath, ['src/server.js'], { env: { PATH: process.env.PATH, PORT: String(port), OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: resource, OAUTH_ALLOWED_SUBJECT: 'owner', OAUTH_REQUIRED_SCOPE: 'web:read', MCP_RESOURCE_URL: resource }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let n = 0; n < 50; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const token = async ({ iss = issuer, aud = resource, sub = 'owner', scope = 'web:read', exp = '2m', key = privateKey } = {}) => new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(key);
  const request = value => fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal((await request(await token())).status, 200);
  for (const args of [{ iss: 'https://wrong.example/' }, { aud: 'wrong' }, { sub: 'other' }, { scope: 'other' }, { exp: '1s ago' }, { key: (await generateKeyPair('RS256')).privateKey }])
    assert.equal((await request(await token(args))).status, 401);
  const metadata = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
});
