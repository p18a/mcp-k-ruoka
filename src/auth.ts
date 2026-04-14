import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const clientId = process.env.OAUTH_CLIENT_ID ?? "";
const clientSecret = process.env.OAUTH_CLIENT_SECRET ?? "";
const TOKEN_EXPIRY = 3600;
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

// --- Authorization codes (PKCE) ---

interface StoredCode {
	codeChallenge: string;
	codeChallengeMethod: string;
	redirectUri: string;
	clientId: string;
	expiresAt: number;
}

const authCodes = new Map<string, StoredCode>();

export function createAuthCode(params: {
	codeChallenge: string;
	codeChallengeMethod: string;
	redirectUri: string;
	clientId: string;
}): string {
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

	// Verify PKCE
	if (stored.codeChallengeMethod === "S256") {
		const expected = createHash("sha256").update(params.codeVerifier).digest("base64url");
		if (expected !== stored.codeChallenge) return null;
	} else if (params.codeVerifier !== stored.codeChallenge) {
		return null;
	}

	return issueAccessToken();
}

// --- JWT access tokens ---

export function issueAccessToken(): {
	access_token: string;
	token_type: string;
	expires_in: number;
} {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = Buffer.from(
		JSON.stringify({ sub: clientId, iat: now, exp: now + TOKEN_EXPIRY }),
	).toString("base64url");
	const signature = hmacSign(`${header}.${payload}`);
	return {
		access_token: `${header}.${payload}.${signature}`,
		token_type: "Bearer",
		expires_in: TOKEN_EXPIRY,
	};
}

export function validateAccessToken(token: string): boolean {
	if (!oauthEnabled) return false;
	const dot1 = token.indexOf(".");
	const dot2 = token.lastIndexOf(".");
	if (dot1 === -1 || dot1 === dot2) return false;
	const headerPayload = token.slice(0, dot2);
	const signature = token.slice(dot2 + 1);
	const payload = token.slice(dot1 + 1, dot2);
	const expected = hmacSign(headerPayload);
	if (expected.length !== signature.length) return false;
	if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
	try {
		const claims: { exp?: unknown } = JSON.parse(Buffer.from(payload, "base64url").toString());
		return typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
	} catch {
		return false;
	}
}
