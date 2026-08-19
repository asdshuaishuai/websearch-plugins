/**
 * Search-engine registry for the aggregate websearch-plugins.
 *
 * The list is deliberately comprehensive — a universal adapter, NOT tuned to
 * this machine's egress. Every engine is included; those that are unreachable,
 * blocked, or JS-gated simply contribute nothing at the results layer (the
 * aggregate filters failures). Each parse is best-effort; when an engine's
 * specific selector finds nothing it falls back to a generic `<h3>` anchor
 * scan, and if that still finds nothing the engine contributes no results.
 *
 * @module websearch-plugins/engines
 */
import { cap, cleanUrl, collapse, decodeEntities, hostnameOf, stripTags } from "./net.js";

const NOISE_TITLE =
	/^(sign in|log in|login|sign up|privacy|terms?|cookie|cookies|about( us)?|help|contact( us)?|settings|home|next|previous|page \d+|results\d*|search results|already have an account)?$/iu;

const NOISE_URL =
	/(^|\/)(login|logout|signin|signup|register|account|privacy(\.php|\.html)?|terms?|cookie|cookies)(\?|$)|\.(?:ico|png|jpe?g|gif|svg|css|js)$/iu;

/** Bare-root pages of the search engines themselves — never a web result. */
const ENGINE_ROOT_HOSTS = new Set([
	"baidu.com", "www.baidu.com", "sogou.com", "www.sogou.com", "so.com", "www.so.com",
	"sm.cn", "www.sm.cn", "bing.com", "www.bing.com", "cn.bing.com", "google.com",
	"www.google.com", "duckduckgo.com", "html.duckduckgo.com", "brave.com",
	"search.brave.com", "mojeek.com", "www.mojeek.com", "lite.qwant.com", "qwant.com",
	"ecosia.org", "www.ecosia.org", "search.yahoo.com", "yahoo.com", "yandex.com",
	"startpage.com", "www.startpage.com", "searx.be"
]);

/** Filter + dedupe + noise-screen raw anchors into clean search sources. */
function toSources(raw, config) {
	const blocked = config?.blockedHosts ?? [];
	const seen = new Set();
	const out = [];
	for (const item of raw) {
		const url = cleanUrl(item.url);
		if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
		const host = hostnameOf(url);
		if (!host || blocked.includes(host)) continue;
		if (NOISE_URL.test(url)) continue;
		// A bare engine root (empty path, no query) is page chrome, not a result.
		if (ENGINE_ROOT_HOSTS.has(host)) {
			try {
				const u = new URL(url);
				if ((u.pathname === "/" || u.pathname === "") && u.search === "") continue;
			} catch {
				continue;
			}
		}
		const title = collapse(decodeEntities(stripTags(item.title ?? "")));
		if (title.length < 8 || NOISE_TITLE.test(title)) continue;
		seen.add(url);
		const source = { url, title: cap(title, 300) };
		const snippet = collapse(decodeEntities(stripTags(item.snippet ?? "")));
		if (snippet.length > 0) source.snippet = cap(snippet, 600);
		if (item.publishedAt) source.publishedAt = item.publishedAt;
		out.push(source);
	}
	return out;
}

/** Universal fallback: anchors living inside `<h3>` headings (result titles). */
function h3Anchors(html) {
	const out = [];
	const blockRe = /<h3[^>]*>((?:(?!<\/h3>)[\s\S])*?)<\/h3>/giu;
	for (const m of html.matchAll(blockRe)) {
		const a = /<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/iu.exec(m[1]);
		if (a) out.push({ url: a[2] ?? a[3], title: a[4] });
	}
	return out;
}

// ── per-engine parsers (each returns raw {url,title,snippet?}[]) ────────────

const parseBaidu = (html) =>
	[...html.matchAll(/<h3[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu)].map((m) => ({
		url: m[2] ?? m[3],
		title: m[4]
	}));

const parseSogou = (html) => h3Anchors(html);

const parseSo360 = (html) =>
	[...html.matchAll(/<li[^>]*class="[^"]*res-list[^"]*"[^>]*>[\s\S]*?<h3[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu)].map(
		(m) => ({ url: m[2] ?? m[3], title: m[4] })
	);

const parseSmcn = (html) => h3Anchors(html);

/** Bing `format=rss` XML → sources (shared by cn + international). */
function parseBingRss(xml) {
	const out = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/giu)) {
		const item = m[1];
		const title = extract(item, "<title>", "</title>");
		const link = extract(item, "<link>", "</link>").trim();
		const desc = extract(item, "<description>", "</description>");
		const pub = extract(item, "<pubDate>", "</pubDate>").trim();
		if (link) out.push({ url: link, title, snippet: desc, publishedAt: toIso(pub) });
	}
	return out;
}

function extract(text, open, close) {
	const a = text.indexOf(open);
	if (a < 0) return "";
	const b = text.indexOf(close, a + open.length);
	if (b < 0) return "";
	return text.slice(a + open.length, b);
}

function toIso(value) {
	if (!value) return undefined;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const parseBing = (html) => parseBingRss(html);

/** Google wraps results in `/url?q=` redirects; titles sit in `<h3>`. */
const parseGoogle = (html) => {
	const urls = [...html.matchAll(/href="\/url\?q=([^&"]+)(?:&amp;|[^"]*)"[^>]*>/giu)
		.map((m) => {
			let u;
			try {
				u = decodeURIComponent(m[1]);
			} catch {
				u = m[1];
			}
			return u;
		})];
	const titles = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/giu)].map((m) => stripToText(m[1]));
	return zipResults(urls, titles);
};

const parseDuckDuckGo = (html) => {
	const out = [];
	const re = /class="result__a"[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		let url = m[2] ?? m[3];
		if (url.startsWith("//")) url = `https:${url}`;
		const uddg = /uddg=([^&]+)/.exec(url);
		if (uddg) {
			try {
				url = decodeURIComponent(uddg[1]);
			} catch {
				/* keep wrapper */
			}
		}
		const start = m.index;
		const frag = html.slice(start, start + 4000);
		const s = /class="result__snippet"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url, title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseBrave = (html) => {
	const out = [];
	const re = /<a\b[^>]*\bclass="[^"]*snippet-title[^"]*"[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 5000);
		const s = /class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseMojeek = (html) => {
	const out = [];
	const re = /<h2[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 4000);
		const s = /class="s"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseQwant = (html) => {
	const out = [];
	const re = /class="[^"]*result__title[^"]*"[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 5000);
		const s = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseEcosia = (html) => {
	const out = [];
	const re = /<a\b[^>]*\bclass="[^"]*result[^"]*"[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 5000);
		const s = /class="[^"]*button-result[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag) || /<p[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseYahoo = (html) => {
	const out = [];
	const re = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 6000);
		const s = /class="[^"]*compText[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseYandex = (html) => {
	const out = [];
	const re = /<li[^>]*class="[^"]*serp-item[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const frag = html.slice(m.index, m.index + 6000);
		const s = /class="(?:TextContainer|OrganicTextContentSpan)[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url: m[2] ?? m[3], title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseStartpage = (html) => {
	const out = [];
	const re = /class="w-gl__result"[^>]*>[\s\S]*?<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/giu;
	for (const m of html.matchAll(re)) {
		const url = (m[2] ?? m[3]).replace(/[?&](?:q|query)=[^&]*/i, "");
		const frag = html.slice(m.index, m.index + 6000);
		const s = /class="[^"]*w-gl__description[^"]*"[^>]*>([\s\S]*?)</iu.exec(frag);
		out.push({ url, title: m[4], snippet: s?.[1] ?? "" });
	}
	return out;
};

const parseSearx = (html) => {
	const out = [];
	const re = /<article[^>]*class="result[^"]*"[^>]*>([\s\S]*?)<\/article>/giu;
	for (const m of html.matchAll(re)) {
		const a = /<h3>[\s\S]*?<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/iu.exec(m[1]);
		if (!a) continue;
		const c = /class="content"[^>]*>([\s\S]*?)<\/p>/iu.exec(m[1]) || /class="content"[^>]*>([\s\S]*?)</iu.exec(m[1]);
		out.push({ url: a[2] ?? a[3], title: a[4], snippet: c?.[1] ?? "" });
	}
	return out;
};

function stripToText(frag) {
	return frag.replace(/<[^>]+>/g, "").trim();
}

function zipResults(urls, titles) {
	const out = [];
	const n = Math.min(urls.length, titles.length);
	for (let i = 0; i < n; i++) {
		if (urls[i] && titles[i]) out.push({ url: urls[i], title: titles[i], snippet: "" });
	}
	return out;
}

// ── the registry ────────────────────────────────────────────────────────────

/** Engine definition: id / region / label / buildUrl / parse. */
function engine(id, region, label, buildUrl, parse) {
	const countMax = id === "bing" || id === "bingcn" ? 25 : id === "baidu" ? 20 : id === "google" ? 20 : 10;
	return { id, region, label, countMax, buildUrl, parse };
}

const enc = encodeURIComponent;

export const ENGINES = [
	// ── domestic (国内) ───────────────────────────────────────────────────────
	engine("baidu", "domestic", "Baidu 百度", (q, n) => `https://www.baidu.com/s?wd=${enc(q)}&rn=${n}`, parseBaidu),
	engine("sogou", "domestic", "Sogou 搜狗", (q) => `https://www.sogou.com/web?query=${enc(q)}`, parseSogou),
	engine("so360", "domestic", "360 Search", (q) => `https://www.so.com/s?q=${enc(q)}`, parseSo360),
	engine("smcn", "domestic", "Shenma 神马", (q) => `https://www.sm.cn/s?q=${enc(q)}`, parseSmcn),
	engine("bingcn", "domestic", "Bing China 必应中国", (q, n) => `https://cn.bing.com/search?q=${enc(q)}&format=rss&count=${n}&setlang=zh-CN&cc=cn`, parseBing),
	// ── overseas (海外) ───────────────────────────────────────────────────────
	engine("bing", "overseas", "Bing 国际", (q, n) => `https://www.bing.com/search?q=${enc(q)}&format=rss&count=${n}&setlang=en&cc=us`, parseBing),
	engine("google", "overseas", "Google", (q, n) => `https://www.google.com/search?q=${enc(q)}&num=${n}&hl=en`, parseGoogle),
	engine("duckduckgo", "overseas", "DuckDuckGo", (q) => `https://html.duckduckgo.com/html/?q=${enc(q)}`, parseDuckDuckGo),
	engine("brave", "overseas", "Brave Search", (q) => `https://search.brave.com/search?q=${enc(q)}&source=web`, parseBrave),
	engine("mojeek", "overseas", "Mojeek", (q) => `https://www.mojeek.com/search?q=${enc(q)}`, parseMojeek),
	engine("qwant", "overseas", "Qwant", (q) => `https://lite.qwant.com/?q=${enc(q)}`, parseQwant),
	engine("ecosia", "overseas", "Ecosia", (q) => `https://www.ecosia.org/search?q=${enc(q)}`, parseEcosia),
	engine("yahoo", "overseas", "Yahoo! Search", (q) => `https://search.yahoo.com/search?p=${enc(q)}`, parseYahoo),
	engine("yandex", "overseas", "Yandex", (q) => `https://yandex.com/search/?text=${enc(q)}`, parseYandex),
	engine("startpage", "overseas", "Startpage", (q) => `https://www.startpage.com/sp/search?query=${enc(q)}`, parseStartpage),
	engine("searx", "overseas", "SearXNG (searx.be)", (q) => `https://searx.be/search?q=${enc(q)}`, parseSearx)
];

export const ENGINE_BY_ID = new Map(ENGINES.map((e) => [e.id, e]));

/**
 * Run one engine's parser with the generic `<h3>` fallback and normalize the
 * output into seam-shaped sources (noise-screened, deduped, capped).
 */
export function normalizeEngine(engine, html, config) {
	let raw = [];
	try {
		raw = engine.parse(html) ?? [];
	} catch {
		raw = [];
	}
	if (raw.length === 0) raw = h3Anchors(html);
	return toSources(raw, config);
}
