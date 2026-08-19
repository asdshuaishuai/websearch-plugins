/**
 * Search providers: one generic per-engine provider and the aggregate that
 * fans out across every engine and filters failures at the results layer.
 *
 * @module websearch-plugins/search
 */
import { clampInt, cleanUrl, httpFetch, requireOk, throwIfAborted } from "./net.js";
import { ENGINE_BY_ID, normalizeEngine } from "./engines.js";

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
		const url = this.engine.buildUrl(request.query, count, per);

		const response = await httpFetch(url, {
			timeoutMs,
			signal,
			headers: { "user-agent": config.userAgent }
		});
		await requireOk(response, this.engine.label);
		const text = await response.text();
		throwIfAborted(signal);

		const sources = normalizeEngine(this.engine, text, config);
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

		const tasks = providers.map((provider) => provider.search({ query: request.query, maxResults: perEngine }, signal));
		const settled = await Promise.allSettled(tasks);
		throwIfAborted(signal);

		const byEngine = []; // per-engine ordered source arrays (domestic→overseas)
		const failed = [];
		const empty = [];
		const okEngines = [];
		settled.forEach((outcome, i) => {
			const provider = providers[i];
			if (outcome.status === "fulfilled") {
				const sources = outcome.value.sources;
				if (sources.length === 0) {
					empty.push(provider.engine.label);
					return;
				}
				okEngines.push(provider.engine);
				byEngine.push(sources);
			} else {
				const reason = outcome.reason?.message ? String(outcome.reason.message).replace(/\s+/g, " ").slice(0, 90) : String(outcome.reason);
				failed.push(`${provider.engine.label}${reason && !/WEB_/i.test(reason) ? ` (${reason})` : ""}`);
			}
		});

		// Round-robin across engines so the top slice spans many engines, then
		// cross-engine dedupe (a later richer entry replaces a bare-URL twin).
		const merged = new Map(); // normalized url → source
		for (let rank = 0; byEngine.some((list) => rank < list.length); rank += 1) {
			for (const list of byEngine) {
				const source = list[rank];
				if (!source) continue;
				const key = cleanUrl(source.url);
				const existing = merged.get(key);
				if (!existing) merged.set(key, source);
				else if (!existing.snippet && source.snippet) merged.set(key, { ...existing, snippet: source.snippet });
			}
		}
		const all = [...merged.values()];
		const sources = all.slice(0, max);
		const domestic = okEngines.filter((e) => e.region === "domestic").length;
		const overseas = okEngines.filter((e) => e.region === "overseas").length;
		const total = providers.length;
		const notes = [];
		if (failed.length) notes.push(`已过滤 ${failed.length} 个异常引擎: ${failed.join("；")}`);
		if (empty.length) notes.push(`已过滤 ${empty.length} 个无结果引擎: ${empty.join("；")}`);
		const summary =
			sources.length > 0
				? `聚合自 ${total} 个引擎（国内 ${domestic}/${engCount("domestic", providers)} 个、海外 ${overseas}/${engCount("overseas", providers)} 个成功）。`
				: `聚合搜索未获得任何结果（${total} 个引擎全部异常或无结果）。`;
		const content = [summary, ...notes].join("\n");

		return { content, sources, truncated: all.length > max };
	}
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
