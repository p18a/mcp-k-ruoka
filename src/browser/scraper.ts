import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { Product, SearchResult, Store } from "../types.ts";
import { getBuildNumber, getPage, resetSession } from "./session.ts";

// -- Zod schemas for API responses --

const BlockedResponseSchema = z.object({
	_blocked: z.literal(true),
	_status: z.number(),
	_body: z.string(),
});

const ApiProductSchema = z.object({
	id: z.string(),
	product: z.object({
		ean: z.string(),
		localizedName: z.object({ finnish: z.string() }),
		images: z.array(z.string()).optional(),
		mobilescan: z
			.object({
				pricing: z
					.object({
						normal: z
							.object({
								price: z.number(),
								unitPrice: z
									.object({
										value: z.number(),
										unit: z.string(),
										contentSize: z.number(),
									})
									.optional(),
							})
							.optional(),
					})
					.optional(),
			})
			.optional(),
		brand: z.object({ name: z.string() }).optional(),
		category: z
			.object({
				localizedName: z.object({ finnish: z.string() }).optional(),
			})
			.optional(),
	}),
});

const ApiSearchResponseSchema = z.object({
	result: z.array(ApiProductSchema).optional(),
	error: z.object({ message: z.string() }).optional(),
});

const SearchEvalResultSchema = z.union([BlockedResponseSchema, ApiSearchResponseSchema]);
type SearchEvalResult = z.infer<typeof SearchEvalResultSchema>;

const ApiStoreSchema = z.object({
	id: z.string(),
	name: z.string(),
	chain: z.string(),
	chainName: z.string(),
	location: z.string(),
	isWebStore: z.boolean(),
});

const ApiStoresResponseSchema = z.object({
	results: z.array(ApiStoreSchema).optional(),
});

const StoresEvalResultSchema = z.union([BlockedResponseSchema, ApiStoresResponseSchema]);
type StoresEvalResult = z.infer<typeof StoresEvalResultSchema>;

// -- Helpers --

function isBlocked(
	data: SearchEvalResult | StoresEvalResult,
): data is z.infer<typeof BlockedResponseSchema> {
	return "_blocked" in data;
}

function parseProduct(item: z.infer<typeof ApiProductSchema>): Product {
	const p = item.product;
	const pricing = p.mobilescan?.pricing?.normal;
	const unitPrice = pricing?.unitPrice;

	return {
		name: p.localizedName.finnish,
		price: pricing?.price ?? null,
		unitPrice: unitPrice
			? `${unitPrice.value.toFixed(2).replace(".", ",")} €/${unitPrice.unit}`
			: null,
		ean: p.ean,
		imageUrl: p.images?.[0] ?? null,
		brand: p.brand?.name ?? null,
		category: p.category?.localizedName?.finnish ?? null,
	};
}

// -- API fetchers --

async function fetchSearchApi(
	query: string,
	storeId: string,
	limit: number,
): Promise<SearchEvalResult> {
	const page = await getPage();
	const buildNumber = getBuildNumber();

	const raw = await page.evaluate(
		async ({
			query,
			storeId,
			limit,
			buildNumber,
		}: {
			query: string;
			storeId: string;
			limit: number;
			buildNumber: string;
		}) => {
			const params = new URLSearchParams({
				offset: "0",
				language: "fi",
				storeId,
				limit: String(limit),
				discountFilter: "false",
				isTosTrOffer: "false",
			});
			const res = await fetch(`/kr-api/v2/product-search/${encodeURIComponent(query)}?${params}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"x-k-build-number": buildNumber,
				},
			});
			const body = await res.text();
			if (res.status === 403 || body.includes("cf-challenge")) {
				return { _blocked: true, _status: res.status, _body: body };
			}
			return JSON.parse(body);
		},
		{ query, storeId, limit, buildNumber },
	);

	return SearchEvalResultSchema.parse(raw);
}

async function fetchStoresApi(): Promise<StoresEvalResult> {
	const page = await getPage();

	const raw = await page.evaluate(async () => {
		const res = await fetch("/kr-api/stores");
		const body = await res.text();
		if (res.status === 403 || body.includes("cf-challenge")) {
			return { _blocked: true, _status: res.status, _body: body };
		}
		return JSON.parse(body);
	});

	return StoresEvalResultSchema.parse(raw);
}

// -- Exported functions --

export async function searchProducts(
	query: string,
	storeId: string,
	limit: number,
): Promise<SearchResult> {
	logger.info({ query, storeId, limit }, "Searching products");

	let data = await fetchSearchApi(query, storeId, limit);

	if (isBlocked(data)) {
		logger.warn({ status: data._status }, "Cloudflare block on product search, resetting session");
		await resetSession();
		data = await fetchSearchApi(query, storeId, limit);
		if (isBlocked(data)) {
			throw new Error("Blocked by Cloudflare after session reset");
		}
	}

	if (data.error) {
		throw new Error(`K-Ruoka API error: ${data.error.message}`);
	}

	const products = (data.result ?? []).map(parseProduct);

	logger.info({ query, resultCount: products.length }, "Product search completed");

	return {
		products,
		totalCount: products.length,
		query,
		storeId,
	};
}

export async function getStores(city?: string): Promise<Store[]> {
	logger.info({ city: city ?? "all" }, "Fetching stores");

	let data = await fetchStoresApi();

	if (isBlocked(data)) {
		logger.warn({ status: data._status }, "Cloudflare block on stores fetch, resetting session");
		await resetSession();
		data = await fetchStoresApi();
		if (isBlocked(data)) {
			throw new Error("Blocked by Cloudflare after session reset");
		}
	}

	let stores = (data.results ?? [])
		.filter((s) => s.isWebStore)
		.map((s) => ({
			id: s.id,
			name: s.name,
			chain: s.chainName,
			location: s.location,
		}));

	if (city) {
		const lower = city.toLowerCase();
		stores = stores.filter((s) => s.location.toLowerCase().includes(lower));
	}

	logger.info({ city: city ?? "all", storeCount: stores.length }, "Stores fetched");

	return stores;
}
