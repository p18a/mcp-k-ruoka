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

// --- Persisted query hash cache ---

const hashCache = new Map<string, string>();
let extractPromise: Promise<void> | null = null;

async function extractHashes(): Promise<void> {
	logger.info("Extracting S-Kaupat persisted query hashes");
	const ctx = await getContext();
	const page = await ctx.newPage();

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

		await page.goto(`${ORIGIN}/hakutulokset?queryString=test`, {
			waitUntil: "networkidle",
			timeout: 30_000,
		});
	} finally {
		await page.close();
	}

	logger.info({ operations: [...hashCache.keys()] }, "S-Kaupat hashes extracted");
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

// --- Zod schemas for product search response ---

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

// --- Product mapping ---

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

// --- Product search ---

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
		logger.error({ err }, "Failed to parse S-Kaupat search response");
		throw err;
	}

	const products = parsed.data.store.products.productListItems.map(mapProduct);

	logger.info({ query, resultCount: products.length }, "S-Kaupat search completed");

	return {
		products,
		totalCount: parsed.data.store.products.total,
		query,
		storeId,
		chain: "s-kaupat",
	};
}

// --- Store listing (scraped from server-rendered HTML) ---

const STORE_BRANDS = [
	"prisma",
	"s-market",
	"alepa",
	"sale",
	"herkku",
	"sokos-herkku",
	"mestarin-herkku",
];

const STORE_CARD_RE =
	/href="\/myymala\/([\w-]+)\/(\d+)".*?data-test-id="store-title">([^<]+)<\/h2>.*?<\/svg><\/span><span>([^<]+)<\/span>/gs;

let storeCache: Store[] | null = null;

function parseCityFromAddress(address: string): string {
	const match = address.match(/\d{5}\s+(.+)/);
	return match?.[1] ?? address;
}

async function fetchBrandStores(brand: string): Promise<Store[]> {
	const response = await fetch(`${ORIGIN}/myymalat/${brand}`, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html",
		},
		signal: AbortSignal.timeout(API_TIMEOUT),
	});

	if (!response.ok) {
		logger.warn({ brand, status: response.status }, "Failed to fetch S-Kaupat store page");
		return [];
	}

	const html = await response.text();
	const stores: Store[] = [];

	for (const match of html.matchAll(STORE_CARD_RE)) {
		const id = match[2];
		const name = match[3];
		const address = match[4];
		if (!id || !name || !address) continue;
		stores.push({
			id,
			name,
			chain: "s-kaupat",
			location: parseCityFromAddress(address),
		});
	}

	return stores;
}

export async function getStores(city?: string): Promise<Store[]> {
	if (!storeCache) {
		logger.info("Fetching S-Kaupat store listings");
		const results = await Promise.all(STORE_BRANDS.map(fetchBrandStores));
		storeCache = results.flat();
		logger.info({ storeCount: storeCache.length }, "S-Kaupat stores fetched");
	}

	if (city) {
		const lower = city.toLowerCase();
		return storeCache.filter((s) => s.location.toLowerCase().includes(lower));
	}

	return storeCache;
}
