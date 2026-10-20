// Integration tests: the plugin loaded through the real `defineTool`, with
// every tool driven through its registered definition.
//
// The point of this suite is everything that only exists once `defineTool` has
// normalised the schema: where `required` ends up, whether a nested object
// declares `additionalProperties`, whether the registration toggles work, and
// whether the injectable seams on the transport object are the ones the tools
// actually read.
import { Context, call, fakeFetch, fakePlaywright, assertNoNetwork, ARTICLE_HTML, plugin } from "./harness.mjs";

let passed = 0;
let failed = 0;

/**
 * Assert equality, recording the outcome.
 *
 * @param {string} label - what is being asserted.
 * @param {any} actual - the observed value.
 * @param {any} expected - the expected value.
 */
function equal(label, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) passed += 1;
	else {
		failed += 1;
		console.log(`  FAIL ${label}\n       actual:   ${a}\n       expected: ${b}`);
	}
}

/**
 * Assert a truthy condition.
 *
 * @param {string} label - what is being asserted.
 * @param {any} value - the value that should be truthy.
 */
function ok(label, value) {
	if (value) passed += 1;
	else {
		failed += 1;
		console.log(`  FAIL ${label}\n       expected truthy, got ${JSON.stringify(value)}`);
	}
}

console.log("browser: integration");

/* --------------------------------------------------- registration & shape */

{
	const ctx = Context();
	equal("nothing is registered before apply", ctx.names().length, 0);
	plugin.apply(ctx, ctx.config);
	equal("four tools are registered by default", ctx.names().length, 4);
	ok("browser_status is registered", ctx.has("browser_status"));
	ok("browser_fetch is registered", ctx.has("browser_fetch"));
	ok("browser_extract is registered", ctx.has("browser_extract"));
	ok("browser_screenshot is registered", ctx.has("browser_screenshot"));
}
{
	const ctx = Context({ status: false, fetchPage: false, extract: true, screenshot: false });
	plugin.apply(ctx, ctx.config);
	equal("a disabled tool is not registered", ctx.names().length, 1);
	ok("the one left enabled is still there", ctx.has("browser_extract"));
}
{
	const ctx = Context({ status: false, fetchPage: false, extract: false, screenshot: false });
	plugin.apply(ctx, ctx.config);
	equal("disabling everything registers nothing", ctx.names().length, 0);
}
equal("the plugin name is the diagnostic label", plugin.name, "dsh-tool-browser");
equal("the plugin injects the tools service", JSON.stringify(plugin.inject), JSON.stringify(["tools"]));
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const status = ctx.get("browser_status");
	equal("a timeout budget is attached", typeof status.timeoutMs, "number");
	ok("the budget is positive", status.timeoutMs > 0);
	equal("isConcurrencySafe is a function", typeof status.isConcurrencySafe, "function");
	ok("the status tool is concurrency safe", status.isConcurrencySafe({}) === true);
}

/* ------------------------------------------------------------ schema shape */

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);

	const status = ctx.get("browser_status");
	// `required` is hoisted to the top level by defineTool; the parameters
	// themselves stay under `properties`. Reading `parameters.url` finds
	// nothing, which is the mistake this assertion exists to catch.
	ok("the status tool declares an output schema", status.output?.schema !== undefined);
	equal("the status schema forbids extra keys", status.output.schema.additionalProperties, false);
	ok("the status schema lists its required keys", Array.isArray(status.output.schema.required));

	const fetchTool = ctx.get("browser_fetch");
	ok("url lives under properties, not on parameters", fetchTool.parameters.properties?.url !== undefined);
	equal("url is typed as a string", fetchTool.parameters.properties.url.type, "string");
	ok("mode is optional", !fetchTool.parameters.required.includes("mode"));
	ok("waitStrategy is declared", fetchTool.parameters.properties?.waitStrategy !== undefined);
	ok("waitForSelector is declared", fetchTool.parameters.properties?.waitForSelector !== undefined);
	ok("saveAs is declared", fetchTool.parameters.properties?.saveAs !== undefined);

	const extract = ctx.get("browser_extract");
	ok("extract requires url", extract.parameters.required.includes("url"));
	ok("extract leaves format optional", !extract.parameters.required.includes("format"));
	ok("extract declares format", extract.parameters.properties?.format !== undefined);

	const shot = ctx.get("browser_screenshot");
	ok("screenshot requires url", shot.parameters.required.includes("url"));
	ok("screenshot declares fullPage", shot.parameters.properties?.fullPage !== undefined);
	ok("screenshot declares width and height", shot.parameters.properties?.width !== undefined && shot.parameters.properties?.height !== undefined);
}
{
	// Every nested object must declare `additionalProperties` explicitly, or
	// defineTool throws a JsonSchemaError while the plugin loads. The tools
	// above registered, so this is really a guard against a future edit that
	// adds a nested object without one.
	const ctx = Context();
	let threw = null;
	try {
		plugin.apply(ctx, ctx.config);
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	equal("no schema error was thrown while registering", threw, null);

	const status = ctx.get("browser_status");
	const dirs = status.output.schema.properties.directories;
	equal("the nested directories object declares additionalProperties", dirs.additionalProperties, false);
	const defaults = status.output.schema.properties.defaults;
	equal("the nested defaults object declares additionalProperties", defaults.additionalProperties, false);
	const links = ctx.get("browser_extract").output.schema.properties.links;
	equal("the links array declares its item shape", links.items.additionalProperties, false);

	// The authoring idiom is a boolean `required: true` on each property, and
	// the framework hoists those flags into a `required: [...]` array at every
	// object level of the *emitted* schema — root, parameters, and nested object
	// alike — while dropping the per-property flag. What is forbidden is
	// authoring that array yourself: `defineTool` rejects it at load time with
	// "schema.required is not supported by the value schema DSL". So the emitted
	// shape below is correct and is exactly what this suite is pinning.
	equal("the emitted parameters hoist the flags", JSON.stringify(ctx.get("browser_fetch").parameters.required), JSON.stringify(["url"]));
	equal("the emitted output root hoists the flags", JSON.stringify(status.output.schema.required), JSON.stringify(["browser", "engine", "note", "waitStrategies", "operations", "directories", "defaults"]));
	equal("a nested object hoists its flags too", JSON.stringify(dirs.required), JSON.stringify(["workDir", "outputDir"]));
	equal("the per-property flag is consumed by the hoist", dirs.properties.workDir.required, undefined);
	ok("the nested defaults object hoists its flags", Array.isArray(defaults.required) && defaults.required.includes("waitStrategy"));
	equal("array items carry no required array", links.items.required, undefined);
}

/* ----------------------------------------------------------- bad arguments */

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fetchTool = ctx.get("browser_fetch");

	const missing = await call(fetchTool, {});
	ok("a missing url is rejected", typeof missing.error === "string");
	ok("the rejection names the url", missing.error.includes("url"));

	const relative = await call(fetchTool, { url: "/just/a/path" });
	ok("a relative url is rejected", typeof relative.error === "string");
	ok("the rejection advises an absolute url", relative.error.includes("absolute"));

	const badScheme = await call(fetchTool, { url: "file:///c:/x" });
	ok("a file url is rejected", typeof badScheme.error === "string");
	ok("the rejection names the accepted schemes", badScheme.error.includes("http"));

	const badStrategy = await call(fetchTool, { url: "https://e.test/x", waitStrategy: "nonsense" });
	ok("a bad wait strategy is rejected", typeof badStrategy.error === "string");
	ok("the rejection lists the valid strategies", badStrategy.error.includes("networkidle"));
}
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	fetchTool: {
		const fetchTool = ctx.get("browser_fetch");
		const badMode = await call(fetchTool, { url: "https://e.test/x", mode: "telepathy" });
		ok("a bad mode is rejected", typeof badMode.error === "string");
		ok("the rejection lists the valid modes", badMode.error.includes("auto") && badMode.error.includes("static"));
	}
}
{
	// The framework enforces the declared types before `execute` ever runs, so
	// a wrong-typed argument never reaches the plugin's own validation. This
	// asserts the framework is doing that, because the plugin relies on it.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fetchTool = ctx.get("browser_fetch");
	const numeric = await call(fetchTool, { url: 12345 });
	ok("a non-string url is rejected by the framework", typeof numeric.error === "string");
}

/* -------------------------------------------------- the static fetch path */

{
	// `mode: "static"` must be reachable without Playwright, and it must go
	// through the injected fetch. If the plugin built its own transport the
	// fake would never be called and this suite would hit the real network.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML, url: "https://e.test/redirected" });
	ctx.transport.fetchImpl = fake.fetchImpl;

	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/start", mode: "static" });
	assertNoNetwork(fake.calls, "browser_fetch static");
	ok("the fetch succeeded", result.value !== undefined);
	equal("the engine is reported as static", result.value.engine, "static");
	equal("the final url is reported", result.value.finalUrl, "https://e.test/redirected");
	equal("the status is reported", result.value.status, 200);
	equal("the title is read", result.value.title, "Why Median Beats Mean");
	ok("the html is returned", result.value.html.includes("post-title") || result.value.html.includes("post-content"));
	ok("the byte count is measured", result.value.bytes > 0);
	equal("nothing was truncated", result.value.truncated, false);
	equal("exactly one request was made", fake.calls.length, 1);
}
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: "<p>" + "x".repeat(5000) + "</p>" });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/big", mode: "static", maxChars: 100 });
	equal("maxChars truncates the html", result.value.html.length, 100);
	equal("the truncation is reported", result.value.truncated, true);
	ok("the byte count still reflects the whole body", result.value.bytes > 5000);
}
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: "<html></html>", status: 404 });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/missing", mode: "static" });
	ok("a 404 is surfaced as an error", typeof result.error === "string");
	ok("the error names the status", result.error.includes("404"));
}
{
	// `saveAs` writes the *full* html even when the returned copy was
	// truncated, so an agent that saves a page gets the whole page.
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const body = "<html><body><p>" + "y".repeat(3000) + "</p></body></html>";
	const fake = fakeFetch({ body });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/save", mode: "static", saveAs: "page.html", maxChars: 50 });
	ok("a save path is reported", typeof result.value.savedTo === "string");
	ok("the returned html was truncated", result.value.truncated === true);
	ok("the saved path is under the output directory", result.value.savedTo.includes("browser-output"));
	const { readFile } = await import("node:fs/promises");
	const onDisk = await readFile(result.value.savedTo, "utf8");
	equal("the file on disk holds the full body", onDisk.length, body.length);
}
{
	// The save path must not be steerable with an absolute name or a traversal.
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: "<html></html>" });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/x", mode: "static", saveAs: "../../../evil.html" });
	ok("the write succeeded", typeof result.value?.savedTo === "string");
	ok("the traversal was flattened", result.value.savedTo.includes("browser-output"));
	ok("the filename was kept", result.value.savedTo.endsWith("evil.html"));
	ok("nothing was written outside the output directory", !result.value.savedTo.includes("WorkBuddy\\2026-10-02-10-43-11\\evil.html"));
}

/* --------------------------------------------------- the fallback path */

{
	// With no Playwright, `auto` must fall back to static — and say so, because
	// "the JavaScript never ran" changes what the extracted text means.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	ctx.transport.playwrightLoader = async () => { throw new Error("Cannot find module 'playwright'"); };

	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/x", mode: "auto" });
	assertNoNetwork(fake.calls, "browser_fetch fallback");
	equal("the fallback is static", result.value.engine, "static");
	ok("the fallback explains itself", result.value.engineNote.includes("Playwright is not installed"));
	ok("the note warns that JavaScript did not run", result.value.engineNote.includes("JavaScript"));
}
{
	// `mode: "browser"` is a promise, not a preference: if a real browser was
	// asked for and there is none, falling back silently would be a lie about
	// what the page looked like.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	ctx.transport.playwrightLoader = async () => { throw new Error("nope"); };
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/x", mode: "browser" });
	ok("requiring a browser without one is an error", typeof result.error === "string");
	ok("the error explains how to install it", result.error.includes("playwright install"));
	equal("the fake fetch was never called", fake.calls.length, 0);
}
{
	// `requireBrowser` makes the fallback unavailable even in `auto` mode.
	const ctx = Context({ requireBrowser: true });
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	ctx.transport.playwrightLoader = async () => { throw new Error("nope"); };
	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/x" });
	ok("requireBrowser blocks the fallback", typeof result.error === "string");
	ok("the error names the requirement", result.error.includes("requires a real browser"));
}
{
	// A browser that launches and then fails must fall back too, and the note
	// must say *why* — a timeout and a missing module are different problems.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const { module: pw } = fakePlaywright({ gotoError: new Error("net::ERR_TIMED_OUT") });
	ctx.transport.playwrightModule = pw;

	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/x", mode: "auto" });
	equal("a browser failure falls back to static", result.value.engine, "static");
	ok("the note carries the browser's own error", result.value.engineNote.includes("ERR_TIMED_OUT"));
	assertNoNetwork(fake.calls, "browser_fetch after browser failure");
}

/* ---------------------------------------------------- the rendered path */

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const { module: pw, log } = fakePlaywright({
		html: "<html><body><article><p>" + "Rendered prose sentence, with punctuation. ".repeat(12) + "</p></article></body></html>",
		title: "Rendered",
		finalUrl: "https://e.test/final"
	});
	ctx.transport.playwrightModule = pw;

	const result = await call(ctx.get("browser_fetch"), { url: "https://e.test/start", mode: "browser", waitStrategy: "networkidle" });
	equal("the engine is reported as browser", result.value.engine, "browser");
	ok("the note names the wait", result.value.engineNote.includes("networkidle"));
	equal("the browser was launched", log.launched, 1);
	equal("the browser was closed", log.closed, 1);
	equal("the final url came from the page", result.value.finalUrl, "https://e.test/final");
	equal("the title came from the page", result.value.title, "Rendered");
	equal("the wait strategy reached goto", log.gotoOptions[0].waitUntil, "networkidle");
	ok("the wait duration was measured", result.value.waitedMs >= 0);
}
{
	// A selector wait is the one case where `goto` must NOT use the requested
	// strategy: waiting for network idle when you are waiting for one element
	// can hang on a page with a polling request.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const { module: pw, log } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_fetch"), {
		url: "https://e.test/app", mode: "browser", waitForSelector: "#app"
	});
	equal("the selector overrode the strategy", log.gotoOptions[0].waitUntil, "domcontentloaded");
	equal("the selector was awaited", log.waitForSelector[0].selector, "#app");
	ok("the note names the selector", result.value.engineNote.includes("#app"));
}
{
	// The nav timeout is a config value and must reach Playwright.
	const ctx = Context({ navTimeoutMs: 4321 });
	plugin.apply(ctx, ctx.config);
	const { module: pw, log } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	await call(ctx.get("browser_fetch"), { url: "https://e.test/x", mode: "browser" });
	equal("the configured nav timeout reached goto", log.navTimeouts[0], 4321);
}

/* ------------------------------------------------------- browser_extract */

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_extract"), { url: "https://e.test/post", mode: "static" });
	assertNoNetwork(fake.calls, "browser_extract");
	ok("the title is returned", result.value.title === "Why Median Beats Mean");
	ok("the description is returned", result.value.description === "A short argument about averages.");
	equal("nothing was truncated", result.value.truncated, false);
	ok("the content is populated", result.value.content.length > 0);
	equal("the content length is reported", result.value.contentChars, result.value.content.length);
	equal("no links are returned unless asked", result.value.links, undefined);
}
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_extract"), { url: "https://e.test/post", mode: "static", format: "markdown", includeLinks: true });
	ok("the markdown keeps the heading", result.value.content.includes("# Why Median Beats Mean"));
	equal("the format is echoed", result.value.format, "markdown");
	ok("the links were included", Array.isArray(result.value.links));
	ok("a link was resolved to an absolute url", result.value.links.some((l) => l.url.startsWith("https://e.test/")));
}
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: ARTICLE_HTML });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const result = await call(ctx.get("browser_extract"), { url: "https://e.test/post", mode: "static", maxChars: 40 });
	equal("maxChars truncates the content", result.value.content.length, 40);
	equal("the truncation is reported", result.value.truncated, true);
}
{
	// The extractor must pick the same subtree whether the html came from a
	// browser or a static fetch. Two engines that disagree about what "the
	// article" is would make the tool's output depend on the install, which is
	// the worst kind of non-determinism.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const { module: pw } = fakePlaywright({ html: ARTICLE_HTML });
	ctx.transport.playwrightModule = pw;
	const viaBrowser = await call(ctx.get("browser_extract"), { url: "https://e.test/post", mode: "browser", format: "markdown" });

	const ctx2 = Context();
	plugin.apply(ctx2, ctx2.config);
	ctx2.transport.fetchImpl = fakeFetch({ body: ARTICLE_HTML }).fetchImpl;
	const viaStatic = await call(ctx2.get("browser_extract"), { url: "https://e.test/post", mode: "static", format: "markdown" });

	equal("both engines chose the same subtree", viaBrowser.value.selector, viaStatic.value.selector);
	equal("both engines produced the same content", viaBrowser.value.content, viaStatic.value.content);
}

/* ---------------------------------------------------- browser_screenshot */

{
	// There is no static fallback for a screenshot: a picture of a document
	// nobody rendered is a picture of an empty page, and returning one would be
	// worse than failing.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	ctx.transport.playwrightLoader = async () => { throw new Error("nope"); };
	const result = await call(ctx.get("browser_screenshot"), { url: "https://e.test/x" });
	ok("a screenshot without a browser is an error", typeof result.error === "string");
	ok("the error says there is no fallback", result.error.includes("no static fallback"));
}
{
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const { module: pw, log } = fakePlaywright({ png: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) });
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_screenshot"), { url: "https://e.test/x", filename: "home.png" });
	equal("the engine is the browser", result.value.engine, "browser");
	ok("a file path is returned", result.value.file.endsWith("home.png"));
	ok("the file is under the output directory", result.value.file.includes("browser-output"));
	equal("the byte count is the png size", result.value.bytes, 8);
	equal("fullPage defaults to false", result.value.fullPage, false);
	ok("the viewport is reported", typeof result.value.viewport === "string");
	equal("a single screenshot was taken", log.screenshotOptions.length, 1);
	equal("the screenshot was a png", log.screenshotOptions[0].type, "png");
	equal("fullPage reached the screenshot call", log.screenshotOptions[0].fullPage, false);
	const { readFile } = await import("node:fs/promises");
	const onDisk = await readFile(result.value.file);
	equal("the png is on disk with the right size", onDisk.length, 8);
}
{
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const { module: pw, log } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_screenshot"), { url: "https://e.test/x", fullPage: true, width: 640, height: 480 });
	equal("fullPage reached the screenshot call", log.screenshotOptions[0].fullPage, true);
	equal("the viewport width came from the argument", log.viewport.width, 640);
	equal("the viewport height came from the argument", log.viewport.height, 480);
	equal("the reported viewport matches", result.value.viewport, "640x480");
	ok("a default filename was generated", /shot-\d{4}-\d{2}-\d{2}T/u.test(result.value.file));
}
{
	// A screenshot with no extension gets one, so the file is openable.
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const { module: pw } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_screenshot"), { url: "https://e.test/x", filename: "noext" });
	ok("a missing extension is added", result.value.file.endsWith("noext.png"));
}
{
	// A screenshot must not be able to write outside the output directory.
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	const { module: pw } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_screenshot"), { url: "https://e.test/x", filename: "C:/Windows/system32/evil.png" });
	ok("an absolute filename was flattened", result.value.file.includes("browser-output"));
	ok("it did not land in system32", !result.value.file.includes("system32"));
	ok("the file name was kept", result.value.file.endsWith("evil.png"));
}

/* ------------------------------------------------------- browser_status */

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	ctx.transport.playwrightLoader = async () => { throw new Error("nope"); };
	const result = await call(ctx.get("browser_status"), {});
	equal("the browser is reported as unavailable", result.value.browser, false);
	equal("the default engine is static", result.value.engine, "static");
	ok("the note explains the situation", result.value.note.includes("not installed"));
	ok("the note includes install advice", result.value.note.includes("playwright install"));
	equal("four wait strategies are listed", result.value.waitStrategies.length, 4);
	ok("the operations list the three analysis tools", result.value.operations.length === 3 && result.value.operations.includes("browser_fetch"));
	ok("the directories are absolute", result.value.directories.outputDir.includes("browser-output"));
	equal("the defaults echo the config", result.value.defaults.waitStrategy, "domcontentloaded");
	ok("the defaults report the viewport", result.value.defaults.viewport === "1280x800");
	equal("the defaults report requireBrowser", result.value.defaults.requireBrowser, false);
}
{
	const ctx = Context({ viewportWidth: 800, viewportHeight: 600, waitStrategy: "load", requireBrowser: true });
	plugin.apply(ctx, ctx.config);
	const { module: pw } = fakePlaywright();
	ctx.transport.playwrightModule = pw;
	const result = await call(ctx.get("browser_status"), {});
	equal("an available browser is reported", result.value.browser, true);
	equal("the default engine follows the browser", result.value.engine, "browser");
	equal("the configured wait strategy is echoed", result.value.defaults.waitStrategy, "load");
	equal("the configured viewport is echoed", result.value.defaults.viewport, "800x600");
	equal("requireBrowser is echoed", result.value.defaults.requireBrowser, true);
}
{
	// The status tool must not touch the network or the browser — it answers a
	// question about the install, and launching a browser to do that would make
	// the "is it available" check cost more than the work it guards.
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const fake = fakeFetch({ body: "" });
	ctx.transport.fetchImpl = fake.fetchImpl;
	const { log } = fakePlaywright();
	await call(ctx.get("browser_status"), {});
	equal("browser_status made no requests", fake.calls.length, 0);
	equal("browser_status launched nothing", log.launched, 0);
}

/* ------------------------------------------------------ config defaults */

{
	const config = plugin.Config({});
	equal("workDir defaults to the current directory", config.workDir, ".");
	equal("outputDir defaults to browser-output", config.outputDir, "browser-output");
	equal("waitStrategy defaults to domcontentloaded", config.waitStrategy, "domcontentloaded");
	equal("navTimeoutMs defaults to 30000", config.navTimeoutMs, 30000);
	equal("headless defaults to true", config.headless, true);
	equal("viewportWidth defaults to 1280", config.viewportWidth, 1280);
	equal("viewportHeight defaults to 800", config.viewportHeight, 800);
	equal("requireBrowser defaults to false", config.requireBrowser, false);
	equal("timeoutMs defaults to 300000", config.timeoutMs, 300000);
	equal("all four registration flags default to true", config.status && config.fetchPage && config.extract && config.screenshot, true);
}

/* -------------------------------------------------------------- report */

console.log(`browser integration: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);