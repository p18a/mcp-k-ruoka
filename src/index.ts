import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
	createAuthCode,
	exchangeAuthCode,
	isKnownClientId,
	issueAccessToken,
	oauthEnabled,
	validateAccessToken,
	validateClientCredentials,
	validateRefreshToken,
} from "./auth.ts";
import { getPage } from "./browser/session.ts";
import { logger } from "./logger.ts";
import { registerSearchTool } from "./tools/search.ts";
import { registerStoresTool } from "./tools/stores.ts";

const logoPath = join(import.meta.dirname, "..", "logo.png");

function createServer(baseUrl?: string): McpServer {
	const server = new McpServer({
		name: "k-ruoka",
		version: "0.1.0",
		...(baseUrl && { icons: [{ src: `${baseUrl}/logo.png`, mimeType: "image/png" }] }),
	});
	registerSearchTool(server);
	registerStoresTool(server);
	return server;
}

if (process.argv.includes("--stdio")) {
	logger.info("Starting in stdio mode");
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	getPage().catch((err) => {
		logger.warn({ err }, "Browser pre-init failed (will retry on first request)");
	});
} else {
	startHttpServer();
}

function startHttpServer() {
	interface TrackedTransport {
		transport: WebStandardStreamableHTTPServerTransport;
		lastActivity: number;
	}

	const transports = new Map<string, TrackedTransport>();
	const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

	function getTransport(
		sessionId: string | null,
	): WebStandardStreamableHTTPServerTransport | undefined {
		if (!sessionId) return undefined;
		const entry = transports.get(sessionId);
		if (!entry) return undefined;
		entry.lastActivity = Date.now();
		return entry.transport;
	}

	setInterval(() => {
		const cutoff = Date.now() - SESSION_TTL;
		for (const [id, entry] of transports) {
			if (entry.lastActivity < cutoff) {
				logger.info({ sessionId: id }, "Expiring idle MCP session");
				entry.transport.close?.();
				transports.delete(id);
			}
		}
	}, 60_000);

	const port = Number(process.env.PORT) || 3001;
	const authToken = process.env.MCP_AUTH_TOKEN;

	if (!authToken && !oauthEnabled) {
		logger.warn("No authentication configured — running without auth");
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
			logger.debug({ method: req.method, path: url.pathname }, "Incoming request");

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
							authorization_endpoint: `${base}/authorize`,
							token_endpoint: `${base}/token`,
							token_endpoint_auth_methods_supported: ["client_secret_post"],
							grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
							response_types_supported: ["code"],
							code_challenge_methods_supported: ["S256"],
						});
					}
				}

				if (url.pathname === "/authorize" && req.method === "GET") {
					const responseType = url.searchParams.get("response_type");
					const id = url.searchParams.get("client_id");
					const redirectUri = url.searchParams.get("redirect_uri");
					const state = url.searchParams.get("state");
					const codeChallenge = url.searchParams.get("code_challenge");
					const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";

					if (
						responseType !== "code" ||
						!id ||
						!redirectUri ||
						!codeChallenge ||
						codeChallengeMethod !== "S256"
					) {
						return Response.json({ error: "invalid_request" }, { status: 400 });
					}
					if (!isKnownClientId(id)) {
						return Response.json({ error: "invalid_client" }, { status: 401 });
					}

					const code = createAuthCode({
						codeChallenge,
						codeChallengeMethod,
						redirectUri,
						clientId: id,
					});
					const redirect = new URL(redirectUri);
					redirect.searchParams.set("code", code);
					if (state) redirect.searchParams.set("state", state);
					return Response.redirect(redirect.toString(), 302);
				}

				if (url.pathname === "/token" && req.method === "POST") {
					const params = new URLSearchParams(await req.text());
					const grantType = params.get("grant_type");

					if (grantType === "authorization_code") {
						const code = params.get("code");
						const codeVerifier = params.get("code_verifier");
						const redirectUri = params.get("redirect_uri");
						const id = params.get("client_id");
						if (!code || !codeVerifier || !redirectUri || !id) {
							return Response.json({ error: "invalid_request" }, { status: 400 });
						}
						const token = exchangeAuthCode({ code, codeVerifier, redirectUri, clientId: id });
						if (!token) {
							return Response.json({ error: "invalid_grant" }, { status: 400 });
						}
						return Response.json(token);
					}

					if (grantType === "client_credentials") {
						const id = params.get("client_id");
						const secret = params.get("client_secret");
						if (!id || !secret || !validateClientCredentials(id, secret)) {
							return Response.json({ error: "invalid_client" }, { status: 401 });
						}
						return Response.json(issueAccessToken());
					}

					if (grantType === "refresh_token") {
						const refreshToken = params.get("refresh_token");
						if (!refreshToken || !validateRefreshToken(refreshToken)) {
							return Response.json({ error: "invalid_grant" }, { status: 400 });
						}
						return Response.json(issueAccessToken());
					}

					return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
				}
			}

			if (url.pathname === "/logo.png") {
				return new Response(Bun.file(logoPath));
			}

			if (url.pathname !== "/mcp") {
				return new Response("Not Found", { status: 404 });
			}

			if (!checkAuth(req)) {
				logger.warn({ method: req.method, path: url.pathname }, "Auth rejected");
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

				// Per MCP spec, 404 tells the client to re-initialize
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
							logger.info({ sessionId: sid }, "New MCP session initialized");
							transports.set(sid, {
								transport,
								lastActivity: Date.now(),
							});
						},
					});
					transport.onclose = () => {
						if (transport.sessionId) {
							transports.delete(transport.sessionId);
						}
					};

					const server = createServer(getBaseUrl(req));
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

	logger.info({ port, url: `http://localhost:${port}/mcp` }, "K-Ruoka MCP server listening");

	// Pre-warm so the first request isn't slow
	getPage().catch((err) => {
		logger.warn({ err }, "Browser pre-init failed (will retry on first request)");
	});
}
