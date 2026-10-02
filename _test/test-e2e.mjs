// End-to-end tests: one coherent scraping task, run twice through the two
// engines, against a page built to break a careless extractor.
//
// The fixture is a documentation page with everything a real docs site has and
// an extractor usually gets wrong:
//   - a sticky nav bar with a link farm, and a footer sitemap
//   - an article with headings, a code fence containing `#` shell comments,
//     a nested code span inside a bold run, a bold link, and a task list
//   - a table of contents sidebar that is mostly links but sits *inside* the
//     content column, so link density alone must not be fooled
//   - a "Related posts" block and a 30-link comment section
//   - an inline `<script>` whose text contains words that also appear in the
//     article, so a missing strip step would show up as extra prose
//
// The task: extract the article as Markdown, verify the chrome is gone, verify
// the code fence survived intact, and confirm both engines agree.
import { Context, call, fakeFetch, fakePlaywright, assertNoNetwork, plugin } from "./harness.mjs";

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

console.log("browser: end to end");

/** A documentation page designed to defeat a naive extractor. */
const DOCS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
	<title>Deploying the Worker &mdash; Runbook</title>
	<meta name="description" content="How to roll out the worker without dropping requests.">
	<script>var analytics = { words: "sticky nav footer comment related" };</script>
</head>
<body class="docs">
	<nav class="site-nav">
		<a href="/">Home</a><a href="/docs">Docs</a><a href="/api">API</a>
		<a href="/changelog">Changelog</a><a href="/blog">Blog</a><a href="/pricing">Pricing</a>
		<a href="/login">Log in</a><a href="/signup">Sign up</a>
	</nav>
	<div class="layout">
		<main>
			<article class="markdown-body">
				<h1>Deploying the Worker</h1>
				<p>The worker is deployed one region at a time. Wait for the health check to pass before moving on, or you will drop requests during the rollout.</p>
				<p><strong>Never skip the canary.</strong> It costs <strong><code>two minutes</code></strong> and it catches configuration drift that no test covers.</p>
				<h2>Steps</h2>
				<ol>
					<li>Deploy to <code>canary</code>.</li>
					<li>Watch the error rate for two minutes.</li>
					<li>Promote to the remaining regions.</li>
				</ol>
				<h2>Rollback</h2>
				<p>Run the rollback script. It is safe to run twice, and it is the <a href="/docs/rollback"><strong>only sanctioned path</strong></a> back.</p>
				<pre><code># roll back the last deploy
worker rollback --region all \\
  --reason "error rate spike"</code></pre>
				<ul>
					<li>Check the deploy log first.</li>
					<li>Then confirm the health endpoint.</li>
				</ul>
				<p>See the <a href="/docs/health">health endpoint reference</a> for the exact response shape.</p>
			</article>
			<section class="related-posts">
				<h3>Related posts</h3>
				<p><a href="/blog/a">A</a> <a href="/blog/b">B</a> <a href="/blog/c">C</a></p>
			</section>
		</main>
		<aside class="toc">
			<h3>On this page</h3>
			<a href="#steps">Steps</a><a href="#rollback">Rollback</a>
		</aside>
	</div>
	<section id="comments" class="comments-area">
		<h3>30 Comments</h3>
		${Array.from({ length: 30 }, (_, i) => `<p><a href="/u/${i}">user${i}</a> thanks, this helped a lot</p>`).join("\n\t\t")}
	</section>
	<footer class="site-footer">
		<a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/sitemap">Sitemap</a><a href="/status">Status</a>
	</footer>
</body>
</html>`;

/* ------------------------------------------------- the browser engine run */

const browserCtx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
plugin.apply(browserCtx, browserCtx.config);
{
	const { module: pw, log } = fakePlaywright({
		html: DOCS_PAGE,
		title: "Deploying the Worker \u2014 Runbook",
		finalUrl: "https://docs.test/runbook"
	});
	browserCtx.transport.playwrightModule = pw;

	const fetched = await call(browserCtx.get("browser_fetch"), { url: "https://docs.test/runbook", mode: "browser" });
	equal("the browser engine reported itself", fetched.value.engine, "browser");
	equal("the page was rendered once", log.launched, 1);
	equal("the browser was released", log.closed, 1);
	ok("the html is the rendered document", fetched.value.html.includes("markdown-body"));
	equal("the final url is the page's own", fetched.value.finalUrl, "https://docs.test/runbook");
	equal("the title came from the page", fetched.value.title, "Deploying the Worker \u2014 Runbook");

	const extracted = await call(browserCtx.get("browser_extract"), {
		url: "https://docs.test/runbook", mode: "browser", format: "markdown"
	});
	const md = extracted.value.content;

	// -- the article is there ------------------------------------------------
	ok("the heading survives", md.includes("# Deploying the Worker"));
	ok("both subheadings survive", md.includes("## Steps") && md.includes("## Rollback"));
	ok("the first paragraph survives", md.includes("deployed one region at a time"));

	// -- the chrome is gone --------------------------------------------------
	ok("the nav bar is gone", !md.includes("Changelog") && !md.includes("Pricing"));
	ok("the footer sitemap is gone", !md.includes("Sitemap") && !md.includes("Status"));
	ok("the related-posts block is gone", !md.includes("Related posts"));
	ok("the comment section is gone", !md.includes("30 Comments"));
	ok("no comment text leaked through", !md.includes("thanks, this helped"));
	ok("the table of contents is gone", !md.includes("On this page"));

	// -- the inline script is gone, which matters because its words overlap ---
	ok("the inline script is gone", !md.includes("analytics") && !md.includes("words:"));

	// -- the structures a reader would miss ----------------------------------
	ok("the ordered list survives", md.includes("1. Deploy to") || md.includes("- Deploy to"));
	ok("the unordered list survives", md.includes("Check the deploy log first"));
	ok("bold survives", md.includes("**Never skip the canary.**"));
	ok("the plain link survives", md.includes("[health endpoint reference](/docs/health)"));

	// The nested case. The source is `<a href><strong>label</strong></a>` — the
	// link is outside, the emphasis inside — so the correct Markdown keeps the
	// emphasis inside the link label. Flattening the label would drop the bold
	// silently, which is how a bolded warning becomes ordinary text.
	ok("a bold link keeps both markers", md.includes("[**only sanctioned path**](/docs/rollback)"));

	// The code fence is the hard one: it contains `#`, a line continuation, and
	// a quoted string with a `--` flag. None of that may be read as Markdown.
	ok("the code fence survives", md.includes("\`\`\`"));
	ok("the shell comment inside the fence survives", md.includes("# roll back the last deploy"));
	ok("the continuation inside the fence survives", md.includes("worker rollback --region all"));
	ok("the reason flag survives", md.includes("--reason"));
	ok("the fence opened once", (md.match(/```/gu) ?? []).length === 2);

	// An inline code span nested in a bold run: the backticks must be innermost.
	ok("bold inline code nests correctly", md.includes("**\`two minutes\`**"));

	equal("the winning selector is the article", extracted.value.selector.startsWith("article"), true);
	equal("the description was read", extracted.value.description, "How to roll out the worker without dropping requests.");
	ok("nothing was truncated", extracted.value.truncated === false);
}

/* -------------------------------------------------- the static engine run */

const staticCtx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
plugin.apply(staticCtx, staticCtx.config);
const staticFake = fakeFetch({ body: DOCS_PAGE, url: "https://docs.test/runbook" });
staticCtx.transport.fetchImpl = staticFake.fetchImpl;
{
	const extracted = await call(staticCtx.get("browser_extract"), {
		url: "https://docs.test/runbook", mode: "static", format: "markdown"
	});
	assertNoNetwork(staticFake.calls, "static extract");
	equal("the static engine reported itself", extracted.value.engine, "static");
	equal("the note says it was requested", extracted.value.engineNote, "requested: static");
	const md = extracted.value.content;

	ok("the heading survives in the static run too", md.includes("# Deploying the Worker"));
	ok("the chrome is gone in the static run too", !md.includes("Changelog") && !md.includes("Sitemap"));
	ok("the code fence survives the static run", md.includes("# roll back the last deploy"));
	ok("the comments are gone in the static run", !md.includes("30 Comments"));
}

/* --------------------------------- the two engines must agree on the body */

{
	const browserResult = await call(browserCtx.get("browser_extract"), {
		url: "https://docs.test/runbook", mode: "browser", format: "markdown"
	});
	const staticResult = await call(staticCtx.get("browser_extract"), {
		url: "https://docs.test/runbook", mode: "static", format: "markdown"
	});
	// The same document through two engines must produce the same article. If
	// these ever diverge, the tool's output depends on whether a browser happens
	// to be installed — which is the worst kind of bug to debug from a report.
	equal("both engines chose the same subtree", browserResult.value.selector, staticResult.value.selector);
	equal("both engines extracted identical markdown", browserResult.value.content, staticResult.value.content);
	equal("both engines reported the same length", browserResult.value.contentChars, staticResult.value.contentChars);
}

/* ----------------------------------------- a link-heavy page must not win */

{
	// A page whose only content is a link farm has no article. The extractor
	// must not hand back 40 links as if they were prose.
	const linkFarm = "<html><body><div>" + Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">Category page number ${i}</a>`).join(" ") + "</div></body></html>";
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	ctx.transport.fetchImpl = fakeFetch({ body: linkFarm }).fetchImpl;
	const result = await call(ctx.get("browser_extract"), { url: "https://e.test/links", mode: "static" });
	ok("a link farm scores near zero", result.value.score < 5);
}

/* ------------------------------------------- a page with no article tag */

{
	const plain = "<html><head><title>Plain</title></head><body><nav><a href=\"/x\">Nav</a></nav><p>" + "A real sentence, with punctuation. ".repeat(30) + "</p><footer><a href=\"/y\">Foot</a></footer></body></html>";
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	ctx.transport.fetchImpl = fakeFetch({ body: plain }).fetchImpl;
	const result = await call(ctx.get("browser_extract"), { url: "https://e.test/plain", mode: "static" });
	ok("prose is still found with no article tag", result.value.content.length > 500);
	ok("the nav is still removed", !result.value.content.includes("Nav"));
	ok("the footer is still removed", !result.value.content.includes("Foot"));
}

/* ------------------------------------------ saving the page to disk */

{
	const ctx = Context({ workDir: "C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox" });
	plugin.apply(ctx, ctx.config);
	ctx.transport.fetchImpl = fakeFetch({ body: DOCS_PAGE }).fetchImpl;
	const saved = await call(ctx.get("browser_fetch"), {
		url: "https://docs.test/runbook", mode: "static", saveAs: "runbook.html", maxChars: 200
	});
	ok("the returned html was truncated to the budget", saved.value.html.length === 200);
	equal("the truncation is flagged", saved.value.truncated, true);
	const { readFile, stat } = await import("node:fs/promises");
	const onDisk = await readFile(saved.value.savedTo, "utf8");
	equal("the saved file holds the whole page", onDisk.length, DOCS_PAGE.length);
	ok("the saved file is under the output directory", saved.value.savedTo.includes("browser-output"));
	const info = await stat(saved.value.savedTo);
	ok("the file exists on disk", info.size > 0);
}

/* ---------------------------------------------------------------- report */

console.log(`browser end to end: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);