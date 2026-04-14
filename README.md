# mcp-k-ruoka

Unofficial MCP server for searching [K-Ruoka](https://www.k-ruoka.fi) grocery products. Uses Playwright to proxy K-Ruoka's internal API through a real browser session (Cloudflare bypass via stealth plugin).

## Tools

- **search_products** — Search products by query at a specific store
- **get_stores** — List K-Ruoka stores, optionally filtered by city

## Deploy to Fly.io

```bash
# Clone and enter the repo
git clone https://github.com/p18a/mcp-k-ruoka.git
cd mcp-k-ruoka

# Create app (pick your own name)
fly launch --no-deploy

# Set OAuth credentials
fly secrets set \
  OAUTH_CLIENT_ID=$(openssl rand -hex 32) \
  OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)

# Deploy
fly deploy
```

Note the client ID and secret — you'll need them to connect.

## Connect from claude.ai

1. Go to Settings > Integrations > Add integration
2. Enter your server URL: `https://<your-app>.fly.dev/mcp`
3. Enter the client ID and secret you generated above

## Connect from Claude Desktop / Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "k-ruoka": {
      "type": "streamable-http",
      "url": "https://<your-app>.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

For direct bearer token auth, set `MCP_AUTH_TOKEN` as a Fly secret and use it in the header above.

## Local development

```bash
bun install
cp .env.example .env
bun run dev
```

The server runs on `http://localhost:3001/mcp`. Without auth env vars set, it runs unauthenticated.

## Environment variables

| Variable | Description |
|---|---|
| `OAUTH_CLIENT_ID` | OAuth client ID (required for claude.ai) |
| `OAUTH_CLIENT_SECRET` | OAuth client secret (required for claude.ai) |
| `MCP_AUTH_TOKEN` | Static bearer token (alternative to OAuth) |
| `PORT` | Server port (default: 3001) |

## Disclaimer

This project is unofficial and not affiliated with K Group or K-Ruoka. It accesses publicly available data through their website. Use responsibly.
