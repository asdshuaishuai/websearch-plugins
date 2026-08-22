/**
 * Search providers: one generic per-engine provider and the aggregate that
 * fans out across every engine and filters failures at the results layer.
 *
 * @module websearch-plugins/search
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { clampInt, cleanUrl, httpFetch, throwIfAborted } from "./net.js";
import { ENGINE_BY_ID, looksLikeJsShell, normalizeEngine } from "./engines.js";
import { renderPage } from "./headless.js";

/**
 * Per-engine negative cache for the headless-Chrome fallback: a JS-gated
 * engine whose IP/risk-control keeps blocking even the real browser wastes
 * seconds on every search if retried endlessly. After `failBudget` consecutive
 * fallbacks that produced nothing, this process stops trying that engine.
 */
const chromeFallbackFails = new Map(); // engine.id → consecutive-fail count
const CHROME_FAIL_BUDGET = 2;

function canRetryChromeFallback(engineId) {
	return (chromeFallbackFails.get(engineId) ?? 0) < CHROME_FAIL_BUDGET;
}

function recordChromeFallbackOutcome(engineId, yieldedSources) {
	if (yieldedSources > 0) chromeFallbackFails.delete(engineId);
	else chromeFallbackFails.set(engineId, (chromeFallbackFails.get(engineId) ?? 0) + 1);
}

/** One registered engine behind `ctx.web` (id `phantom-<engine.id>`). */
export class SerpSearchProvider {
	/** @param {object} engine - engine spec from {@link ENGINES}. @param {() => object} resolve - config thunk. */
	constructor(engine, resolve) {
		this.engine = engine;
		this.resolve = resolve;
		this.id = `phantom-${engine.id}`;
	}

	available() {
		return true;
	}

	async search(request, signal) {
		const config = this.resolve() ?? {};
		const per = config.engines?.[this.engine.id] ?? {};
		const count = clampInt(request.maxResults ?? per.count ?? config.engineCount ?? 5, 1, this.engine.countMax, 5);
		const timeoutMs = per.timeoutMs ?? config.engineTimeoutMs ?? 7000;
		const mode = per.fetchMode ?? config.fetchMode ?? "auto";
		const chromeCfg = config.chrome ?? {};
		const url = this.engine.buildUrl(request.query, count, per);

		let html;
		if (mode === "chrome") {
			html = await renderPage(url, { chrome: chromeCfg, signal });
		} else {
			const response = await httpFetch(url, {
				timeoutMs,
				signal,
				headers: { "user-agent": config.userAgent }
			});
			if (!response.ok) {
				throw new WebError(`${this.engine.label} returned HTTP ${response.status}`, "WEB_PROVIDER_ERROR");
			}
			html = await response.text();
			throwIfAborted(signal);
			// PhantomJS-style: a JS-shell / anti-bot page needs a real headless
			// browser (a dedicated persistent Blink renderer) to execute. Fall
			// back when the body carries no result markers but smells like a
			// challenge — capped by the per-engine negative cache so IP-blocked
			// engines stop costing seconds on later searches.
			if (mode === "auto" && looksLikeJsShell(this.engine, html) && canRetryChromeFallback(this.engine.id)) {
				try {
					const rendered = await renderPage(url, { chrome: chromeCfg, signal });
					if (rendered.length > html.length * 0.6) html = rendered;
				} catch {
					// keep the original HTML; the engine will simply contribute nothing
				}
			}
		}

		const sources = normalizeEngine(this.engine, html, config);
		// Negative-cache bookkeeping so a blocked engine doesn't burn a Chrome
		// round every search (resets if a later attempt finally yields results).
		if (mode === "auto" && looksLikeJsShell(this.engine, html)) {
			recordChromeFallbackOutcome(this.engine.id, sources.length);
		}
		return { sources: sources.slice(0, count), truncated: sources.length > count };
	}
}

/**
 * The aggregate search provider (`phantom-aggregate`). Runs every configured
 * engine in parallel, keeps what succeeds, filters out engines that error,
 * time out, are blocked, or return nothing parseable, then merges, cross-engine
 * dedupes by normalized URL, and caps to the requested result count.
 */
export class AggregateSearchProvider {
	id = "phantom-aggregate";

	/** @param {() => {providers: SerpSearchProvider[], config: object}} resolve - engine set + config for the next search. */
	constructor(resolve) {
		this.resolve = resolve;
	}

	available() {
		return true;
	}

	async search(request, signal) {
		const { providers, config } = this.resolve();
		const max = clampInt(request.maxResults ?? config.aggregateMaxResults ?? 10, 1, 30, 10);
		const perEngine = clampInt(config.engineCount ?? 5, 1, 15, 5);

		// Short TTL cache so repeated queries don't re-hit all 16 engines.
		const cacheMs = clampInt(config.aggregateCacheMs ?? 0, 0, 300000, 0);
		const cacheKey = `${request.query}\u0000${max}`;
		if (cacheMs > 0) {
			const hit = aggregateCache.get(cacheKey);
			if (hit && Date.now() - hit.at < cacheMs) return hit.value;
		}

		const result = await runFanOut(providers, config, request, signal, max, perEngine);

		if (cacheMs > 0 && !signal?.aborted) {
			aggregateCache.set(cacheKey, { at: Date.now(), value: result });
			while (aggregateCache.size > 64) aggregateCache.delete(aggregateCache.keys().next().value);
		}
		return result;
	}
}

/** Small capped TTL cache (module-private): query → aggregate result. */
const aggregateCache = new Map();

/**
 * Fan out to every engine and resolve as soon as the aggregate is "good
 * enough", without waiting for the slowest engine: quorum engines already
 * contributed (or the requested result count is filled) and a minimum wait
 * window elapsed → return with what we have; stragglers settle in the
 * background (their outcomes are simply dropped, so a dead/unreachable engine
 * can never hold the answer hostage).
 */
async function runFanOut(providers, config, request, signal, max, perEngine) {
	const quorumEngines = clampInt(config.aggregateQuorum ?? 3, 1, 8, 3);
	const minWaitMs = clampInt(config.aggregateMinWaitMs ?? 800, 0, 5000, 800);
	const started = Date.now();

	const byEngine = []; // index → sources once that engine reports (only ever grows)
	const failed = [];
	const empty = [];
	let done = 0;

	const mergedFrom = () => {
		// Round-robin across engines so the top slice spans many engines, then
		// cross-engine dedupe (a later richer entry replaces a bare-URL twin).
		const merged = new Map();
		for (let rank = 0; byEngine.some((list) => list && rank < list.length); rank += 1) {
			for (const list of byEngine) {
				const source = list?.[rank];
				if (!source) continue;
				const key = cleanUrl(source.url);
				const existing = merged.get(key);
				if (!existing) merged.set(key, source);
				else if (!existing.snippet && source.snippet) merged.set(key, { ...existing, snippet: source.snippet });
			}
		}
		return [...merged.values()];
	};

	return new Promise((resolve, reject) => {
		const settle = () => {
			if (signal?.aborted) {
				reject(new WebError("search aborted", "WEB_ABORTED", { cause: signal.reason }));
				return;
			}
			const all = mergedFrom();
			const sources = all.slice(0, max);
			const okEngines = providers.filter((_, i) => byEngine[i]?.length > 0);
			const domestic = okEngines.filter((p) => p.engine.region === "domestic").length;
			const overseas = okEngines.filter((p) => p.engine.region === "overseas").length;
			const total = providers.length;
			const early = done < total;
			const notes = [];
			if (failed.length) notes.push(`已过滤 ${failed.length} 个异常引擎: ${failed.join("；")}`);
			if (empty.length) notes.push(`已过滤 ${empty.length} 个无结果引擎: ${empty.join("；")}`);
			const summary =
				sources.length > 0
					? `聚合自 ${total} 个引擎（国内 ${domestic}/${engCount("domestic", providers)} 个、海外 ${overseas}/${engCount("overseas", providers)} 个成功）${early ? `，已提前返回（${total - done} 个在途引擎略过）` : ""}。`
					: `聚合搜索未获得任何结果（${total} 个引擎全部异常或无结果）。`;
			resolve({ content: [summary, ...notes].join("\n"), sources, truncated: all.length > max });
		};

		const checkEarly = () => {
			if (Date.now() - started < minWaitMs || done === providers.length) return false;
			const withResults = providers.filter((_, i) => byEngine[i]?.length > 0).length;
			const filled = mergedFrom().length >= Math.min(max, 4);
			return withResults >= quorumEngines || filled;
		};

		providers.forEach((provider, i) => {
			provider.search({ query: request.query, maxResults: perEngine }, signal).then(
				(outcome) => {
					byEngine[i] = outcome.sources ?? [];
					if (byEngine[i].length === 0) empty.push(provider.engine.label);
					done += 1;
					if (checkEarly()) settle();
					else if (done === providers.length) settle();
				},
				(error) => {
					const reason = error?.message ? String(error.message).replace(/\s+/g, " ").slice(0, 90) : String(error);
					failed.push(`${provider.engine.label}${reason && !/WEB_/i.test(reason) ? ` (${reason})` : ""}`);
					done += 1;
					if (checkEarly()) settle();
					else if (done === providers.length) settle();
				}
			);
		});
		if (providers.length === 0) settle();
	});
}

function engCount(region, providers) {
	return providers.filter((p) => p.engine.region === region).length;
}

/** Resolve the engine set serving the aggregate: `include: []` means all. */
export function resolveAggregate(config) {
	const include = config.include?.length ? config.include : [...ENGINE_BY_ID.keys()];
	const engines = include.map((id) => ENGINE_BY_ID.get(id)).filter(Boolean);
	const providers = engines.map((engine) => new SerpSearchProvider(engine, () => config));
	return { providers, config };
}
