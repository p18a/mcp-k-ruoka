import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import * as alko from "../browser/alko.ts";
import * as kRuoka from "../browser/k-ruoka.ts";
import * as sKaupat from "../browser/s-kaupat.ts";
import { logger } from "../logger.ts";
import type { Chain, Store } from "../types.ts";

export function registerStoresTool(server: McpServer): void {
	server.registerTool(
		"get_stores",
		{
			description:
				"List stores from K-Ruoka (k-ruoka.fi), S-Kaupat (s-kaupat.fi), and Alko (alko.fi). Returns store IDs and chain values needed for search_products.",
			inputSchema: z.object({
				city: z
					.string()
					.optional()
					.describe("Filter stores by city name (e.g., 'Helsinki', 'Tampere')"),
				chain: z
					.enum(["k-ruoka", "s-kaupat", "alko"])
					.optional()
					.describe("Filter by chain. If omitted, returns stores from all chains."),
			}),
		},
		async ({ city, chain }) => {
			const fetchers: Array<{ chain: Chain; promise: Promise<Store[]> }> = [];

			if (!chain || chain === "k-ruoka") {
				fetchers.push({ chain: "k-ruoka", promise: kRuoka.getStores(city) });
			}
			if (!chain || chain === "s-kaupat") {
				fetchers.push({ chain: "s-kaupat", promise: sKaupat.getStores(city) });
			}
			if (!chain || chain === "alko") {
				fetchers.push({ chain: "alko", promise: alko.getStores(city) });
			}

			const settled = await Promise.allSettled(fetchers.map((f) => f.promise));

			const stores: Store[] = [];
			const errors: string[] = [];

			for (const [i, result] of settled.entries()) {
				const chainName = fetchers[i]?.chain ?? "unknown";
				if (result.status === "fulfilled") {
					stores.push(...result.value);
				} else {
					const reason: unknown = result.reason;
					const msg = reason instanceof Error ? reason.message : String(reason);
					logger.error({ chain: chainName, err: reason }, "Store fetch failed");
					errors.push(`${chainName}: ${msg}`);
				}
			}

			if (stores.length === 0 && errors.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error fetching stores: ${errors.join("; ")}`,
						},
					],
					isError: true,
				};
			}

			const parts: string[] = [JSON.stringify(stores, null, 2)];
			if (errors.length > 0) {
				parts.push(`\nWarning: some chains failed: ${errors.join("; ")}`);
			}

			return {
				content: [{ type: "text" as const, text: parts.join("") }],
			};
		},
	);
}
