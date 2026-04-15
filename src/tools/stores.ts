import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import * as kRuoka from "../browser/k-ruoka.ts";
import * as sKaupat from "../browser/s-kaupat.ts";
import type { Store } from "../types.ts";

export function registerStoresTool(server: McpServer): void {
	server.registerTool(
		"get_stores",
		{
			description:
				"List grocery stores from K-Ruoka (k-ruoka.fi) and S-Kaupat (s-kaupat.fi) chains. Returns store IDs needed for search_products. Always call this first to get a valid storeId and chain before searching.",
			inputSchema: z.object({
				city: z
					.string()
					.optional()
					.describe("Filter stores by city name (e.g., 'Helsinki', 'Tampere')"),
				chain: z
					.enum(["k-ruoka", "s-kaupat"])
					.optional()
					.describe("Filter by grocery chain. If omitted, returns stores from both chains."),
			}),
		},
		async ({ city, chain }) => {
			try {
				const fetchers: Promise<Store[]>[] = [];

				if (!chain || chain === "k-ruoka") {
					fetchers.push(kRuoka.getStores(city));
				}
				if (!chain || chain === "s-kaupat") {
					fetchers.push(sKaupat.getStores(city));
				}

				const results = (await Promise.all(fetchers)).flat();

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(results, null, 2),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error fetching stores: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
