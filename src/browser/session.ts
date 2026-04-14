import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const BASE_URL = "https://www.k-ruoka.fi";

let context: BrowserContext | null = null;
let page: Page | null = null;
let buildNumber: string | null = null;
let initPromise: Promise<Page> | null = null;

const dataDir = join(import.meta.dirname, "..", "..", ".browser-data");

async function launch(): Promise<void> {
	context = await chromium.launchPersistentContext(dataDir, {
		headless: true,
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		locale: "fi-FI",
	});
}

async function navigateToSite(p: Page): Promise<void> {
	const response = await p.goto(`${BASE_URL}/kauppa`, {
		waitUntil: "domcontentloaded",
		timeout: 30000,
	});
	// Wait for Cloudflare challenge to resolve
	await p.waitForFunction('document.title !== "Just a moment..."', {
		timeout: 15000,
	});

	// Extract build number from response header
	buildNumber = (await response?.headerValue("k-ruoka-build")) ?? null;

	// Fallback: extract build number from page scripts
	if (!buildNumber) {
		buildNumber = await p.evaluate(`
			(() => {
				for (const s of document.querySelectorAll("script")) {
					const match = s.textContent?.match(/"release":"(\\d+)"/);
					if (match?.[1]) return match[1];
				}
				return null;
			})()
		`);
	}
}

async function doInitialize(): Promise<Page> {
	if (!context) {
		await launch();
	}
	if (!page || page.isClosed()) {
		if (!context) throw new Error("Browser context not initialized");
		page = await context.newPage();
	}

	// Navigate to the site if not already there (needed for Cloudflare cookies)
	if (!page.url().startsWith(BASE_URL)) {
		await navigateToSite(page);
	}

	return page;
}

export async function getPage(): Promise<Page> {
	if (initPromise) return initPromise;
	initPromise = doInitialize().finally(() => {
		initPromise = null;
	});
	return initPromise;
}

export function getBuildNumber(): string {
	return buildNumber ?? "30227";
}

export async function resetSession(): Promise<void> {
	if (page && !page.isClosed()) {
		await page.close().catch(() => {});
	}
	page = null;

	if (context) {
		await context.close().catch(() => {});
	}
	context = null;

	// Nuke the data directory
	if (existsSync(dataDir)) {
		rmSync(dataDir, { recursive: true, force: true });
	}

	buildNumber = null;
}

export async function shutdown(): Promise<void> {
	if (page && !page.isClosed()) {
		await page.close();
	}
	page = null;
	if (context) {
		await context.close();
	}
	context = null;
}

function handleShutdown() {
	shutdown().finally(() => process.exit(0));
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
