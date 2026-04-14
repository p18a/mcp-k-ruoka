# mcp-k-ruoka

Unofficial MCP server for searching [K-Ruoka](https://www.k-ruoka.fi) grocery products. Uses Playwright to proxy K-Ruoka's internal API through a real browser session (Cloudflare bypass via stealth plugin).

![Example: searching for rye bread at Iso Omena](example.png)

## Tools

- **search_products** — Search products by query at a specific store
- **get_stores** — List K-Ruoka stores, optionally filtered by city

## Install as Claude Code plugin

Requires [Bun](https://bun.sh) installed.

```
/plugin marketplace add p18a/mcp-k-ruoka
/plugin install k-ruoka@k-ruoka
```

Dependencies and Playwright browser are installed automatically on first load.

## Deploy to Fly.io

```bash
# Clone and enter the repo
git clone https://github.com/p18a/mcp-k-ruoka.git
cd mcp-k-ruoka

# Create fly.toml from example (pick your own app name)
cp fly.example.toml fly.toml
fly launch --no-deploy

# Set OAuth credentials
fly secrets set \
  OAUTH_CLIENT_ID=$(openssl rand -hex 32) \
  OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)

# Deploy
fly deploy
```

Note the client ID and secret — you'll need them to connect.

## Connect via stdio

Runs the server as a subprocess — simplest option for local use.

```bash
git clone https://github.com/p18a/mcp-k-ruoka.git
cd mcp-k-ruoka
bun install
```

Then add to your MCP client config:

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

## Connect via Streamable HTTP

For remote deployments. Deploy first (see above), then point your MCP client at it:

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

For direct bearer token auth, set `MCP_AUTH_TOKEN` as a Fly secret and use it in the header above. For OAuth, configure `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` on both the server and your MCP client.

## Local development

```bash
bun install
cp .env.example .env
bun run dev
```

The server runs on `http://localhost:3001/mcp` by default (Streamable HTTP). Pass `--stdio` for stdio transport.

## Environment variables

| Variable | Description |
|---|---|
| `OAUTH_CLIENT_ID` | OAuth client ID (required for claude.ai) |
| `OAUTH_CLIENT_SECRET` | OAuth client secret (required for claude.ai) |
| `MCP_AUTH_TOKEN` | Static bearer token (alternative to OAuth) |
| `PORT` | Server port (default: 3001) |

## Disclaimer

This project is unofficial and not affiliated with K Group or K-Ruoka. It accesses publicly available data through their website. Use responsibly.
