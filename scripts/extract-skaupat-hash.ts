/**
 * Extracts S-Kaupat persisted query hashes by intercepting Apollo Client requests.
 *
 * Navigates to the search page and captures the outgoing GraphQL request URLs
 * via Playwright route interception (bypasses CORS). Returns the hashes keyed
 * by operation name.
 */
import { chromium } from "playwright";

const TARGET_OPS = new Set(["RemoteFilteredProducts"]);

async function extractHashes(): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();

	await page.route("https://api.s-kaupat.fi/**", async (route) => {
		const url = new URL(route.request().url());
		const op = url.searchParams.get("operationName");
		const ext = url.searchParams.get("extensions");

		if (op && ext) {
			try {
				const parsed = JSON.parse(ext);
				const hash = parsed?.persistedQuery?.sha256Hash;
				if (hash) hashes.set(op, hash);
			} catch {}
		}

		// Mock response so the page continues rendering
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ data: {} }),
		});
	});

	await page.goto("https://www.s-kaupat.fi/hakutulokset?queryString=test", {
		waitUntil: "networkidle",
		timeout: 30_000,
	});

	await browser.close();
	return hashes;
}

const hashes = await extractHashes();
for (const [op, hash] of hashes) {
	const marker = TARGET_OPS.has(op) ? " ✓" : "";
	console.log(`${op}: ${hash}${marker}`);
}

if (!hashes.has("RemoteFilteredProducts")) {
	console.error("\nRemoteFilteredProducts hash not found!");
	process.exit(1);
}
