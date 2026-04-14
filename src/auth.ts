import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";

const clientId = process.env.OAUTH_CLIENT_ID ?? "";
const clientSecret = process.env.OAUTH_CLIENT_SECRET ?? "";
const TOKEN_EXPIRY = 7 * 24 * 3600; // 1 week
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 3600; // 30 days
const CODE_TTL = 60_000; // 60 seconds in ms

export const oauthEnabled = clientId.length > 0 && clientSecret.length > 0;

function hmacSign(data: string): string {
	return createHmac("sha256", clientSecret).update(data).digest("base64url");
}

export function isKnownClientId(id: string): boolean {
	if (!oauthEnabled || id.length !== clientId.length) return false;
	return timingSafeEqual(Buffer.from(id), Buffer.from(clientId));
}

export function validateClientCredentials(id: string, secret: string): boolean {
	if (!oauthEnabled) return false;
	if (id.length !== clientId.length || secret.length !== clientSecret.length) return false;
	return (
		timingSafeEqual(Buffer.from(id), Buffer.from(clientId)) &&
		timingSafeEqual(Buffer.from(secret), Buffer.from(clientSecret))
	);
}

interface StoredCode {
	codeChallenge: string;
	codeChallengeMethod: string;
	redirectUri: string;
	clientId: string;
	expiresAt: number;
}

const authCodes = new Map<string, StoredCode>();
const MAX_AUTH_CODES = 100;

function pruneExpiredCodes(): void {
	const now = Date.now();
	for (const [code, stored] of authCodes) {
		if (stored.expiresAt < now) authCodes.delete(code);
	}
}

export function createAuthCode(params: {
	codeChallenge: string;
	codeChallengeMethod: string;
	redirectUri: string;
	clientId: string;
}): string {
	if (params.codeChallengeMethod !== "S256") {
		throw new Error("Only S256 code challenge method is supported");
	}
	pruneExpiredCodes();
	if (authCodes.size >= MAX_AUTH_CODES) {
		throw new Error("Too many pending authorization codes");
	}
	const code = randomBytes(32).toString("hex");
	authCodes.set(code, { ...params, expiresAt: Date.now() + CODE_TTL });
	return code;
}

export function exchangeAuthCode(params: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
}): ReturnType<typeof issueAccessToken> | null {
	const stored = authCodes.get(params.code);
	if (!stored) return null;
	authCodes.delete(params.code);

	if (stored.expiresAt < Date.now()) return null;
	if (stored.redirectUri !== params.redirectUri) return null;
	if (stored.clientId !== params.clientId) return null;

	const expected = createHash("sha256").update(params.codeVerifier).digest("base64url");
	if (expected.length !== stored.codeChallenge.length) return null;
	if (!timingSafeEqual(Buffer.from(expected), Buffer.from(stored.codeChallenge))) return null;

	return issueAccessToken();
}

function signJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = hmacSign(`${header}.${payload}`);
	return `${header}.${payload}.${signature}`;
}

export interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
}

export function issueAccessToken(): TokenResponse {
	const now = Math.floor(Date.now() / 1000);
	return {
		access_token: signJwt({ sub: clientId, iat: now, exp: now + TOKEN_EXPIRY }),
		token_type: "Bearer",
		expires_in: TOKEN_EXPIRY,
		refresh_token: signJwt({
			sub: clientId,
			iat: now,
			exp: now + REFRESH_TOKEN_EXPIRY,
			typ: "refresh",
		}),
	};
}

const JwtClaimsSchema = z.object({ exp: z.number(), typ: z.string().optional() });

function verifyJwt(token: string): z.infer<typeof JwtClaimsSchema> | null {
	if (!oauthEnabled) return null;
	const dot1 = token.indexOf(".");
	const dot2 = token.lastIndexOf(".");
	if (dot1 === -1 || dot1 === dot2) return null;
	const headerPayload = token.slice(0, dot2);
	const signature = token.slice(dot2 + 1);
	const payload = token.slice(dot1 + 1, dot2);
	const expected = hmacSign(headerPayload);
	if (expected.length !== signature.length) return null;
	if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
	try {
		const result = JwtClaimsSchema.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString()),
		);
		if (!result.success) return null;
		if (result.data.exp <= Math.floor(Date.now() / 1000)) return null;
		return result.data;
	} catch {
		return null;
	}
}

export function validateAccessToken(token: string): boolean {
	const claims = verifyJwt(token);
	return claims !== null && claims.typ === undefined;
}

export function validateRefreshToken(token: string): boolean {
	const claims = verifyJwt(token);
	return claims !== null && claims.typ === "refresh";
}
