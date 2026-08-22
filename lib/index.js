/**
 * `websearch-plugins` — Cordis function plugin for the DeepSeek Harness web
 * capability seam (`ctx.web`).
 *
 * Registers, with zero API credentials:
 *   - `phantom-<engine>` — every search engine in the registry (domestic
 *     Baidu/Sogou/360/Shenma/Bing-CN and overseas Bing/Google/DDG/Brave/Mojeek/
 *     Qwant/Ecosia/Yahoo/Yandex/Startpage/SearXNG), individually usable.
 *   - `phantom-aggregate` — fans out to ALL engines in parallel, keeps what
 *     succeeds and filters unreachable / blocked / empty / erroring engines at
 *     the results layer, merges across-engine deduplicated sources.
 *   - `phantom-http` — direct target-URL fetch behind the `web_fetch` tool,
 *     with per-hop SSRF protection (private/loopback/link-local are refused).
 *
 * Profile wiring (`~/.dsh/profiles/web/cordis.patch.yml`):
 *   - insert:  [web-search-phantom  name: websearch-plugins  config: {}]
 *   - web:     { searchProvider: phantom-aggregate, fetchProvider: phantom-http }
 *   - tool-web:{ fetch: true }            (base disables web_fetch)
 *
 * @module websearch-plugins
 */
import { ENGINES } from "./engines.js";
import { AggregateSearchProvider, SerpSearchProvider, resolveAggregate } from "./search.js";
import { PhantomHttpFetchProvider } from "./fetch.js";
import { DEFAULT_BLOCKED_HOSTS, DEFAULT_USER_AGENT } from "./net.js";

export { ENGINES, ENGINE_BY_ID, normalizeEngine } from "./engines.js";
export { AggregateSearchProvider, SerpSearchProvider, resolveAggregate } from "./search.js";
export { PhantomHttpFetchProvider } from "./fetch.js";
export { DEFAULT_BLOCKED_HOSTS, DEFAULT_USER_AGENT } from "./net.js";

/** Cordis plugin name — the loader resolves this in the profile node_modules. */
export const name = "websearch-plugins";
/** The web seam this plugin registers its providers into. */
export const inject = ["web"];

export const DEFAULT_CONFIG = {
	/** Per-engine results to request when the aggregate fans out. */
	engineCount: 5,
	/** Total source cap when the caller omits `maxResults`. */
	aggregateMaxResults: 10,
	/** Default per-engine fetch timeout in milliseconds. */
	engineTimeoutMs: 6000,
	/** Engine ids to include in the aggregate; empty means all. */
	include: [],
	/**
	 * Aggregate early-return tuning: once at least `aggregateQuorum` engines
	 * contributed (or the result cap is filled) AND `aggregateMinWaitMs`
	 * elapsed, the aggregate answers immediately instead of waiting for the
	 * slowest (often unreachable/blocked) engine; stragglers are dropped.
	 */
	aggregateQuorum: 3,
	aggregateMinWaitMs: 800,
	/** Short TTL cache for repeated queries (ms; 0 disables). */
	aggregateCacheMs: 30000,
	userAgent: DEFAULT_USER_AGENT,
	blockedHosts: DEFAULT_BLOCKED_HOSTS,
	/** Per-engine overrides: { <id>: {count?, timeoutMs?, fetchMode?} }. */
	engines: {},
	/**
	 * How each engine retrieves its SERP: `http` (plain browser-like fetch),
	 * `chrome` (always render in headless Chrome), or `auto` (HTTP first; fall
	 * back to headless Chrome when the body is a JS-shell / anti-bot page).
	 */
	fetchMode: "auto",
	/** Headless renderer options (persistent Blink browser + spawn fallback). */
	chrome: { path: "", timeoutMs: 7000, virtualTime: 1500, settleMs: 400, browserTimeoutMs: 12000 },
	/** web_fetch provider options. */
	fetch: { timeoutMs: 15000, maxBytesHtml: 1 << 20, maxBytesText: 1 << 19, maxRedirects: 5 }
};

/** Shallow-merge an override onto the defaults, recursing into known sections. */
function withDefaults(base, override) {
	const out = { ...base };
	for (const [key, value] of Object.entries(override ?? {})) {
		if (value === undefined) continue;
		if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
			out[key] = { ...base[key], ...value };
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Register every search engine, the aggregate, and the fetch provider with the
 * web seam. Per-search configuration is resolved lazily so later patch edits to
 * this row's `config` apply to the next operation.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context with `.web`.
 * @param {object} config - the row's resolved `config` object.
 */
export function apply(ctx, config) {
	const current = () => withDefaults(DEFAULT_CONFIG, config ?? {});
	const disposers = [];
	for (const engine of ENGINES) {
		disposers.push(ctx.web.registerSearchProvider(new SerpSearchProvider(engine, () => current())));
	}
	disposers.push(ctx.web.registerSearchProvider(new AggregateSearchProvider(() => resolveAggregate(current()))));
	disposers.push(ctx.web.registerFetchProvider(new PhantomHttpFetchProvider(() => current())));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
