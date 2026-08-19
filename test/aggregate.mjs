#!/usr/bin/env node
/**
 * Runs the aggregate provider directly: parallel fan-out, failure filtering,
 * cross-engine dedupe, and the aggregate summary.
 *
 * Usage:  node test/aggregate.mjs [query] [maxResults]
 * @module websearch-plugins/test
 */
import { AggregateSearchProvider, resolveAggregate } from "../lib/search.js";
import { DEFAULT_USER_AGENT } from "../lib/net.js";

const query = process.argv[2] ?? "DeepSeek Harness";
const maxResults = Number(process.argv[3] ?? 10);

const config = {
	userAgent: DEFAULT_USER_AGENT,
	engineTimeoutMs: 8000,
	aggregateCount: 5,
	aggregateMaxResults: maxResults,
	include: [],
	blockedHosts: ["www.microsoft.com", "www.msn.com"]
};

const provider = new AggregateSearchProvider(() => resolveAggregate(config));
const started = Date.now();
try {
	const result = await provider.search({ query, maxResults }, undefined);
	console.log(`aggregate -> ${result.sources.length} source(s) (truncated=${result.truncated}) in ${Date.now() - started}ms`);
	console.log(`content:\n${result.content}`);
	console.log("\nsources:");
	for (const s of result.sources) {
		console.log(`  • ${s.title ?? "(no title)"}`);
		console.log(`    ${s.url}`);
	}
	process.exit(0);
} catch (error) {
	console.error("aggregate FAILED:", String(error?.message ?? error));
	process.exit(1);
}
