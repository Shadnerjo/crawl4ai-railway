# Crawl4AI web MCP gateway

A separate authenticated MCP service that exposes `search_web` using self-hosted SearXNG and `scrape_web` using an existing Crawl4AI backend. This project uses Crawl4AI (https://github.com/unclecode/crawl4ai) for web data extraction.

Run `npm ci`, `npm test`, and `npm start` with Node 22 or newer. Configure these Railway variables:

- `CRAWLER_URL`: private Crawl4AI service URL, including port 11235.
- `CRAWLER_TOKEN`: reference to the crawler's `CRAWL4AI_API_TOKEN`.
- `SEARCH_URL`: the private SearXNG service URL, including port 8080.
- `MCP_STATIC_TOKEN`: a distinct strong secret for clients supporting a bearer header; never commit this value.
- `MCP_RESOURCE_URL`: the gateway's public HTTPS URL ending in `/mcp`.
- `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_ALLOWED_SUBJECT`, `OAUTH_REQUIRED_SCOPE`: trusted OAuth issuer, API audience, one allowed user subject, and required API scope. OAuth is disabled unless all are configured.

The health endpoint is `/health`. `/.well-known/oauth-protected-resource/mcp` advertises the configured authorization server. `/mcp` uses stateless Streamable HTTP. Authentication fails closed when no valid credential is configured. The service checks token signature, issuer, audience, subject, and scope. The OAuth provider must be configured separately, including its client registration and consent policy.

Direct local, private IP, and nonstandard-port URLs are rejected. These checks do not prevent all server-side request forgery: DNS changes, redirects, JavaScript and subresources may cause the browser backend to contact other destinations. Run this only for trusted users and isolate the crawler's network from sensitive internal services. Do not expose it anonymously. Search and crawl providers can rate-limit or reject requests.

The gateway returns source content as untrusted data, which may include instructions embedded by third parties. Clients must not treat page text as instructions.
