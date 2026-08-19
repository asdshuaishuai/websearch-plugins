#!/usr/bin/env node
/**
 * Standalone check for the persistent headless-Blob renderer (lib/headless.js).
 *
 * Usage:  node test/headless.mjs [url]
 * @module websearch-plugins/test
 */
import { disposeHeadless, renderPage } from "../lib/headless.js";

const url = process.argv[2] ?? "https://www.bing.com/search?q=DeepSeek&format=rss";

// 1) JS execution proof via a data URL — set an attribute on <html>, which runs
//    even though the script lives in <head> before <body> exists.
try {
	const jsProof = await renderPage("data:text/html,<script>document.documentElement.setAttribute('data-js','ok');</script>", { chrome: { settleMs: 300 } });
	const got = /data-js="ok"/.test(jsProof);
	console.log(`[JS execution] ${got ? "PASS" : "FAIL"}  (marker present: ${got})`);
} catch (err) {
	console.log(`[JS execution] FAIL ${String(err.message).slice(0, 80)}`);
}

// 2) real SERP render — warm up the persistent browser
const t1 = Date.now();
let dom;
try {
	dom = await renderPage(url, { chrome: { settleMs: 800 } });
	console.log(`[render 1] ${dom.length}B in ${Date.now() - t1}ms  results-populated=${/>result|result__a|b_algo|<article/i.test(dom)}`);
} catch (err) {
	console.log(`[render 1] FAIL ${String(err.message).slice(0, 100)}`);
}

// 3) reuse performance (same persistent browser)
const t2 = Date.now();
try {
	const dom2 = await renderPage(url, { chrome: { settleMs: 800 } });
	console.log(`[render 2] ${dom2.length}B in ${Date.now() - t2}ms  (reuse via persistent browser)`);
} catch (err) {
	console.log(`[render 2] FAIL ${String(err.message).slice(0, 100)}`);
}

await disposeHeadless();
console.log("[dispose] persistent browser torn down");
