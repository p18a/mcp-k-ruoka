# mcp-ruoka

MCP server for Finnish grocery and alcohol product search across K-Ruoka (k-ruoka.fi), S-Kaupat (s-kaupat.fi), and Alko (alko.fi). Single-client personal tool — keep auth, session management, and infrastructure simple rather than building for multi-tenant scale.

## Commands

- `bun run dev` — run with watch mode
- `bun run build` — bundle for production
- `bun run check` — lint, format, and auto-fix with Biome
- `bun run typecheck` — type-check without emitting

## Conventions

- Bun runtime — use `bun run`, `bun test`, `Bun.serve()` etc.
- Biome for linting and formatting (no ESLint/Prettier)
- Strict TypeScript — no `any`, no non-null assertions, no `as` type casts (use Zod parsing instead)
- Parse all I/O boundaries with Zod — API responses, JSON.parse results, external data. Never trust runtime shapes via `as` assertions; validate with `.parse()` / `.safeParse()`. (`as const` is fine — it narrows literals, doesn't assert shapes)
- All tool inputs validated with Zod schemas via MCP SDK
- Use pino for logging (`src/logger.ts`), never `console.log/warn/error` — logs must go to stderr to avoid interfering with stdio MCP transport
- Comments should explain *why*, not *what* — no section dividers, no restating what the code does
- Browser context is reused across calls — don't create new contexts per request
- Keep chain-specific browser/API logic (`src/browser/`) isolated from MCP tool definitions (`src/tools/`)
