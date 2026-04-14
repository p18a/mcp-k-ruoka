import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	issueAccessToken,
	oauthEnabled,
	validateAccessToken,
	validateClientCredentials,
} from "./auth.ts";
import { registerSearchTool } from "./tools/search.ts";
import { registerStoresTool } from "./tools/stores.ts";

function createServer(): McpServer {
	const server = new McpServer({
		name: "k-ruoka",
		version: "0.1.0",
	});
	registerSearchTool(server);
	registerStoresTool(server);
	return server;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function getTransport(
	sessionId: string | null,
): WebStandardStreamableHTTPServerTransport | undefined {
	if (!sessionId) return undefined;
	return transports.get(sessionId);
}

const port = Number(process.env.PORT) || 3001;
const authToken = process.env.MCP_AUTH_TOKEN;

if (!authToken && !oauthEnabled) {
	console.warn("WARNING: No authentication configured — running without auth");
}

function checkAuth(req: Request): boolean {
	if (!authToken && !oauthEnabled) return true;
	const header = req.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return false;
	const token = header.slice(7);
	if (
		authToken &&
		token.length === authToken.length &&
		timingSafeEqual(Buffer.from(token), Buffer.from(authToken))
	) {
		return true;
	}
	return oauthEnabled && validateAccessToken(token);
}

function getBaseUrl(req: Request): string {
	const proto = req.headers.get("x-forwarded-proto") ?? "http";
	const host = req.headers.get("host") ?? `localhost:${port}`;
	return `${proto}://${host}`;
}

Bun.serve({
	hostname: "0.0.0.0",
	port,
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (oauthEnabled) {
			if (req.method === "GET") {
				const base = getBaseUrl(req);
				if (url.pathname === "/.well-known/oauth-protected-resource") {
					return Response.json({
						resource: `${base}/mcp`,
						authorization_servers: [base],
						bearer_methods_supported: ["header"],
					});
				}
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({
						issuer: base,
						token_endpoint: `${base}/token`,
						token_endpoint_auth_methods_supported: ["client_secret_post"],
						grant_types_supported: ["client_credentials"],
						response_types_supported: [],
					});
				}
			}

			if (url.pathname === "/token" && req.method === "POST") {
				const params = new URLSearchParams(await req.text());
				const grantType = params.get("grant_type");
				const id = params.get("client_id");
				const secret = params.get("client_secret");

				if (grantType !== "client_credentials") {
					return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
				}
				if (!id || !secret || !validateClientCredentials(id, secret)) {
					return Response.json({ error: "invalid_client" }, { status: 401 });
				}
				return Response.json(issueAccessToken());
			}
		}

		if (url.pathname !== "/mcp") {
			return new Response("Not Found", { status: 404 });
		}

		if (!checkAuth(req)) {
			const headers: Record<string, string> = {};
			if (oauthEnabled) {
				const base = getBaseUrl(req);
				headers["WWW-Authenticate"] =
					`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
			}
			return new Response(null, { status: 401, headers });
		}

		const sessionId = req.headers.get("mcp-session-id");

		if (req.method === "POST") {
			const existing = getTransport(sessionId);
			if (existing) {
				return existing.handleRequest(req);
			}

			// Session ID was provided but not found — session is stale (e.g. server restarted).
			// Per MCP spec, return 404 so the client knows to re-initialize.
			if (sessionId) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
					{ status: 404 },
				);
			}

			const body = await req.json();
			if (isInitializeRequest(body)) {
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (sid) => {
						transports.set(sid, transport);
					},
				});
				transport.onclose = () => {
					if (transport.sessionId) {
						transports.delete(transport.sessionId);
					}
				};

				const server = createServer();
				await server.connect(transport);

				const newReq = new Request(req.url, {
					method: req.method,
					headers: req.headers,
					body: JSON.stringify(body),
				});
				return transport.handleRequest(newReq);
			}

			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null },
				{ status: 400 },
			);
		}

		if (req.method === "GET" || req.method === "DELETE") {
			const transport = getTransport(sessionId);
			if (transport) {
				return transport.handleRequest(req);
			}
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
				{ status: sessionId ? 404 : 400 },
			);
		}

		return new Response("Method Not Allowed", { status: 405 });
	},
});

console.log(`K-Ruoka MCP server listening on http://localhost:${port}/mcp`);
