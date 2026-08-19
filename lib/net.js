/**
 * Shared networking + text/URL helpers for the websearch-plugins providers.
 * Zero runtime dependencies: Node's global `fetch`, `node:net`, `node:dns`.
 *
 * @module websearch-plugins/net
 */
import net from "node:net";
import { lookup } from "node:dns/promises";
import { WebError } from "@deepseek-ai/dsh-web";

export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * A desktop-Chrome-fresh-tab header set, so SERP endpoints see a normal
 * browser rather than a bare library client. `accept-encoding` deliberately
 * omits `br` (undici transparently decompresses gzip/deflate only).
 */
export const BROWSER_HEADERS = {
	"user-agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"accept":
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
	"accept-encoding": "gzip, deflate",
	"cache-control": "max-age=0",
	"upgrade-insecure-requests": "1",
	"sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
	"sec-ch-ua-mobile": "?0",
	"sec-ch-ua-platform": '"Windows"',
	"sec-fetch-dest": "document",
	"sec-fetch-mode": "navigate",
	"sec-fetch-site": "none",
	"sec-fetch-user": "?1"
};

/** Hosts whose results are harness noise, dropped from every engine's output. */
export const DEFAULT_BLOCKED_HOSTS = [
	"www.bing.com",
	"cn.bing.com",
	"bing.com",
	"www.microsoft.com",
	"microsoft.com",
	"go.microsoft.com",
	"support.microsoft.com",
	"msn.com",
	"www.msn.com"
];

// ── text helpers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	yen: "¥",
	euro: "€",
	pound: "£",
	copy: "©",
	reg: "®",
	trade: "™"
};

/** Decode the HTML/XML character references found in `input` (numeric + named). */
export function decodeEntities(input) {
	if (!input) return "";
	return String(input).replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
		if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
		if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
		return NAMED_ENTITIES[body] ?? whole;
	});
}

/** Strip every tag and comment from a fragment, leaving visible text. */
export function stripTags(input) {
	return String(input).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "");
}

/** Collapse runs of whitespace and trim. */
export function collapse(input) {
	return String(input).replace(/\s+/g, " ").trim();
}

/** Cap `text` at `length` characters on a code-point boundary. */
export function cap(text, length) {
	if (text.length <= length) return text;
	const clipped = Array.from(text).slice(0, length).join("");
	const cut = clipped.lastIndexOf(" ");
	return cut > length * 0.7 ? clipped.slice(0, cut).trim() : clipped.trim();
}

/** Hostname of a URL, lowercased, without `www.` — or "" when unparseable. */
export function hostnameOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** Normalize a search-result URL: drop fragments and common tracking params. */
export function cleanUrl(url) {
	try {
		const u = new URL(url);
		u.hash = "";
		for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) u.searchParams.delete(key);
		return u.toString();
	} catch {
		return url;
	}
}

/** First XML/HTML element body for `tag` inside `fragment`, or "" when absent. */
export function extractElement(fragment, tag) {
	const match = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)</${tag}>`, "iu").exec(fragment);
	return match?.[1] ?? "";
}

/** Clamp `value` into `[min, max]`, coercing non-numbers to `fallback`. */
export function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** RFC-822 / ISO-ish date string → ISO-8601 string, or undefined when unparseable. */
export function toIsoDate(value) {
	if (!value) return undefined;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return undefined;
	return parsed.toISOString();
}

// ── network helpers ─────────────────────────────────────────────────────────

function isAbortError(error) {
	return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Throw the seam's stable cancellation error when the caller already aborted. */
export function throwIfAborted(signal) {
	if (signal?.aborted) throw new WebError("search aborted", "WEB_ABORTED", { cause: signal.reason });
}

// ── tiny in-memory cookie jar (browser-like session, per host) ──────────────

const cookieJar = new Map(); // hostname → Map(cookieName → value)

/** Cookie header for a URL based on the jar's current state. */
export function cookieHeaderFor(url) {
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return "";
	}
	const hostCookies = cookieJar.get(host);
	if (!hostCookies || hostCookies.size === 0) return "";
	return [...hostCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Absorb `Set-Cookie` headers from a response into the jar (value only). */
export function absorbSetCookie(response, url) {
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return;
	}
	const setters = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	for (const raw of setters) {
		const pair = String(raw).split(";")[0]?.trim();
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!name) continue;
		let entry = cookieJar.get(host);
		if (!entry) cookieJar.set(host, (entry = new Map()));
		entry.set(name, value);
	}
}

/** Drop one host's cookies (used after heavy anti-bot responses). */
export function clearCookies(host) {
	cookieJar.delete(host);
}

/**
 * Run one `fetch` honoring both the caller's signal and a local timeout. By
 * default it presents a fresh-Chrome-tab header set (`BROWSER_HEADERS`) so SERP
 * endpoints see a normal browser, attaches any jar'd cookies for the host, and
 * absorbs new ones. Caller-provided `headers` override these per-key.
 *
 * Failures are classified: caller cancellation → `WEB_ABORTED`; local timeout →
 * `WEB_PROVIDER_ERROR` (timeout); anything else network → provider error.
 */
export async function httpFetch(url, { method = "GET", headers = {}, timeoutMs = 15000, signal, redirect = "follow", cookie = true } = {}) {
	throwIfAborted(signal);
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const cookieHeader = cookie ? cookieHeaderFor(url) : "";
	const requestHeaders = {
		...BROWSER_HEADERS,
		...(cookieHeader ? { cookie: cookieHeader } : {}),
		...Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined))
	};
	try {
		const response = await fetch(url, {
			method,
			redirect,
			signal: combined,
			headers: requestHeaders
		});
		if (cookie && response.headers && typeof response.headers.getSetCookie === "function") absorbSetCookie(response, url);
		throwIfAborted(signal);
		return response;
	} catch (error) {
		if (signal?.aborted) throw new WebError("request aborted", "WEB_ABORTED", { cause: signal.reason });
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new WebError("request timed out", "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (isAbortError(error)) throw new WebError("request aborted", "WEB_ABORTED", { cause: signal?.reason });
		throw new WebError(`request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
	}
}

/** Assert a 2xx response, else raise a provider error carrying a short body excerpt. */
export async function requireOk(response, label) {
	if (response.ok) return response;
	const body = await response.text().catch(() => "");
	const detail = body.replace(/\s+/g, " ").trim().slice(0, 160);
	throw new WebError(
		`${label} returned HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
		"WEB_PROVIDER_ERROR"
	);
}

// ── SSRF guard for the fetch provider ───────────────────────────────────────

/** True when an IPv4/IPv6 literal or resolved address is not publicly routable. */
export function isPrivateAddress(address) {
	const family = net.isIP(address);
	if (family === 4) {
		const [a, b, c, d] = address.split(".").map(Number);
		if (a === 10) return true;
		if (a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
		if (a === 198 && (b === 18 || b === 51)) return true; // 198.18/15 + 198.51.100/24
		if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
		if (a === 255 || a === 224 || (a === 0 && b === 0 && c === 0 && d === 0)) return true;
		if (a >= 224) return true; // multicast + reserved
		return false;
	}
	if (family === 6) {
		const low = address.toLowerCase();
		const normalized = low.includes(":") && !low.includes("::") ? low : low;
		if (normalized === "::" || normalized === "::1") return true;
		if (normalized.startsWith("::ffff:")) return true;
		if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
		if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10 link-local
		if (normalized.startsWith("2001:db8")) return true;
		if (normalized.startsWith("ff")) return true; // multicast
		if (normalized.startsWith("2001:10") || normalized.startsWith("2002:") || normalized.startsWith("3fff:")) return true;
		return false;
	}
	// Not an IP literal: caller is expected to resolve first.
	return true;
}

/**
 * Resolve `hostname` (or inspect the literal) and reject loopback / private /
 * link-local / reserved / CGNAT addresses. Throws `WebError` when blocked.
 */
export async function assertPublicHost(hostname) {
	const trimmed = String(hostname).replace(/\.$/, "").toLowerCase();
	if (net.isIP(trimmed)) {
		if (isPrivateAddress(trimmed)) throw new WebError(`blocked non-public address ${hostname}`, "WEB_PROVIDER_ERROR");
		return;
	}
	let address;
	try {
		({ address } = await lookup(trimmed));
	} catch {
		throw new WebError(`failed to resolve ${hostname}`, "WEB_PROVIDER_ERROR");
	}
	if (isPrivateAddress(address)) throw new WebError(`blocked non-public address ${hostname} (${address})`, "WEB_PROVIDER_ERROR");
}
