import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import * as alko from "../browser/alko.ts";
import * as kRuoka from "../browser/k-ruoka.ts";
import * as sKaupat from "../browser/s-kaupat.ts";

export function registerSearchTool(server: McpServer): void {
	server.registerTool(
		"search_products",
		{
			description:
				"Search for products. Supports K-Ruoka (k-ruoka.fi), S-Kaupat (s-kaupat.fi), and Alko (alko.fi). Requires chain from get_stores. storeId is required for K-Ruoka and S-Kaupat, optional for Alko (national catalog).",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search query (e.g., 'maito', 'leipä', 'punaviini')"),
				storeId: z
					.string()
					.optional()
					.describe(
						"Store ID from get_stores. Required for k-ruoka and s-kaupat. Optional for alko (filters to products available at that store).",
					),
				chain: z.enum(["k-ruoka", "s-kaupat", "alko"]).describe("Which chain to search"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.default(10)
					.describe("Maximum number of results to return (default: 10, max: 50)"),
			}),
		},
		async ({ query, storeId, chain, limit }) => {
			try {
				if ((chain === "k-ruoka" || chain === "s-kaupat") && !storeId) {
					return {
						content: [
							{
								type: "text" as const,
								text: `storeId is required for ${chain}. Call get_stores first to get a valid storeId.`,
							},
						],
						isError: true,
					};
				}

				const result =
					chain === "k-ruoka"
						? await kRuoka.searchProducts(query, storeId ?? "", limit)
						: chain === "s-kaupat"
							? await sKaupat.searchProducts(query, storeId ?? "", limit)
							: await alko.searchProducts(query, storeId, limit);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error searching products: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
