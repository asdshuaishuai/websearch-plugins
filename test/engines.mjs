#!/usr/bin/env node
/**
 * Engine sweep: hits every registered engine once (short timeout) and reports
 * reachability + parsed-result counts. Engines that fail are expected — that is
 * exactly what the aggregate filters at the results layer.
 *
 * Usage:  node test/engines.mjs [query] [timeoutMs]
 * @module websearch-plugins/test
 */
import { ENGINES, normalizeEngine } from "../lib/engines.js";
import { SerpSearchProvider } from "../lib/search.js";
import { DEFAULT_BLOCKED_HOSTS, DEFAULT_USER_AGENT } from "../lib/net.js";

const query = process.argv[2] ?? "headless browser";
const timeoutMs = Number(process.argv[3] ?? 8000);

const config = {
	userAgent: DEFAULT_USER_AGENT,
	blockedHosts: DEFAULT_BLOCKED_HOSTS,
	engineTimeoutMs: timeoutMs,
	engines: {}
};

console.log(`engine sweep: query=${JSON.stringify(query)} timeout=${timeoutMs}ms\n`);
const rows = [];
for (const engine of ENGINES) {
	const provider = new SerpSearchProvider(engine, () => config);
	const start = Date.now();
	try {
		const result = await provider.search({ query, maxResults: 5 });
		const ms = Date.now() - start;
		rows.push({ label: engine.label, region: engine.region, ok: true, n: result.sources.length, ms });
	} catch (error) {
		rows.push({ label: engine.label, region: engine.region, ok: false, n: 0, ms: Date.now() - start, err: String(error?.message ?? error).slice(0, 90) });
	}
}

let ok = 0;
for (const r of rows) {
	if (r.ok) ok += 1;
	const mark = r.ok ? "OK " : "FAIL";
	const detail = r.ok ? `${r.n} results in ${r.ms}ms` : `~${r.ms}ms ${r.err ?? ""}`;
	console.log(`[${mark}] ${r.region.padEnd(8)} ${r.label.padEnd(22)} ${detail}`);
}
console.log(`\n${ok}/${rows.length} engines reachable & parseable (rest are filtered by the aggregate).`);
