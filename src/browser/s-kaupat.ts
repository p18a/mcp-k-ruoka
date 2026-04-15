import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { Product, SearchResult, Store } from "../types.ts";
import { getContext } from "./session.ts";

const ORIGIN = "https://www.s-kaupat.fi";
const API_URL = "https://api.s-kaupat.fi/";
const API_TIMEOUT = 15_000;

const ExtensionsParamSchema = z.object({
	persistedQuery: z.object({
		sha256Hash: z.string(),
	}),
});

const hashCache = new Map<string, string>();
let extractPromise: Promise<void> | null = null;

async function extractHashes(): Promise<void> {
	logger.info("Extracting S-Kaupat persisted query hashes");
	const ctx = await getContext();
	const page = await ctx.newPage();

	const waiters = new Map<string, () => void>();
	function waitForHash(op: string): Promise<void> {
		if (hashCache.has(op)) return Promise.resolve();
		return new Promise((resolve) => waiters.set(op, resolve));
	}

	try {
		await page.route("https://api.s-kaupat.fi/**", async (route) => {
			const url = new URL(route.request().url());
			const op = url.searchParams.get("operationName");
			const ext = url.searchParams.get("extensions");

			if (op && ext) {
				try {
					const result = ExtensionsParamSchema.safeParse(JSON.parse(ext));
					if (result.success) {
						hashCache.set(op, result.data.persistedQuery.sha256Hash);
						logger.debug({ op }, "Captured persisted query hash");
						waiters.get(op)?.();
					}
				} catch {
					// Ignore malformed JSON
				}
			}

			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ data: {} }),
			});
		});

		// 1. Product search hash: navigate to search results page
		await page.goto(`${ORIGIN}/hakutulokset?queryString=test`, {
			waitUntil: "commit",
			timeout: 30_000,
		});
		await Promise.race([
			waitForHash("RemoteFilteredProducts"),
			page.waitForTimeout(15_000).then(() => {
				logger.warn("Timed out waiting for RemoteFilteredProducts hash");
			}),
		]);

		// 2. Store search hash: navigate to stores page and click "show more"
		await page.goto(`${ORIGIN}/myymalat/prisma`, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		await page.evaluate(`document.getElementById("usercentrics-root")?.remove()`);
		const btn = page.locator("button", { hasText: "Näytä lisää" });
		if (await btn.isVisible({ timeout: 5_000 }).catch(() => false)) {
			await btn.click();
			await Promise.race([
				waitForHash("RemoteStoreSearch"),
				page.waitForTimeout(10_000).then(() => {
					logger.warn("Timed out waiting for RemoteStoreSearch hash");
				}),
			]);
		}
	} finally {
		await page.close();
	}

	logger.info({ operations: [...hashCache.keys()] }, "S-Kaupat hashes extracted");
}

export async function warmup(): Promise<void> {
	if (hashCache.size > 0) return;
	if (!extractPromise) {
		extractPromise = extractHashes().finally(() => {
			extractPromise = null;
		});
	}
	await extractPromise;
}

async function getHash(operationName: string): Promise<string> {
	if (!hashCache.has(operationName)) {
		if (!extractPromise) {
			extractPromise = extractHashes().finally(() => {
				extractPromise = null;
			});
		}
		await extractPromise;
	}
	const hash = hashCache.get(operationName);
	if (!hash) throw new Error(`S-Kaupat persisted query hash not found for: ${operationName}`);
	return hash;
}

const ProductImageSchema = z.object({
	urlTemplate: z.string(),
});

const HierarchyItemSchema = z.object({
	name: z.string(),
});

const PricingSchema = z.object({
	currentPrice: z.number().nullable(),
	comparisonPrice: z.number().nullable(),
	comparisonUnit: z.string().nullable(),
	campaignPrice: z.number().nullable(),
});

const SKaupatProductSchema = z.object({
	name: z.string(),
	ean: z.string(),
	price: z.number().nullable(),
	brandName: z.string().nullable(),
	pricing: PricingSchema,
	productDetails: z.object({
		productImages: z.object({
			mainImage: ProductImageSchema.nullable(),
		}),
	}),
	hierarchyPath: z.array(HierarchyItemSchema),
});

const ProductListItemSchema = z.object({
	product: SKaupatProductSchema,
});

const SearchResponseSchema = z.object({
	data: z.object({
		store: z.object({
			products: z.object({
				total: z.number(),
				productListItems: z.array(ProductListItemSchema),
			}),
		}),
	}),
});

const PersistedQueryNotFoundSchema = z.object({
	errors: z.array(
		z.object({
			extensions: z.object({
				code: z.literal("PERSISTED_QUERY_NOT_FOUND"),
			}),
		}),
	),
});

function buildImageUrl(urlTemplate: string): string {
	return urlTemplate.replace("{MODIFIERS}", "w_200,h_200").replace("{EXTENSION}", "png");
}

function mapProduct(item: z.infer<typeof ProductListItemSchema>): Product {
	const p = item.product;
	const { comparisonPrice, comparisonUnit } = p.pricing;

	return {
		name: p.name,
		price: p.pricing.currentPrice ?? p.price,
		unitPrice:
			comparisonPrice != null && comparisonUnit
				? `${comparisonPrice.toFixed(2).replace(".", ",")} \u20AC/${comparisonUnit.toLowerCase()}`
				: null,
		ean: p.ean,
		imageUrl: p.productDetails.productImages.mainImage
			? buildImageUrl(p.productDetails.productImages.mainImage.urlTemplate)
			: null,
		brand: p.brandName,
		category: p.hierarchyPath[0]?.name ?? null,
	};
}

async function fetchProducts(
	query: string,
	storeId: string,
	limit: number,
	hash: string,
): Promise<unknown> {
	const url = new URL(API_URL);
	url.searchParams.set("operationName", "RemoteFilteredProducts");
	url.searchParams.set(
		"variables",
		JSON.stringify({ queryString: query, storeId, from: 0, limit }),
	);
	url.searchParams.set(
		"extensions",
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
	);

	const response = await fetch(url, {
		headers: {
			Origin: ORIGIN,
			Referer: `${ORIGIN}/`,
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (!response.ok) {
		throw new Error(`S-Kaupat API HTTP ${response.status}`);
	}

	return response.json();
}

export async function searchProducts(
	query: string,
	storeId: string,
	limit: number,
): Promise<SearchResult> {
	logger.info({ query, storeId, limit }, "S-Kaupat product search");

	let hash = await getHash("RemoteFilteredProducts");
	let raw = await fetchProducts(query, storeId, limit, hash);

	if (PersistedQueryNotFoundSchema.safeParse(raw).success) {
		logger.warn("Persisted query hash expired, re-extracting");
		hashCache.clear();
		hash = await getHash("RemoteFilteredProducts");
		raw = await fetchProducts(query, storeId, limit, hash);
	}

	let parsed: z.infer<typeof SearchResponseSchema>;
	try {
		parsed = SearchResponseSchema.parse(raw);
	} catch (err) {
		logger.error({ err, raw }, "Failed to parse S-Kaupat search response");
		throw err;
	}

	const { total, productListItems } = parsed.data.store.products;
	const products = productListItems.map(mapProduct);

	if (products.length === 0) {
		logger.warn({ query, storeId, total, raw }, "S-Kaupat returned 0 products");
	}

	logger.info({ query, resultCount: products.length, total }, "S-Kaupat search completed");

	return {
		products,
		totalCount: parsed.data.store.products.total,
		query,
		storeId,
		chain: "s-kaupat",
	};
}

const StoreSearchStoreSchema = z.object({
	id: z.string(),
	name: z.string(),
	location: z.object({
		address: z.object({
			postcodeName: z.object({
				default: z.string(),
			}),
		}),
	}),
});

const StoreSearchResponseSchema = z.object({
	data: z.object({
		searchStores: z.object({
			totalCount: z.number(),
			cursor: z.string().nullable(),
			stores: z.array(StoreSearchStoreSchema),
		}),
	}),
});

let allStoresCache: Store[] | null = null;

async function fetchStoreSearchPage(
	query: string | null,
	cursor: string | null,
	hash: string,
): Promise<z.infer<typeof StoreSearchResponseSchema>> {
	const url = new URL(API_URL);
	url.searchParams.set("operationName", "RemoteStoreSearch");
	url.searchParams.set("variables", JSON.stringify({ query, brand: null, cursor }));
	url.searchParams.set(
		"extensions",
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
	);

	const response = await fetch(url, {
		headers: {
			Origin: ORIGIN,
			Referer: `${ORIGIN}/`,
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (!response.ok) {
		throw new Error(`S-Kaupat store search API HTTP ${response.status}`);
	}

	const raw = await response.json();

	if (PersistedQueryNotFoundSchema.safeParse(raw).success) {
		throw new Error("PERSISTED_QUERY_NOT_FOUND");
	}

	return StoreSearchResponseSchema.parse(raw);
}

const MAX_STORE_PAGES = 50;

async function fetchAllStoresWithHash(query: string | null, hash: string): Promise<Store[]> {
	const stores: Store[] = [];
	let cursor: string | null = null;
	let pages = 0;

	do {
		const parsed = await fetchStoreSearchPage(query, cursor, hash);
		const result = parsed.data.searchStores;

		for (const s of result.stores) {
			stores.push({
				id: s.id,
				name: s.name,
				chain: "s-kaupat",
				location: s.location.address.postcodeName.default,
			});
		}

		cursor = result.cursor;
		pages++;
	} while (cursor && pages < MAX_STORE_PAGES);

	return stores;
}

async function fetchAllStores(query: string | null): Promise<Store[]> {
	let hash = await getHash("RemoteStoreSearch");

	try {
		return await fetchAllStoresWithHash(query, hash);
	} catch (err) {
		if (err instanceof Error && err.message === "PERSISTED_QUERY_NOT_FOUND") {
			logger.warn("Store search hash expired, re-extracting");
			hashCache.clear();
			hash = await getHash("RemoteStoreSearch");
			return fetchAllStoresWithHash(query, hash);
		}
		throw err;
	}
}

export async function getStores(city?: string): Promise<Store[]> {
	if (city) {
		logger.info({ city }, "Fetching S-Kaupat stores");
		const stores = await fetchAllStores(city);
		logger.info({ city, storeCount: stores.length }, "S-Kaupat stores fetched");
		return stores;
	}

	if (!allStoresCache) {
		logger.info("Fetching all S-Kaupat stores");
		allStoresCache = await fetchAllStores(null);
		logger.info({ storeCount: allStoresCache.length }, "S-Kaupat stores fetched");
	}

	return allStoresCache;
}
