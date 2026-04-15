import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { logger } from "../logger.ts";

chromium.use(StealthPlugin());

const BASE_URL = "https://www.k-ruoka.fi";

let context: BrowserContext | null = null;
let page: Page | null = null;
let buildNumber: string | null = null;
let initPromise: Promise<Page> | null = null;
let launchPromise: Promise<void> | null = null;

const dataDir =
	process.env.BROWSER_DATA_DIR ?? join(import.meta.dirname, "..", "..", ".browser-data");

async function launch(): Promise<void> {
	logger.info({ dataDir }, "Launching browser");
	context = await chromium.launchPersistentContext(dataDir, {
		headless: true,
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		locale: "fi-FI",
	});
	logger.info("Browser launched");
}

async function navigateToSite(p: Page): Promise<void> {
	logger.info("Navigating to K-Ruoka");
	const response = await p.goto(`${BASE_URL}/kauppa`, {
		waitUntil: "domcontentloaded",
		timeout: 30000,
	});
	// Cloudflare challenge page uses this title while it's active
	await p.waitForFunction('document.title !== "Just a moment..."', {
		timeout: 15000,
	});
	logger.info("Cloudflare challenge passed");

	buildNumber = (await response?.headerValue("k-ruoka-build")) ?? null;

	// Fallback: not all responses include the header
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
	logger.info({ buildNumber }, "Build number resolved");
}

async function ensureLaunched(): Promise<void> {
	if (context) return;
	if (launchPromise) return launchPromise;
	launchPromise = launch().finally(() => {
		launchPromise = null;
	});
	return launchPromise;
}

export async function getContext(): Promise<BrowserContext> {
	await ensureLaunched();
	if (!context) throw new Error("Browser context not initialized");
	return context;
}

async function doInitialize(): Promise<Page> {
	await ensureLaunched();

	if (!page || page.isClosed()) {
		if (!context) throw new Error("Browser context not initialized");
		page = await context.newPage();
	}

	// Needed to obtain Cloudflare cookies before API calls work
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
	logger.warn("Resetting browser session");
	if (page && !page.isClosed()) {
		await page.close().catch(() => {});
	}
	page = null;

	if (context) {
		await context.close().catch(() => {});
	}
	context = null;

	if (existsSync(dataDir)) {
		rmSync(dataDir, { recursive: true, force: true });
		logger.info({ dataDir }, "Browser data directory removed");
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
