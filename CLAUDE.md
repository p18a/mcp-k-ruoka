# mcp-k-ruoka

MCP server that proxies K-Ruoka grocery product search via Playwright.

## Commands

- `bun run dev` — run with watch mode
- `bun run build` — bundle for production
- `bun run check` — lint, format, and auto-fix with Biome
- `bun run typecheck` — type-check without emitting

## Architecture

- `src/index.ts` — MCP server entry point (Streamable HTTP transport via Bun.serve)
- `src/tools/` — MCP tool definitions (search_products, get_stores)
- `src/browser/session.ts` — Playwright browser lifecycle (singleton context with stealth)
- `src/browser/scraper.ts` — API proxy: calls K-Ruoka's internal REST API via the browser session
- `src/types.ts` — Shared TypeScript types

### How it works

The scraper uses **Strategy A (API proxy)**: instead of scraping the DOM, it calls K-Ruoka's internal REST APIs from within the Playwright browser context. This gives us clean JSON responses while inheriting the browser's Cloudflare cookies.

Key APIs discovered:
- `POST /kr-api/v2/product-search/{query}` — product search (needs `x-k-build-number` header)
- `GET /kr-api/stores` — list all stores

The `x-k-build-number` header is extracted from the initial page load response headers or from embedded Sentry config in page scripts.

### Cloudflare bypass

K-Ruoka uses Cloudflare Turnstile. We use `playwright-extra` with `puppeteer-extra-plugin-stealth` to avoid bot detection. The stealth plugin patches common detection vectors (webdriver flag, plugins, WebGL fingerprint, etc.).

### Session management

- The browser uses a **persistent data directory** (`.browser-data/` in the project root by default, configurable via `BROWSER_DATA_DIR`) so cookies, cache, and history accumulate across restarts — looking like a returning user.
- Sessions **auto-reset** when Cloudflare blocks are detected (403 responses or challenge page markers).
- On reset, the data directory is deleted and recreated on the next request.
- To manually fix a stuck session: `rm -rf .browser-data`
- Normal failures (empty results, network errors, slow loads) do **not** trigger a reset — only active Cloudflare blocks do.

## Auth

Two auth mechanisms, usable independently or together:

- **Static bearer token** — set `MCP_AUTH_TOKEN`; clients send `Authorization: Bearer <token>` directly
- **OAuth client credentials** — set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`; clients discover endpoints via `/.well-known/oauth-protected-resource`, then exchange credentials at `POST /token` for a short-lived JWT
- If nothing is set, the server runs without auth (local dev only)
- OAuth is required for claude.ai integration (configure client ID + secret on both sides)

## Conventions

- Bun runtime — use `bun run`, `bun test`, `Bun.serve()` etc.
- Biome for linting and formatting (no ESLint/Prettier)
- Strict TypeScript — no `any`, no non-null assertions
- All tool inputs validated with Zod schemas via MCP SDK
- Browser context is reused across calls — don't create new contexts per request
- Keep scraper logic isolated from MCP tool definitions

## Connecting

### Stdio (local)

Run with `--stdio` flag for stdio transport (used by Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "k-ruoka": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-k-ruoka/src/index.ts", "--stdio"]
    }
  }
}
```

### Streamable HTTP (remote / claude.ai)

The server runs on `http://localhost:3001/mcp` by default (configure via `PORT` env var).

```json
{
  "mcpServers": {
    "k-ruoka": {
      "type": "streamable-http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Smoke test

```bash
# Initialize session
curl -s -i -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Search products (replace SESSION_ID with mcp-session-id from init response)
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"maito","storeId":"N123","limit":5}}}'

# List stores in Tampere
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_stores","arguments":{"city":"Tampere"}}}'
```
