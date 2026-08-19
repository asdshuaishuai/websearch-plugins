/**
 * A dedicated, always-on, ultra-light headless browser for websearch-plugins.
 *
 * Instead of spawning a whole browser for every fallback render (heavy), this
 * module owns ONE persistent Blink (Chromium) headless process and serves every
 * render through it over the Chrome DevTools Protocol using Node's built-in
 * global `WebSocket` — zero new dependencies. The render path is the thinnest
 * thing that satisfies "the site sees a real browser": open a tab → navigate →
 * wait for load → snapshot `document.documentElement.outerHTML` → close tab.
 *
 * Binary selection prefers a bare headless-only Blink build
 * (`chrome-headless-shell`, ~1/3 the size of full Chrome), then falls back to a
 * full Chrome/Chromium, then to the spawn-per-shot path (`chromeDumpDom`) if the
 * persistent process cannot be brought up.
 *
 * @module websearch-plugins/headless
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebError } from "@deepseek-ai/dsh-web";
import { chromeDumpDom, resolveChromePath } from "./chrome.js";

// ── binaries to try, lightest first ─────────────────────────────────────────

const HEADLESS_SHELL_CANDIDATES = [
	"~/.cache/puppeteer/chrome/headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
	"~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell",
	"/opt/chrome-headless-shell/chrome-headless-shell",
	"/usr/local/bin/chrome-headless-shell",
	"/usr/bin/chrome-headless-shell"
];

function expandHome(path) {
	return path.replace(/^~(?=$|\/)/, process.env.HOME ?? "");
}

/** Find a bare headless-shell binary (glob-expand the `~/.cache/puppeteer` form). */
function findHeadlessShell() {
	for (const candidate of HEADLESS_SHELL_CANDIDATES) {
		const expanded = expandHome(candidate);
		if (expanded.includes("*")) {
			const i = expanded.indexOf("*");
			const slash = expanded.lastIndexOf("/", i);
			const base = expanded.slice(0, slash);
			const file = expanded.slice(slash + 1);
			let entries = [];
			try {
				entries = readdirSync(base);
			} catch {
				continue;
			}
			const match = entries.map((name) => join(base, name, file)).find((p) => existsSync(p));
			if (match) return match;
			continue;
		}
		if (existsSync(expanded)) return expanded;
	}
	return undefined;
}

// ── persistent browser singleton ────────────────────────────────────────────

let browser;
let launching;

/** The Blink binary the persistent renderer will use (headless-shell → full Chrome). */
export function browserBinary(configPath = "") {
	return findHeadlessShell() ?? resolveChromePath(configPath);
}

async function launch(config) {
	return new Promise((resolve, reject) => {
		const bin = browserBinary(config?.path);
		if (!bin) {
			reject(new WebError("no Blink headless binary found for the persistent renderer", "WEB_PROVIDER_ERROR"));
			return;
		}
		const profile = mkdtempSync(join(tmpdir(), "phantom-headless-"));
		const args = [
			"--headless=new",
			"--remote-debugging-port=0",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-extensions",
			`--user-data-dir=${profile}`,
			"about:blank"
		];
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new WebError("failed to bring up the headless browser in time", "WEB_PROVIDER_ERROR"));
		}, config?.browserTimeoutMs ?? 15000);

		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (m) {
				clearTimeout(timer);
				child.stdin?.end?.();
				resolve({ child, ws: m[1], profile });
			}
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new WebError(`headless browser failed to start: ${err.message}`, "WEB_PROVIDER_ERROR"));
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (browser?.child === child) browser = undefined;
			if (code !== 0 && !stderr.includes("DevTools listening")) {
				reject(new WebError(`headless browser exited (${code}): ${stderr.slice(0, 120)}`, "WEB_PROVIDER_ERROR"));
			}
		});
	});
}

/** Get (or lazily start) the persistent browser. Never rejects — falls back later. Concurrent calls share one launch. */
async function getBrowser(config) {
	try {
		if (browser && browser.child.exitCode === null) return browser;
		if (launching) return launching;
		launching = launch(config).then(
			(b) => {
				launching = undefined;
				browser = b;
				return b;
			},
			() => {
				launching = undefined;
				return undefined;
			}
		);
		return await launching;
	} catch {
		return undefined;
	}
}

// ── minimal CDP client over the global WebSocket ────────────────────────────

function openCdpSocket(wsUrl, timeoutMs) {
	return new Promise((resolve, reject) => {
		let ws;
		try {
			ws = new WebSocket(wsUrl);
		} catch (err) {
			reject(err);
			return;
		}
		const timer = setTimeout(() => reject(new WebError("CDP websocket timed out opening", "WEB_PROVIDER_ERROR")), timeoutMs);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(ws);
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			reject(new WebError(`CDP websocket error: ${event?.message ?? "unknown"}`, "WEB_PROVIDER_ERROR"));
		});
	});
}

/** Drive one page render: navigate, wait for load + settle, snapshot DOM. */
async function renderInBrowser(browser, url, { timeoutMs = 12000, settleMs = 600, userAgent, signal, config } = {}) {
	const http = `http://${new URL(browser.ws).host}/json`;
	const targetRes = await fetchDefault(http, "PUT", `/new?${encodeURIComponent(url)}`, config);
	const target = await parseJson(targetRes);
	const wsUrl = target?.webSocketDebuggerUrl;
	const targetId = target?.id;
	if (!wsUrl || !targetId) throw new WebError("headless browser: no page target created", "WEB_PROVIDER_ERROR");

	const ws = await openCdpSocket(wsUrl, timeoutMs);
	try {
		const pending = new Map();
		let nextId = 0;
		ws.addEventListener("message", (event) => {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (msg.id !== undefined) {
				const waiter = pending.get(msg.id);
				if (waiter) {
					pending.delete(msg.id);
					waiter.resolve(msg);
				}
			}
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = ++nextId;
				pending.set(id, { resolve, reject });
				ws.send(JSON.stringify({ id, method, params }));
				setTimeout(() => {
					if (pending.delete(id)) reject(new WebError(`CDP ${method} timed out`, "WEB_PROVIDER_ERROR"));
				}, timeoutMs);
			});

		await send("Page.enable");
		if (userAgent) await send("Emulation.setUserAgentOverride", { userAgent });
		await send("Page.navigate", { url });
		// Deterministic wait: poll `document.readyState` to 'complete' (bounded),
		// so the client-side scripts have run before we snapshot the DOM.
		const started = Date.now();
		for (;;) {
			if (signal?.aborted) throw new WebError("search aborted", "WEB_ABORTED", { cause: signal.reason });
			const probe = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => ({ result: { result: { value: "" } } }));
			const ready = probe?.result?.result?.value;
			if (ready === "complete") break;
			if (Date.now() - started > timeoutMs) break;
			await new Promise((r) => setTimeout(r, 120));
		}

		// small settle for client-side rendered markup
		await new Promise((r) => setTimeout(r, settleMs));

		const { result } = await send("Runtime.evaluate", {
			expression: "document.documentElement.outerHTML",
			returnByValue: true
		});
		const html = String(result?.result?.value ?? "");
		return html;
	} finally {
		ws.close();
	}
}

// ── HTTP mini-helpers (no deps) ─────────────────────────────────────────────

function fetchDefault(http, method, path, config) {
	return fetch(`${http}${path}`, { method, signal: AbortSignal.timeout(config?.httpTimeoutMs ?? 15000) });
}

async function parseJson(res) {
	if (!res.ok) throw new WebError(`headless browser http API ${res.status}`, "WEB_PROVIDER_ERROR");
	return res.json().catch(() => ({}));
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Render `url` through the persistent headless browser and return the DOM.
 * Falls back to the spawn-per-shot renderer when no persistent browser can be
 * brought up, and to the original HTTP page when neither exists.
 *
 * @param {string} url - the SERP URL to render.
 * @param {object} options - {path/timeoutMs/settleMs/virtualTime/userAgent/signal} (merged from plugin config).
 */
export async function renderPage(url, options = {}) {
	const chromeCfg = options.chrome ?? {};
	const persistent = await getBrowser({ path: chromeCfg.path, browserTimeoutMs: chromeCfg.browserTimeoutMs });
	if (persistent) {
		try {
			const html = await renderInBrowser(persistent, url, {
				timeoutMs: chromeCfg.timeoutMs ?? options.timeoutMs ?? 12000,
				settleMs: chromeCfg.settleMs ?? 500,
				userAgent: chromeCfg.userAgent ?? options.userAgent,
				signal: options.signal,
				config: { httpTimeoutMs: chromeCfg.timeoutMs ?? 12000 }
			});
			if (html.length > 0) return html;
		} catch {
			/* fall through to spawn-per-shot */
		}
	}
	return chromeDumpDom(url, {
		path: chromeCfg.path,
		timeoutMs: chromeCfg.timeoutMs ?? options.timeoutMs ?? 9000,
		virtualTime: chromeCfg.virtualTime ?? 1500,
		userAgent: chromeCfg.userAgent ?? options.userAgent,
		signal: options.signal
	});
}

/** Tear down the persistent browser (used by tests / shutdown). */
export async function disposeHeadless() {
	if (browser) {
		try {
			browser.child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		browser = undefined;
	}
}
