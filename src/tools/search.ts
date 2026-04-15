import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import * as kRuoka from "../browser/k-ruoka.ts";
import * as sKaupat from "../browser/s-kaupat.ts";

export function registerSearchTool(server: McpServer): void {
	server.registerTool(
		"search_products",
		{
			description:
				"Search for grocery products filtered by store location. Supports K-Ruoka and S-Kaupat chains.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search query for products (e.g., 'maito', 'leipä')"),
				storeId: z
					.string()
					.describe(
						"Store ID from get_stores (e.g., 'N123' for K-Ruoka, '513971200' for S-Kaupat). Must be an ID, not a store name.",
					),
				chain: z.enum(["k-ruoka", "s-kaupat"]).describe("Which grocery chain to search"),
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
				const result =
					chain === "k-ruoka"
						? await kRuoka.searchProducts(query, storeId, limit)
						: await sKaupat.searchProducts(query, storeId, limit);
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
