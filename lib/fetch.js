/**
 * Direct target-URL fetch provider (`phantom-http`) for the `web_fetch` tool.
 *
 * Implements the seam's `WebFetchProvider`: one GET with per-hop SSRF
 * protection and a bounded body. Non-2xx responses are results (the status
 * code is part of the fetched resource), only unsafe retrieval is an error.
 *
 * @module websearch-plugins/fetch
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { assertPublicHost, httpFetch, throwIfAborted } from "./net.js";

function concat(chunks) {
	if (chunks.length === 0) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0];
	let size = 0;
	for (const c of chunks) size += c.byteLength;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/** The target-URL fetch provider. */
export class PhantomHttpFetchProvider {
	id = "phantom-http";

	/** @param {() => object} resolve - config thunk ({userAgent, fetch:{timeoutMs,maxBytesHtml,maxBytesText,maxRedirects}}). */
	constructor(resolve) {
		this.resolve = resolve;
	}

	available() {
		return true;
	}

	async fetch(request, signal) {
		const config = this.resolve() ?? {};
		const fetchCfg = config.fetch ?? {};
		const timeoutMs = fetchCfg.timeoutMs ?? 15000;
		const maxBytesHtml = fetchCfg.maxBytesHtml ?? 1 << 20;
		const maxBytesText = fetchCfg.maxBytesText ?? 1 << 19;
		const maxRedirects = clampRedirects(fetchCfg.maxRedirects);

		let url;
		try {
			url = new URL(request.url);
		} catch (error) {
			throw new WebError(`invalid URL: ${request.url}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!/^https?:$/.test(url.protocol)) {
			throw new WebError(`unsupported protocol ${url.protocol} — only http/https`, "WEB_PROVIDER_ERROR");
		}

		let current = url;
		for (let hop = 0; hop <= maxRedirects; hop += 1) {
			await assertPublicHost(current.hostname);
			throwIfAborted(signal);

			const response = await httpFetch(current, {
				timeoutMs,
				signal,
				redirect: "manual",
				headers: { "user-agent": config.userAgent }
			});

			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				current = new URL(location, current);
				if (!/^https?:$/.test(current.protocol)) {
					throw new WebError(`redirect to unsupported protocol ${current.protocol}`, "WEB_PROVIDER_ERROR");
				}
				continue;
			}

			return await readSizedBody(response, { maxBytesHtml, maxBytesText, signal });
		}
		throw new WebError(`too many redirects fetching ${request.url}`, "WEB_PROVIDER_ERROR");
	}
}

function clampRedirects(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 5;
	return Math.min(10, Math.max(0, Math.trunc(n)));
}

async function readSizedBody(response, { maxBytesHtml, maxBytesText, signal }) {
	const contentType = response.headers.get("content-type") ?? "";
	const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
	const maxBytes = isHtml ? maxBytesHtml : maxBytesText;

	let received = 0;
	const chunks = [];
	let truncated = false;
	const reader = response.body?.getReader?.();
	if (reader) {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (received + value.byteLength > maxBytes) {
					chunks.push(value.subarray(0, maxBytes - received));
					received = maxBytes;
					truncated = true;
					break;
				}
				chunks.push(value);
				received += value.byteLength;
			}
		} catch (error) {
			if (signal?.aborted) throw new WebError("request aborted", "WEB_ABORTED", { cause: signal.reason });
			throw new WebError(`error reading body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		} finally {
			reader.releaseLock?.();
		}
	}

	const content = new TextDecoder().decode(concat(chunks));
	return {
		url: response.url || response.headers.get("location") || "",
		statusCode: response.status,
		body: { kind: isHtml ? "html" : "text", content },
		truncated
	};
}
