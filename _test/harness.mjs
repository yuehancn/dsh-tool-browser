// Shared minimal harness for the dsh-tool-browser tests.
//
// It rebuilds the plugin's `apply` against the REAL @deepseek-ai/dsh-tools, so
// schema normalization (`required` hoisting, `additionalProperties` on every
// nested object, type enforcement) is exercised for real rather than against a
// hand-written stub.
//
// `apply(ctx, config)` receives an already schema-resolved config, so this
// context runs the caller's options through the real `Config` first and fills
// every missing key with its default. Passing a partial object straight through
// would silently register zero tools.
//
// Two injectable seams matter here, and both live on one object the caller
// holds:
//   - `fetchImpl`        — the static path's HTTP call
//   - `playwrightLoader` — the dynamic import that resolves the optional browser
//   - `playwrightModule` — an already-resolved fake browser
// Because `apply` reads them off `ctx.transport` rather than building its own
// copy, a test can swap them and know the tools will see the same object.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

// The import lines are stripped and re-bound as `new Function` parameters, and
// the export statements are dropped because the builder below re-exports.
//
// The export regex must span lines: this plugin writes its internals as a
// multi-line `export { … };` block, and a single-line pattern would leave the
// bare `export` keyword behind — which `new Function` rejects outright.
const body = source
	.replace(/^import .*$/gm, "")
	.replace(/^export \{[\s\S]*?\};$/gm, "");

const INTERNALS = [
	"WAIT_STRATEGIES", "STRIP_TAGS", "CONTENT_HINTS", "CHROME_HINTS",
	"HEADING_PREFIX", "BLOCK_TAGS", "DEFAULT_NAV_TIMEOUT_MS",
	"collapseWhitespace", "decodeEntities", "nameScore", "stripChrome",
	"htmlToText", "htmlToMarkdown", "childElements", "scoreFragment",
	"pickContentRoot", "extractContent", "extractTitle", "extractDescription",
	"extractLinks", "resolveWait", "normalizeUrl", "clamp", "outputPath",
	"staticFetch", "loadPlaywright", "renderWithBrowser"
];

const build = new Function(
	"z", "defineTool", "readFile", "writeFile", "mkdir",
	"join", "resolve", "basename", "dirname", "extname",
	`${body}\nreturn { Config, apply, inject, name, ${INTERNALS.join(", ")} };`
);

/** The plugin's real exports plus its internals, for white-box assertions. */
export const plugin = build(
	z, defineTool, readFile, writeFile, mkdir,
	join, resolve, basename, dirname, extname
);

/**
 * Build a minimal cordis-like context that records registered tools and owns
 * the injectable seams.
 *
 * `apply` is *not* called automatically — tests call it explicitly, so a
 * registration toggle can be asserted before and after.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {{tools: object, config: object, transport: object, names: () => string[], get: (n: string) => any, has: (n: string) => boolean}} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		// `apply` is expected to reuse this object in place, so a test's later
		// assignment is visible to every closure the tools captured.
		transport: {},
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call and capture either its value or the thrown error, so tests
 * can assert on modelled failure paths without try/catch noise.
 *
 * @param {any} definition - a tool definition exposing `execute`.
 * @param {object} args - tool arguments.
 * @param {object} [options] - extra execute options (e.g. a fake signal).
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args, options = {}) {
	try {
		return { value: await definition.execute(args, { signal: options.signal }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

/**
 * Assert that the static fetch seam was actually reached.
 *
 * A fixture whose request log is still empty after a call means the plugin
 * went somewhere else — and "somewhere else" is the real network. Making that
 * a loud failure is cheaper than debugging a hung suite.
 *
 * @param {Array<object>} calls - the fake's request log.
 * @param {string} label - a description for the error message.
 */
export function assertNoNetwork(calls, label) {
	if (calls.length === 0) {
		throw new Error(`${label}: the fake transport was never called, so the suite reached the real network.`);
	}
}

/**
 * Build a fake `fetch` that answers with a fixed body and records every call.
 *
 * @param {object} [options] - the response to serve.
 * @param {string} [options.body] - the response body.
 * @param {number} [options.status] - the HTTP status.
 * @param {string} [options.url] - the final URL to report.
 * @param {string} [options.contentType] - the content type.
 * @returns {{fetchImpl: Function, calls: Array<object>}} the fake and its log.
 */
export function fakeFetch(options = {}) {
	const calls = [];
	const status = options.status ?? 200;
	const body = options.body ?? "<html><body><p>hello</p></body></html>";
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url, init });
		if (options.throwError !== undefined) throw options.throwError;
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? "OK" : "Error",
			url: options.url ?? url,
			headers: { get: (key) => (key.toLowerCase() === "content-type" ? (options.contentType ?? "text/html; charset=utf-8") : null) },
			text: async () => body
		};
	};
	return { fetchImpl, calls };
}

/**
 * Build a fake Playwright module good enough to drive `renderWithBrowser` and
 * `browser_screenshot` without a real browser.
 *
 * The fake models the parts the plugin actually calls: `chromium.launch()`,
 * `browser.newContext()`, `context.newPage()`, `page.goto()`,
 * `page.waitForSelector()`, `page.content()`, `page.title()`,
 * `page.screenshot()`, `page.url()`, and the two `close()` methods. Anything
 * else would be inventing surface the plugin does not use.
 *
 * @param {object} [options] - the page to serve.
 * @param {string} [options.html] - `page.content()`.
 * @param {string} [options.title] - `page.title()`.
 * @param {string} [options.finalUrl] - `page.url()`.
 * @param {number} [options.status] - the navigation response status.
 * @param {Buffer} [options.png] - what `screenshot()` resolves to.
 * @returns {{module: object, log: object}} the fake module and an observation log.
 */
export function fakePlaywright(options = {}) {
	const log = {
		launched: 0, closed: 0, contextsClosed: 0,
		navTimeouts: [], gotoOptions: [], waitForSelector: [], screenshotOptions: [],
		viewport: null, headless: null, userAgent: null
	};
	const html = options.html ?? "<html><head><title>Fake</title></head><body><article><p>Rendered body text here.</p></article></body></html>";
	const png = options.png ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	const module = {
		chromium: {
			async launch(launchOptions = {}) {
				log.launched += 1;
				log.headless = launchOptions.headless;
				return {
					async newContext(contextOptions = {}) {
						log.viewport = contextOptions.viewport ?? null;
						log.userAgent = contextOptions.userAgent ?? null;
						return {
							async newPage() {
								return {
									async goto(url, gotoOptions = {}) {
										log.gotoOptions.push({ url, ...gotoOptions });
										log.navTimeouts.push(gotoOptions.timeout);
										if (options.gotoError !== undefined) throw options.gotoError;
										return { status: () => options.status ?? 200 };
									},
									async waitForSelector(selector, waitOptions = {}) {
										log.waitForSelector.push({ selector, timeout: waitOptions.timeout });
										if (options.selectorError !== undefined) throw options.selectorError;
										return { selector };
									},
									async content() { return html; },
									async title() { return options.title ?? "Fake Page"; },
									url() { return options.finalUrl ?? "https://example.com/final"; },
									async screenshot(screenshotOptions = {}) {
										log.screenshotOptions.push(screenshotOptions);
										return png;
									}
								};
							},
							async close() { log.contextsClosed += 1; }
						};
					},
					async close() { log.closed += 1; }
				};
			}
		}
	};
	return { module, log };
}

/**
 * A document with a real article, a nav bar, a footer link farm and a comment
 * section — the shape that catches a naive extractor.
 */
export const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
	<title>Why Median Beats Mean</title>
	<meta name="description" content="A short argument about averages.">
</head>
<body>
	<nav class="main-nav"><a href="/">Home</a> <a href="/blog">Blog</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/pricing">Pricing</a> <a href="/docs">Docs</a> <a href="/login">Log in</a> <a href="/signup">Sign up</a></nav>
	<div class="wrapper">
		<article class="post-content">
			<h1>Why Median Beats Mean</h1>
			<p>The mean is easy to compute and easy to mislead with. One value far from the rest drags it away from anything a reader would recognise.</p>
			<p>The median does not move when a single point does. That is the entire argument, and it fits in <strong>one sentence</strong>.</p>
			<pre><code>median([1, 2, 3, 8, 40]) === 3</code></pre>
			<ul><li>Robust to outliers</li><li>Easy to explain</li></ul>
			<blockquote>Half the data is above, half below.</blockquote>
			<p>For a longer treatment, see <a href="/stats/robust">the robust statistics note</a>.</p>
		</article>
		<aside class="sidebar"><h3>Related</h3><p><a href="/a">A</a> <a href="/b">B</a> <a href="/c">C</a></p></aside>
	</div>
	<section class="comments"><h3>Comments</h3><p><a href="/u/1">alice</a> said: great post!</p></section>
	<footer class="site-footer"><a href="/privacy">Privacy</a> <a href="/terms">Terms</a> <a href="/sitemap">Sitemap</a></footer>
</body>
</html>`;

export default { plugin, Context, call, fakeFetch, fakePlaywright, assertNoNetwork, ARTICLE_HTML };