/**
 * Type declarations for `websearch-plugins`.
 * @module websearch-plugins
 */
import type { Context } from '@deepseek-ai/cordis';

export type EngineRegion = 'domestic' | 'overseas';

export interface EngineSpec {
	readonly id: string;
	readonly region: EngineRegion;
	readonly label: string;
	readonly countMax: number;
}

export interface EngineOverride {
	/** Results to request for this engine (1..countMax). */
	count?: number;
	/** Fetch timeout for this engine in milliseconds. */
	timeoutMs?: number;
	/** Override this engine's retrieval mode: 'http' | 'chrome' | 'auto'. */
	fetchMode?: 'http' | 'chrome' | 'auto';
}

export interface PhantomChromeConfig {
	/** Explicit Chrome/Chromium binary path; empty auto-detects (headless-shell preferred). */
	path?: string;
	/** Per-render timeout in milliseconds. */
	timeoutMs?: number;
	/** Render settle delay after load (ms) so client-side markup appears. */
	settleMs?: number;
	/** Virtual-time budget for the spawn-per-shot fallback renderer. */
	virtualTime?: number;
	/** Timeout for bringing up the persistent headless browser. */
	browserTimeoutMs?: number;
	/** UA override sent to the SERP while rendering. */
	userAgent?: string;
}

export interface PhantomFetchConfig {
	timeoutMs?: number;
	maxBytesHtml?: number;
	maxBytesText?: number;
	maxRedirects?: number;
}

export interface WebSearchPluginsConfig {
	/** Per-engine results to request when the aggregate fans out (default 5). */
	engineCount?: number;
	/** Total source cap when the caller omits maxResults (default 10). */
	aggregateMaxResults?: number;
	/** Default per-engine fetch timeout (default 7000). */
	engineTimeoutMs?: number;
	/** Engine ids to include in the aggregate; empty means all. */
	include?: string[];
	/** User-Agent sent to SERP endpoints (also reused by the fetch provider). */
	userAgent?: string;
	/** Hosts whose results are never surfaced. */
	blockedHosts?: string[];
	/** Per-engine overrides keyed by engine id. */
	engines?: Record<string, EngineOverride>;
	/** SERP retrieval mode: 'http' | 'chrome' | 'auto' (default 'auto'). */
	fetchMode?: 'http' | 'chrome' | 'auto';
	/** Headless-Chrome rendering options for the JS-shell fallback. */
	chrome?: PhantomChromeConfig;
	/** Direct-URL fetch provider options. */
	fetch?: PhantomFetchConfig;
}

export declare const name: string;
export declare const inject: readonly string[];
export declare const DEFAULT_CONFIG: Readonly<WebSearchPluginsConfig>;
export declare function apply(ctx: Context, config?: WebSearchPluginsConfig): () => void;
