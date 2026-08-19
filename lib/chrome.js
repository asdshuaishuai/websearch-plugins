/**
 * Headless-Chrome rendering backend — the PhantomJS-style "real headless
 * browser" half of websearch-plugins.
 *
 * Plain `fetch` can't execute JavaScript, so SERP endpoints that ship a JS
 * shell / anti-bot challenge (Shenma's `punish` redirect, Yandex's
 * "Are you not a robot?", …) return nothing scrapeable. This module drives a
 * real headless Chrome (`--headless=new --dump-dom`) to render the page and
 * hands the resulting DOM back to the normal parsers, so the site genuinely
 * sees a browser.
 *
 * @module websearch-plugins/chrome
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { WebError } from "@deepseek-ai/dsh-web";

const CANDIDATES = [
	"/opt/google/chrome/chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/snap/bin/chromium"
];

let cachedPath;

/** Resolve a usable Chrome/Chromium binary (configured path wins, then common paths). */
export function resolveChromePath(configured = "") {
	if (configured && existsSync(configured)) {
		cachedPath = configured;
		return configured;
	}
	if (cachedPath) return cachedPath;
	for (const candidate of CANDIDATES) {
		if (existsSync(candidate)) {
			cachedPath = candidate;
			return candidate;
		}
	}
	return undefined;
}

/** True when a headless-CHrome binary is available on this machine. */
export function isChromeAvailable(configured = "") {
	return Boolean(resolveChromePath(configured));
}

/**
 * Render `url` in a fresh headless Chrome and return the serialized DOM.
 * Honors an `AbortSignal` (caller cancellation → `WEB_ABORTED`) and a local
 * timeout (→ `WEB_PROVIDER_ERROR`).
 *
 * @param {string} url - the SERP URL to render.
 * @param {object} options - {path, timeoutMs, virtualTime, userAgent, signal}.
 * @returns {Promise<string>} the rendered HTML document.
 */
export function chromeDumpDom(url, { path, timeoutMs = 9000, virtualTime = 4000, userAgent, signal } = {}) {
	return new Promise((resolve, reject) => {
		const bin = resolveChromePath(path);
		if (!bin) reject(new WebError("headless Chrome is unavailable on this machine", "WEB_PROVIDER_ERROR"));
		const args = [
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-extensions",
			"--hide-scrollbars",
			"--run-all-compositor-stages-before-draw",
			"--dump-dom",
			`--virtual-time-budget=${Math.max(500, Math.trunc(virtualTime))}`
		];
		if (userAgent) args.push(`--user-agent=${userAgent}`);
		args.push(url);

		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			child.kill("SIGKILL");
			error ? reject(error) : resolve(stdout);
		};

		const timer = setTimeout(() => {
			finish(new WebError(`headless Chrome timed out after ${timeoutMs}ms`, "WEB_PROVIDER_ERROR"));
		}, timeoutMs);

		const onAbort = () => {
			finish(new WebError("search aborted", "WEB_ABORTED", { cause: signal?.reason }));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 3 * 1024 * 1024) finish(new WebError("headless Chrome output exceeded 3MB", "WEB_PROVIDER_ERROR"));
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(new WebError(`headless Chrome failed to start: ${error.message}`, "WEB_PROVIDER_ERROR")));
		child.on("close", (code) => {
			if (settled) return;
			if (stdout.length < 50) {
				finish(new WebError(`headless Chrome returned a near-empty page (exit ${code}): ${stderr.replace(/\s+/g, " ").slice(0, 120)}`, "WEB_PROVIDER_ERROR"));
				return;
			}
			finish();
		});
	});
}
