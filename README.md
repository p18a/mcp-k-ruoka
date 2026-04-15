# mcp-ruoka

Unofficial MCP server for searching Finnish grocery and alcohol products across [K-Ruoka](https://www.k-ruoka.fi), [S-Kaupat](https://www.s-kaupat.fi), and [Alko](https://www.alko.fi).

- **K-Ruoka** — Playwright browser with stealth plugin (Cloudflare Turnstile bypass)
- **S-Kaupat** — Direct HTTP with persisted GraphQL query hashes (extracted via Playwright)
- **Alko** — Direct HTTP with NextAuth guest session (no browser needed)

## Tools

- **search_products** — Search products by query. Supports all three chains. `storeId` required for K-Ruoka/S-Kaupat, optional for Alko (national catalog).
- **get_stores** — List stores, optionally filtered by city and/or chain.

## Install as Claude Code plugin

Requires [Bun](https://bun.sh) installed.

```
/plugin marketplace add p18a/mcp-ruoka
/plugin install ruoka@ruoka
```

Dependencies and Playwright browser are installed automatically on first load.

## Deploy to Fly.io

```bash
# Clone and enter the repo
git clone https://github.com/p18a/mcp-ruoka.git
cd mcp-ruoka

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
git clone https://github.com/p18a/mcp-ruoka.git
cd mcp-ruoka
bun install
```

Then add to your MCP client config:

```json
{
  "mcpServers": {
    "ruoka": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-ruoka/src/index.ts", "--stdio"]
    }
  }
}
```

## Connect via Streamable HTTP

For remote deployments. Deploy first (see above), then point your MCP client at it:

```json
{
  "mcpServers": {
    "ruoka": {
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
| `LOG_LEVEL` | pino log level (default: info) |
| `BROWSER_DATA_DIR` | Persistent browser data directory (default: `.browser-data/`) |

## Usage examples

<img src="example.png" alt="Example: searching for rye bread at Iso Omena" width="600">

<img src="example2.png" alt="Example: finding the best price-to-alcohol ratio for fortified wines at Alko" width="600">

## Disclaimer

This project is unofficial and not affiliated with K Group, K-Ruoka, S Group, S-Kaupat, or Alko. It accesses publicly available data through their websites. Use responsibly.
