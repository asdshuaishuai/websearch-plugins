#!/usr/bin/env node
/**
 * Failure attribution probe — no harness needed.
 *
 * For every engine it fetches the SERP with a full browser-like header set and
 * classifies the outcome:
 *   NETWORK  — connect unreachable / timeout / DNS failure (out of scope)
 *   GATED    — reachable but 403 / captcha / "enable JavaScript" shell / weird
 *              challenge markers  → non-network, needs browser-fingerprint work
 *   PARSED   — HTTP 2xx and the body carries the engine's result markers
 *   EMPTY    — HTTP 2xx but no result markers in the body (parser/JS-shell)
 *   OTHER    — anything else
 *
 * Usage:  node test/diagnose.mjs [query] [timeoutMs per engine]
 * @module websearch-plugins/test
 */
import { ENGINES, hasResultMarkers, looksLikeJsShell } from "../lib/engines.js";
import { BROWSER_HEADERS } from "../lib/net.js";

const query = process.argv[2] ?? "DeepSeek";
const timeoutMs = Number(process.argv[3] ?? 12000);

function classify(engine, status, body) {
	if (status !== 200) {
		return status === 403 || status === 429
			? { kind: "GATED", detail: `HTTP ${status} (anti-bot/rate-limited)` }
			: { kind: "GATED", detail: `HTTP ${status}` };
	}
	// a real SERP carries result markers even if it also mentions challenges
	if (hasResultMarkers(engine, body)) return { kind: "PARSED", detail: "result markers present" };
	if (looksLikeJsShell(engine, body)) return { kind: "GATED", detail: "JS-shell / anti-bot challenge" };
	if (body.trim().length === 0) return { kind: "OTHER", detail: "empty body" };
	return { kind: "EMPTY", detail: `2xx, no result markers (${body.length}B)` };
}

const rows = [];
let timedOut = 0;
let network = 0;
for (const engine of ENGINES) {
	const url = engine.buildUrl(query, 5, {});
	const start = Date.now();
	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
			headers: { ...BROWSER_HEADERS }
		});
		const body = await res.text();
		const cls = classify(engine, res.status, body);
		rows.push({ engine: engine.label, region: engine.region, kind: cls.kind, detail: `${res.status}/${res.headers.get("content-type")?.split(";")[0] ?? "?"} ${Date.now() - start}ms ${cls.detail}` });
	} catch (error) {
		const name = error?.name ?? "";
		if (name === "TimeoutError") ranged(timedOut);
		const netLike = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EPROTO|UND_ERR_CONNECT|U_ERR/i.test(String(error));
		if (netLike) network += 1;
		rows.push({ engine: engine.label, region: engine.region, kind: netLike ? "NETWORK" : "GATED", detail: `~${Date.now() - start}ms ${String(error).replace(/\s+/g, " ").slice(0, 70)}` });
	}
}

function ranged(n) {
	void n;
}

console.log(`diagnose query=${JSON.stringify(query)} timeout=${timeoutMs}ms (browser-like headers)\n`);
const order = { PARSED: 0, EMPTY: 1, GATED: 2, NETWORK: 3, OTHER: 4 };
for (const r of rows.sort((a, b) => order[a.kind] - order[b.kind] || (a.region === b.region ? 0 : a.region === "domestic" ? -1 : 1))) {
	console.log(`[${r.kind.padEnd(7)}] ${r.region.padEnd(8)} ${r.engine.padEnd(20)} ${r.detail}`);
}
const counts = {};
for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
console.log(`\nsummary: ${JSON.stringify(counts)}`);
