#!/usr/bin/env node
/**
 * Simulate the seam: fake a minimal `ctx.web` (registerSearchProvider +
 * registerFetchProvider), call the plugin's `apply`, then exercise the
 * aggregate search and the direct-URL fetch provider exactly as the harness
 * would through `ctx.web.search()` / `ctx.web.fetch()`.
 *
 * Usage:  node test/plugin.mjs [query]
 * @module websearch-plugins/test
 */
import { apply, name as pluginName, inject, DEFAULT_CONFIG } from "../lib/index.js";

const query = process.argv[2] ?? "DeepSeek Harness";

const searchProviders = [];
const fetchProviders = [];
const ctx = {
	web: {
		registerSearchProvider(provider) {
			searchProviders.push(provider);
			return () => {
				const i = searchProviders.indexOf(provider);
				if (i >= 0) searchProviders.splice(i, 1);
			};
		},
		registerFetchProvider(provider) {
			fetchProviders.push(provider);
			return () => {
				const i = fetchProviders.indexOf(provider);
				if (i >= 0) fetchProviders.splice(i, 1);
			};
		}
	}
};

const dispose = apply(ctx, { ...DEFAULT_CONFIG, engineTimeoutMs: 8000 });
console.log(`plugin name=${pluginName} inject=${JSON.stringify(inject)}`);
console.log(`registered search providers: ${searchProviders.map((p) => p.id).join(", ")}`);
console.log(`registered fetch providers: ${fetchProviders.map((p) => p.id).join(", ")}`);

let exit = 0;
try {
	const result = await searchProviders.find((p) => p.id === "phantom-aggregate").search({ query, maxResults: 8 });
	console.log(`\n== aggregate: ${result.sources.length} source(s) ==`);
	console.log(result.content);
	for (const s of result.sources.slice(0, 8)) console.log(`  • ${s.title ?? "(no title)"}\n    ${s.url}`);
} catch (error) {
	console.error("aggregate FAILED:", String(error?.message ?? error));
	exit = 1;
}

try {
	const fetcher = fetchProviders.find((p) => p.id === "phantom-http");
	const fetched = await fetcher.fetch({ url: "https://example.com/" }, undefined);
	console.log(`\n== fetch example.com -> HTTP ${fetched.statusCode} (${fetched.body.kind}, truncated=${fetched.truncated}) ==`);
	console.log(fetched.body.content.slice(0, 200).replace(/\s+/g, " "));
	// SSRF guard must refuse a private address.
	try {
		await fetcher.fetch({ url: "http://127.0.0.1/" }, undefined);
		console.error("!! SSRF guard did not block 127.0.0.1");
		exit = 1;
	} catch (error) {
		console.log(`SSRF guard blocked 127.0.0.1 -> ${String(error?.message ?? error).slice(0, 80)}`);
	}
} catch (error) {
	console.error("fetch FAILED:", String(error?.message ?? error));
	exit = 1;
}

dispose();
console.log(`\ndisposed; remaining search providers: ${searchProviders.length}, fetch providers: ${fetchProviders.length}`);
process.exit(exit);
