import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as z from 'zod/v4';
import { searchWeb, scrapeWeb } from './logic.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
const env = process.env;
const issuer = env.OAUTH_ISSUER?.replace(/\/?$/, '/');
const resource = env.MCP_RESOURCE_URL;
const jwks = issuer ? createRemoteJWKSet(new URL('.well-known/jwks.json', issuer)) : null;
const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function authorized(value) {
  if (!value?.startsWith('Bearer ')) return false;
  const token = value.slice(7);
  if (env.MCP_STATIC_TOKEN && equal(token, env.MCP_STATIC_TOKEN)) return true;
  if (!jwks || !env.OAUTH_AUDIENCE || !env.OAUTH_ALLOWED_SUBJECT || !env.OAUTH_REQUIRED_SCOPE) return false;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.OAUTH_AUDIENCE, algorithms: ['RS256'] });
    return payload.sub === env.OAUTH_ALLOWED_SUBJECT && typeof payload.scope === 'string' && payload.scope.split(' ').includes(env.OAUTH_REQUIRED_SCOPE);
  } catch { return false; }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  if (!issuer || !resource || !env.OAUTH_REQUIRED_SCOPE) return res.status(503).json({ error: 'OAuth not configured' });
  return res.json({ resource, authorization_servers: [issuer], scopes_supported: [env.OAUTH_REQUIRED_SCOPE], bearer_methods_supported: ['header'] });
});
app.use('/mcp', async (req, res, next) => {
  if (await authorized(req.get('authorization'))) return next();
  if (resource) res.set('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', resource)}"`);
  else res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Unauthorized' });
});

function createServer() {
  const server = new McpServer({ name: 'crawl4ai-web', version: '0.1.0' });
  const wrap = fn => async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: err.message || 'Request failed.' }] }; }
  };
  server.registerTool('search_web', {
    title: 'Search the web', description: 'Search the web for relevant sources and return titles, URLs, and snippets. Search queries are sent to Brave Search.',
    inputSchema: { query: z.string().trim().min(1).max(600), count: z.number().int().min(1).max(10).default(5) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, wrap(args => searchWeb(args, { key: env.BRAVE_SEARCH_API_KEY })));
  server.registerTool('scrape_web', {
    title: 'Read a web page', description: 'Retrieve a public web page as Markdown using the self-hosted Crawl4AI service.',
    inputSchema: { url: z.string().url().max(2048), max_chars: z.number().int().min(1000).max(100000).default(30000) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, wrap(args => scrapeWeb(args, { baseUrl: env.CRAWLER_URL, token: env.CRAWLER_TOKEN })));
  return server;
}
app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    res.on('close', () => { void transport.close(); void server.close(); });
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});
app.all('/mcp', (_req, res) => res.status(405).end());
const port = Number(env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`MCP gateway listening on ${port}`));
