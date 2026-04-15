import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { Product, SearchResult, Store } from "../types.ts";

const BASE_URL = "https://www.alko.fi";
const API_TIMEOUT = 15_000;
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Alko guest sessions expire after ~30 minutes
const SESSION_REFRESH_MS = 25 * 60 * 1000;

let sessionCookies: string | null = null;
let sessionCreatedAt = 0;
let bootstrapPromise: Promise<void> | null = null;

const CsrfResponseSchema = z.object({
	csrfToken: z.string(),
});

function collectSetCookies(res: Response, jar: Map<string, string>): void {
	for (const sc of res.headers.getSetCookie()) {
		const nameValue = sc.split(";")[0] ?? "";
		const eqIdx = nameValue.indexOf("=");
		if (eqIdx > 0) {
			jar.set(nameValue.substring(0, eqIdx).trim(), nameValue.substring(eqIdx + 1).trim());
		}
	}
}

function cookieHeader(jar: Map<string, string>): string {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function bootstrapSession(): Promise<void> {
	logger.info("Bootstrapping Alko guest session");

	const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, {
		headers: { "User-Agent": UA, Accept: "application/json" },
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	if (!csrfRes.ok) throw new Error(`Alko CSRF request failed: HTTP ${csrfRes.status}`);

	const { csrfToken } = CsrfResponseSchema.parse(await csrfRes.json());

	const jar = new Map<string, string>();
	collectSetCookies(csrfRes, jar);

	const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"User-Agent": UA,
			"Content-Type": "application/x-www-form-urlencoded",
			Cookie: cookieHeader(jar),
		},
		body: new URLSearchParams({
			redirect: "false",
			csrfToken,
			callbackUrl: `${BASE_URL}/fi/tuotteet`,
			json: "true",
		}),
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (loginRes.status >= 400) {
		throw new Error(`Alko guest login failed: HTTP ${loginRes.status}`);
	}
	collectSetCookies(loginRes, jar);

	if (!jar.has("__Secure-next-auth.session-token")) {
		throw new Error("Alko guest login did not return a session token");
	}

	sessionCookies = cookieHeader(jar);
	sessionCreatedAt = Date.now();

	logger.info("Alko guest session established");
}

async function ensureSession(): Promise<string> {
	if (!sessionCookies || Date.now() - sessionCreatedAt > SESSION_REFRESH_MS) {
		if (!bootstrapPromise) {
			bootstrapPromise = bootstrapSession().finally(() => {
				bootstrapPromise = null;
			});
		}
		await bootstrapPromise;
	}
	if (!sessionCookies) throw new Error("Alko session bootstrap failed");
	return sessionCookies;
}

export async function warmup(): Promise<void> {
	await ensureSession();
}

const defaultHeaders: Record<string, string> = {
	"User-Agent": UA,
	Accept: "application/json",
};

async function alkoFetch(
	url: string,
	method: string,
	headers?: Record<string, string>,
	body?: string,
): Promise<Response> {
	const cookies = await ensureSession();
	const response = await fetch(url, {
		method,
		headers: { ...defaultHeaders, Cookie: cookies, ...headers },
		body,
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (response.status === 401 || response.status === 403) {
		logger.warn({ status: response.status }, "Alko session expired, refreshing");
		sessionCookies = null;
		const freshCookies = await ensureSession();
		const retry = await fetch(url, {
			method,
			headers: { ...defaultHeaders, Cookie: freshCookies, ...headers },
			body,
			signal: AbortSignal.timeout(API_TIMEOUT),
		});
		if (retry.status === 401 || retry.status === 403) {
			throw new Error(`Alko API rejected request after session refresh: HTTP ${retry.status}`);
		}
		return retry;
	}

	return response;
}

const AlkoProductSchema = z.object({
	id: z.string(),
	name: z.string(),
	price: z.number().nullable(),
	abv: z.number().nullable().optional(),
	volume: z.number().nullable().optional(),
	countryName: z.string().nullable().optional(),
	productGroupName: z.array(z.string()).optional(),
	storeId: z.array(z.string()).optional(),
});

const ProductSearchResponseSchema = z.object({
	"@odata.count": z.number().optional(),
	value: z.array(AlkoProductSchema),
});

function buildImageUrl(sku: string): string {
	return `https://images.alko.fi/images/cs_srgb,f_auto,t_products/cdn/${sku}/${sku}.jpg`;
}

function mapProduct(item: z.infer<typeof AlkoProductSchema>): Product {
	// Alko API returns volume in liters (e.g., 0.75 for 750ml)
	const pricePerLiter =
		item.price != null && item.volume
			? `${(item.price / item.volume).toFixed(2).replace(".", ",")} \u20AC/l`
			: null;

	return {
		name: item.name,
		price: item.price,
		unitPrice: pricePerLiter,
		ean: item.id,
		imageUrl: buildImageUrl(item.id),
		brand: null,
		category: item.productGroupName?.[0] ?? null,
	};
}

export async function searchProducts(
	query: string,
	storeId: string | undefined,
	limit: number,
): Promise<SearchResult> {
	logger.info({ query, storeId, limit }, "Alko product search");

	const body: Record<string, unknown> = {
		top: limit,
		skip: 0,
		search: query,
	};
	if (storeId) {
		body.storeId = storeId;
	}

	const response = await alkoFetch(
		`${BASE_URL}/api/search/product?lang=fi`,
		"POST",
		{ "Content-Type": "application/json" },
		JSON.stringify(body),
	);

	if (!response.ok) {
		throw new Error(`Alko search API HTTP ${response.status}`);
	}

	const raw = await response.json();
	let parsed: z.infer<typeof ProductSearchResponseSchema>;
	try {
		parsed = ProductSearchResponseSchema.parse(raw);
	} catch (err) {
		logger.error({ err }, "Failed to parse Alko search response");
		throw err;
	}

	const products = parsed.value.map(mapProduct);

	logger.info({ query, resultCount: products.length }, "Alko search completed");

	return {
		products,
		totalCount: parsed["@odata.count"] ?? products.length,
		query,
		storeId: storeId ?? "national",
		chain: "alko",
	};
}

const AlkoStoreSchema = z.object({
	id: z.string(),
	name: z.string(),
	city: z.string(),
	address: z.string(),
	postalCode: z.string(),
});

const StoresResponseSchema = z.object({
	data: z.array(AlkoStoreSchema),
});

let storeCache: Store[] | null = null;

export async function getStores(city?: string): Promise<Store[]> {
	if (!storeCache) {
		logger.info("Fetching Alko stores");

		const response = await alkoFetch(`${BASE_URL}/api/stores`, "GET");
		if (!response.ok) {
			throw new Error(`Alko stores API HTTP ${response.status}`);
		}

		const raw = await response.json();
		const parsed = StoresResponseSchema.parse(raw);

		storeCache = parsed.data.map((s) => ({
			id: s.id,
			name: s.name,
			chain: "alko" as const,
			location: s.city,
		}));

		logger.info({ storeCount: storeCache.length }, "Alko stores fetched");
	}

	if (city) {
		const lower = city.toLowerCase();
		return storeCache.filter((s) => s.location.toLowerCase().includes(lower));
	}

	return storeCache;
}
