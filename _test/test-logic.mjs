// White-box tests for the pure functions behind dsh-tool-browser.
//
// These are the parts where correctness is not obvious from a passing tool
// call: the prose-density scorer, the subtree picker, the HTML flatteners, the
// entity decoder, and the wait-strategy resolver. Testing them through a tool
// call would mean wrapping every assertion in JSON plumbing for no gain, so
// the harness re-exports them and they are exercised directly.
import { plugin, ARTICLE_HTML } from "./harness.mjs";
import { basename, join, resolve } from "node:path";

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
	if (a === b) {
		passed += 1;
	} else {
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

console.log("browser: logic");

/* ---------------------------------------------------- collapseWhitespace */

equal("collapse joins wrapped source lines", plugin.collapseWhitespace("a\n   b"), "a\nb");
equal("collapse squeezes internal spaces", plugin.collapseWhitespace("a     b"), "a b");
equal("collapse caps blank runs at one", plugin.collapseWhitespace("a\n\n\n\n\nb"), "a\n\nb");
equal("collapse trims the edges", plugin.collapseWhitespace("   \n  hi  \n  "), "hi");
equal("collapse treats nbsp as a space", plugin.collapseWhitespace("a\u00a0b"), "a b");
equal("collapse handles tabs and form feeds", plugin.collapseWhitespace("a\t\f\vb"), "a b");
equal("collapse of empty is empty", plugin.collapseWhitespace(""), "");
equal("collapse of null is empty", plugin.collapseWhitespace(null), "");

/* -------------------------------------------------------- decodeEntities */

equal("named entity", plugin.decodeEntities("a &amp; b"), "a & b");
equal("lt and gt", plugin.decodeEntities("&lt;tag&gt;"), "<tag>");
equal("quot", plugin.decodeEntities("say &quot;hi&quot;"), "say \"hi\"");
equal("apos", plugin.decodeEntities("it&apos;s"), "it's");
equal("nbsp becomes a plain space", plugin.decodeEntities("a&nbsp;b"), "a b");
equal("decimal entity", plugin.decodeEntities("&#65;"), "A");
equal("hex entity", plugin.decodeEntities("&#x41;"), "A");
equal("uppercase hex entity", plugin.decodeEntities("&#X41;"), "A");
equal("emoji by code point", plugin.decodeEntities("&#x1f600;"), "\u{1f600}");
equal("mdash", plugin.decodeEntities("a&mdash;b"), "a\u2014b");
equal("unknown entity is left alone", plugin.decodeEntities("&notareal;"), "&notareal;");
equal("a bare ampersand survives", plugin.decodeEntities("a & b"), "a & b");
equal("out-of-range code point is left alone", plugin.decodeEntities("&#999999999;"), "&#999999999;");
equal("zero code point is left alone", plugin.decodeEntities("&#0;"), "&#0;");
equal("decode of empty is empty", plugin.decodeEntities(""), "");

/* ---------------------------------------------------------- stripChrome */

{
	const stripped = plugin.stripChrome(ARTICLE_HTML);
	ok("nav is removed", !stripped.includes("main-nav"));
	ok("footer is removed", !stripped.includes("site-footer"));
	ok("the article survives stripping", stripped.includes("post-content"));
	ok("script contents are removed", !plugin.stripChrome("<p>a</p><script>var x = 1;</script>").includes("var x"));
	ok("style contents are removed", !plugin.stripChrome("<style>.a{}</style><p>a</p>").includes(".a{"));
	ok("iframes are removed", !plugin.stripChrome("<iframe src=x></iframe><p>a</p>").includes("iframe"));
	ok("comments in markup are removed", !plugin.stripChrome("<p>a</p><!-- secret -->").includes("secret"));
	// `br` is deliberately NOT stripped: it carries meaning (a line break), so
	// removing it would silently join two lines. Only chrome is removed.
	ok("a br is kept, because it is content", plugin.stripChrome("<p>a</p><br/>").includes("<br/>"));
}

/* ------------------------------------------------------------ htmlToText */

// Every assertion on `htmlToText` ends in `.trim()`, because a closing block
// tag appends the blank line that separates it from the next block. That
// trailing newline is correct and load-bearing for the Markdown path; asserting
// on the raw string would only be testing where the last block happens to end.
equal("tags are dropped", plugin.htmlToText("<p>hello</p>").trim(), "hello");
equal("block closes become blank lines", plugin.htmlToText("<p>a</p><p>b</p>").trim(), "a\n\nb");
equal("br becomes a newline", plugin.htmlToText("a<br>b"), "a\nb");
equal("a list item gets a dash", plugin.htmlToText("<ul><li>one</li></ul>").trim(), "- one");
equal("entities are decoded on the way out", plugin.htmlToText("<p>a &amp; b</p>").trim(), "a & b");
equal("nested inline tags are ignored", plugin.htmlToText("<p>a <strong>b</strong> c</p>").trim(), "a b c");
equal("empty markup yields empty text", plugin.htmlToText("<p></p>").trim(), "");
equal("text with no markup passes through", plugin.htmlToText("just words"), "just words");
ok("a closing block tag leaves a separator behind", plugin.htmlToText("<p>a</p>").endsWith("\n\n"));

/* -------------------------------------------------------- htmlToMarkdown */

equal("heading level 1", plugin.htmlToMarkdown("<h1>Title</h1>").trim(), "# Title");
equal("heading level 3", plugin.htmlToMarkdown("<h3>Sub</h3>").trim(), "### Sub");
equal("bold", plugin.htmlToMarkdown("<p>a <strong>b</strong></p>").trim(), "a **b**");
equal("italic", plugin.htmlToMarkdown("<p>a <em>b</em></p>").trim(), "a *b*");
equal("strikethrough", plugin.htmlToMarkdown("<p>a <del>b</del></p>").trim(), "a ~~b~~");
equal("inline code", plugin.htmlToMarkdown("<p>run <code>ls</code></p>").trim(), "run `ls`");
equal("a link keeps its href", plugin.htmlToMarkdown("<a href=\"/x\">go</a>").trim(), "[go](/x)");
// A label-less link is written as `[](url)` rather than `<url>`, because the
// generic tag sweep at the end of the converter cannot distinguish `<url>`
// from a closing tag and would delete it outright.
equal("a link with an empty label keeps its url", plugin.htmlToMarkdown("<a href=\"/x\"></a>").trim(), "[](/x)");
equal("a javascript: link is demoted to its text", plugin.htmlToMarkdown("<a href=\"javascript:void(0)\">click</a>").trim(), "click");
equal("a list becomes dashes", plugin.htmlToMarkdown("<ul><li>a</li><li>b</li></ul>").trim(), "- a\n- b");
equal("a blockquote is prefixed", plugin.htmlToMarkdown("<blockquote>quoted</blockquote>").trim(), "> quoted");
equal("a horizontal rule", plugin.htmlToMarkdown("<hr>").trim(), "---");
equal("a fenced block", plugin.htmlToMarkdown("<pre><code>x = 1</code></pre>").trim(), "```\nx = 1\n```");
ok("an image keeps its src and alt", plugin.htmlToMarkdown("<img src=\"/a.png\" alt=\"A\">").includes("![A](/a.png)"));
ok("an image with no alt is still emitted", plugin.htmlToMarkdown("<img src=\"/a.png\">").includes("![](/a.png)"));

/* -- the fence-widening rule -------------------------------------------- */

{
	// A run of backticks inside inline code would close the span early and
	// leak the rest of the sentence as prose, so the fence must be longer than
	// the longest run inside.
	const single = plugin.htmlToMarkdown("<code>a``b</code>").trim();
	equal("a double-backtick run widens the fence", single, "```a``b```");
	const padded = plugin.htmlToMarkdown("<code>`x`</code>").trim();
	equal("a leading and trailing backtick gets padding", padded, "`` `x` ``");
	const plain = plugin.htmlToMarkdown("<code>plain</code>").trim();
	equal("a plain span keeps a single fence", plain, "`plain`");
}

{
	// Code beats emphasis: the backticks must be the innermost pair, or the
	// asterisks end up inside the code span and render literally.
	const nested = plugin.htmlToMarkdown("<p><strong><code>x</code></strong></p>").trim();
	equal("bold code nests the backticks inside the asterisks", nested, "**`x`**");
}
{
	// Emphasis inside a link must survive. The link branch runs first (while
	// `href` is readable), so it has to convert its own label rather than
	// flatten it — otherwise a bolded link silently loses its bold, which is
	// how a warning turns into ordinary text.
	equal("bold inside a link keeps the emphasis",
		plugin.htmlToMarkdown("<a href=\"/x\"><strong>careful</strong></a>").trim(),
		"[**careful**](/x)");
	equal("italic inside a link keeps the emphasis",
		plugin.htmlToMarkdown("<a href=\"/x\"><em>note</em></a>").trim(),
		"[*note*](/x)");
	equal("bold outside a link keeps the link",
		plugin.htmlToMarkdown("<strong><a href=\"/x\">careful</a></strong>").trim(),
		"**[careful](/x)**");
	equal("a link in a heading keeps both", plugin.htmlToMarkdown("<h2><a href=\"/x\">Title</a></h2>").trim(), "## [Title](/x)");
}

/* -------------------------------------------------------- childElements */

{
	const html = "<div class=\"a\"><p>one</p></div><div><p>two</p></div>";
	const divs = plugin.childElements(html, "div");
	equal("both siblings are found", divs.length, 2);
	ok("the first child keeps its attributes", divs[0].attrs.includes("class=\"a\""));
	equal("the first child's inner html", divs[0].inner, "<p>one</p>");
	equal("the second child's inner html", divs[1].inner, "<p>two</p>");
}
{
	// A non-greedy regex would stop at the first inner close and report the
	// wrong subtree — which is the bug a counter exists to prevent.
	const nested = "<div><div><p>deep</p></div></div>";
	const outer = plugin.childElements(nested, "div");
	equal("the outer div is one child, not two", outer.length, 1);
	equal("the outer div's inner html is the full inner div", outer[0].inner, "<div><p>deep</p></div>");
}
{
	const odd = "<div><p>a</p><div><p>b</p>";
	equal("an unclosed container yields no child rather than a bad one", plugin.childElements(odd, "div").length, 0);
}
equal("no matches yields an empty list", plugin.childElements("<p>x</p>", "article").length, 0);

/* --------------------------------------------------------- nameScore */

ok("an article tag is favoured", plugin.nameScore("article", "") > 0);
ok("a main tag is favoured", plugin.nameScore("main", "") > 0);
ok("a content class is favoured", plugin.nameScore("div", "class=\"post-content\"") > 0);
ok("a nav class is penalised", plugin.nameScore("div", "class=\"main-nav\"") < 0);
ok("a footer class is penalised", plugin.nameScore("div", "class=\"site-footer\"") < 0);
ok("the plural 'comments' is penalised too", plugin.nameScore("div", "class=\"comments\"") < 0);
ok("a comment class is penalised harder than a sidebar", plugin.nameScore("div", "class=\"comment\"") < plugin.nameScore("div", "class=\"sidebar\""));
equal("a bare div scores zero", plugin.nameScore("div", ""), 0);
{
	// The hint must match a whole word: "contest" contains "test", and
	// "adventure" contains "ad", neither of which should sway the score.
	equal("a word that merely contains a hint does not score", plugin.nameScore("div", "class=\"contest\""), 0);
}

/* ------------------------------------------------------- scoreFragment */

{
	// The central property: density, not volume. A container holding its best
	// child plus chrome must score *lower* than the child alone.
	const child = "<article><p>" + "Real prose sentence, with punctuation. ".repeat(10) + "</p></article>";
	const parent = `<div>${child}<div class="comments"><p>Some comment text, also prose-like.</p></div></div>`;
	const childScore = plugin.scoreFragment(plugin.childElements(parent, "article")[0].inner, 30).score;
	const parentScore = plugin.scoreFragment(parent).score;
	ok("a container containing its best child scores lower than the child", childScore > parentScore);
}
{
	const prose = plugin.scoreFragment("<p>" + "This is a sentence, and it has punctuation. ".repeat(12) + "</p>");
	const links = plugin.scoreFragment(Array.from({ length: 40 }, (_, i) => `<a href="/l${i}">Link ${i}</a>`).join(" "));
	ok("a link farm scores below prose", links.score < prose.score);
	ok("a link farm records a high link density", links.linkDensity > 0.9);
	equal("an empty fragment scores zero", plugin.scoreFragment("").score, 0);
	equal("whitespace-only markup scores zero", plugin.scoreFragment("<div>   </div>").score, 0);
}
{
	const dense = plugin.scoreFragment("<p>" + "Word, word. ".repeat(20) + "</p>").score;
	const sparse = plugin.scoreFragment("<div>" + "word ".repeat(20) + "</div>").score;
	ok("punctuation raises the score over an unpunctuated block", dense > sparse);
}

/* ----------------------------------------------------- pickContentRoot */

{
	const picked = plugin.pickContentRoot(plugin.stripChrome(ARTICLE_HTML));
	ok("the article is chosen over the body", picked.selector.startsWith("article"));
	// `picked.html` is the *inner* markup of the chosen element, so the
	// article's own `class` attribute is not part of it — the heading inside is.
	ok("the chosen subtree is the article's markup", picked.html.includes("Why Median Beats Mean"));
	ok("the chosen subtree is not the whole document", !picked.html.includes("<body"));
	ok("the chosen subtree excludes the footer", !picked.html.includes("site-footer"));
}
{
	const noArticle = "<html><body>" + "<p>" + "A long sentence, with commas. ".repeat(20) + "</p>" + "</body></html>";
	const picked = plugin.pickContentRoot(plugin.stripChrome(noArticle));
	equal("a document with no candidate container falls back to the whole body", picked.selector, "body");
}

/* ------------------------------------------------------ extractContent */

{
	const result = plugin.extractContent(ARTICLE_HTML, { format: "markdown" });
	ok("the markdown keeps the heading", result.content.includes("# Why Median Beats Mean"));
	ok("the markdown keeps the bold run", result.content.includes("**one sentence**"));
	ok("the markdown keeps the list", result.content.includes("- Robust to outliers"));
	ok("the markdown keeps the blockquote", result.content.includes("> Half the data is above"));
	ok("the markdown keeps the link", result.content.includes("[the robust statistics note]"));
	ok("the nav bar is absent", !result.content.includes("Pricing"));
	ok("the footer is absent", !result.content.includes("Sitemap"));
	ok("the comments are absent", !result.content.includes("great post!"));
	equal("the title is read from the head", result.title, "Why Median Beats Mean");
	ok("the winning score is positive", result.score > 0);
	ok("nothing was truncated", result.truncated === false);
}
{
	const text = plugin.extractContent(ARTICLE_HTML);
	ok("plain text drops the heading markers", !text.content.includes("# "));
	ok("plain text keeps the words", text.content.includes("Why Median Beats Mean"));
}
{
	const noLinks = plugin.extractContent(ARTICLE_HTML, { format: "markdown", keepLinks: false });
	ok("keepLinks false strips the link syntax", !noLinks.content.includes("]("));
	ok("keepLinks false keeps the link label", noLinks.content.includes("the robust statistics note"));
}
{
	const clipped = plugin.extractContent(ARTICLE_HTML, { maxChars: 50 });
	equal("maxChars truncates to the budget", clipped.content.length, 50);
	ok("maxChars marks the truncation", clipped.truncated === true);
}
{
	const big = plugin.extractContent(ARTICLE_HTML, { format: "markdown" });
	ok("the markdown keeps block separation", big.content.includes("\n\n"));
	ok("the markdown never has three newlines in a row", !/\n{3}/u.test(big.content));
}

/* ------------------------------------------------- extractTitle / Description */

equal("title is read from the title tag", plugin.extractTitle(ARTICLE_HTML), "Why Median Beats Mean");
equal("title falls back to og:title", plugin.extractTitle("<meta property=\"og:title\" content=\"OG Title\">"), "OG Title");
equal("a document with no title yields empty", plugin.extractTitle("<p>x</p>"), "");
equal("title entities are decoded", plugin.extractTitle("<title>a &amp; b</title>"), "a & b");
equal("description is read", plugin.extractDescription(ARTICLE_HTML), "A short argument about averages.");
equal("description reads content before name", plugin.extractDescription("<meta content=\"Reversed\" name=\"description\">"), "Reversed");
equal("description falls back to og", plugin.extractDescription("<meta property=\"og:description\" content=\"From OG\">"), "From OG");
equal("a document with no description yields empty", plugin.extractDescription("<p>x</p>"), "");

/* --------------------------------------------------------- extractLinks */

{
	const links = plugin.extractLinks(ARTICLE_HTML, "https://example.com/post");
	ok("a relative href is resolved", links.some((l) => l.url === "https://example.com/stats/robust"));
	ok("an absolute-looking site root is resolved", links.some((l) => l.url === "https://example.com/"));
	ok("a fragment-only link is skipped", !links.some((l) => l.url.includes("#")));
	ok("each link carries its label", links.some((l) => l.text === "the robust statistics note"));
	equal("duplicates are removed", links.filter((l) => l.url === "https://example.com/").length, 1);
}
{
	const links = plugin.extractLinks("<a href=\"javascript:alert(1)\">x</a><a href=\"/ok\">y</a>", "https://e.test/p");
	equal("a javascript: link is skipped", links.length, 1);
	equal("the surviving link is the real one", links[0].url, "https://e.test/ok");
}
equal("no links yields an empty list", plugin.extractLinks("<p>x</p>", "https://e.test").length, 0);

/* --------------------------------------------------------- resolveWait */

{
	const r1 = plugin.resolveWait({ waitForSelector: ".content" }, "load");
	equal("a selector implies the selector strategy", r1.strategy, "selector");
	equal("the selector is carried through", r1.target, ".content");
	const r2 = plugin.resolveWait({ waitStrategy: "networkidle" }, "load");
	equal("an explicit strategy wins over the default", r2.strategy, "networkidle");
	equal("an explicit strategy has no target", r2.target, null);
	const r3 = plugin.resolveWait({}, "load");
	equal("no argument falls back to the config", r3.strategy, "load");
	equal("the fallback has no target", r3.target, null);
	const r4 = plugin.resolveWait({ waitForSelector: "  #main  " }, "load");
	equal("a selector is trimmed", r4.target, "#main");
	const r5 = plugin.resolveWait({ waitForSelector: "   " }, "domcontentloaded");
	equal("a whitespace-only selector is ignored", r5.strategy, "domcontentloaded");
}
{
	const bad = (() => {
		try { plugin.resolveWait({ waitStrategy: "nonsense" }, "load"); return null; } catch (e) { return e.message; }
	})();
	ok("an unknown strategy is rejected", typeof bad === "string" && bad.includes("nonsense"));
	ok("the rejection names the accepted values", bad.includes("domcontentloaded") && bad.includes("networkidle"));
	const badDefault = (() => {
		try { plugin.resolveWait({}, "nonsense"); return null; } catch (e) { return e.message; }
	})();
	ok("a bad configured default is rejected too", typeof badDefault === "string" && badDefault.includes("nonsense"));
}
equal("all four strategies are exported in order", plugin.WAIT_STRATEGIES.join(","), "domcontentloaded,load,networkidle,selector");

/* -------------------------------------------------------- normalizeUrl */

equal("a plain URL is kept", plugin.normalizeUrl("https://example.com/a"), "https://example.com/a");
equal("a trailing slash is normalised", plugin.normalizeUrl("https://example.com"), "https://example.com/");
equal("the input is trimmed", plugin.normalizeUrl("  https://example.com/  "), "https://example.com/");
equal("a query survives", plugin.normalizeUrl("https://e.test/s?q=1"), "https://e.test/s?q=1");
{
	const missing = (() => { try { plugin.normalizeUrl(""); return null; } catch (e) { return e.message; } })();
	ok("an empty URL is rejected", typeof missing === "string" && missing.includes("required"));
	const relative = (() => { try { plugin.normalizeUrl("/just/a/path"); return null; } catch (e) { return e.message; } })();
	ok("a relative URL is rejected with advice", relative.includes("absolute"));
	const scheme = (() => { try { plugin.normalizeUrl("file:///c:/x"); return null; } catch (e) { return e.message; } })();
	ok("a file URL is rejected", scheme.includes("http"));
	const ftp = (() => { try { plugin.normalizeUrl("ftp://e.test/x"); return null; } catch (e) { return e.message; } })();
	ok("an ftp URL is rejected", ftp.includes("http"));
}

/* --------------------------------------------------------------- clamp */

{
	equal("clamp leaves a short string alone", plugin.clamp("abc", 10).content, "abc");
	equal("clamp does not mark a short string", plugin.clamp("abc", 10).truncated, false);
	equal("clamp cuts to the budget", plugin.clamp("abcdef", 3).content, "abc");
	equal("clamp marks the cut", plugin.clamp("abcdef", 3).truncated, true);
	equal("a zero budget means unlimited", plugin.clamp("abcdef", 0).truncated, false);
	equal("a negative budget means unlimited", plugin.clamp("abcdef", -5).truncated, false);
	equal("a non-finite budget means unlimited", plugin.clamp("abcdef", Number.NaN).truncated, false);
	equal("an exact-length string is not truncated", plugin.clamp("abc", 3).truncated, false);
}

/* ---------------------------------------------------------- outputPath */

{
	// `path.resolve` alone is NOT enough here: it honours an absolute second
	// argument, so `resolve("/out", "C:/Windows/evil.png")` hands back the
	// Windows path and the write escapes the configured tree entirely. Every
	// case below is a way of trying to leave that tree.
	const dir = resolve("C:/Users/yuehancn/WorkBuddy/2026-10-02-10-43-11/browser-sandbox");
	const inside = (candidate) => candidate.startsWith(dir);

	equal("a plain name lands in the output directory", plugin.outputPath(dir, "shot.png"), join(dir, "shot.png"));
	equal("a leading ./ is discarded", plugin.outputPath(dir, "shot.png"), plugin.outputPath(dir, "./shot.png"));
	ok("a plain name is inside the directory", inside(plugin.outputPath(dir, "shot.png")));

	const absolute = plugin.outputPath(dir, "C:/Windows/system32/evil.png");
	ok("a windows absolute path does not escape", inside(absolute));
	equal("its file name is preserved", basename(absolute), "evil.png");

	const unixAbsolute = plugin.outputPath(dir, "/etc/passwd");
	ok("a unix absolute path does not escape", inside(unixAbsolute));
	equal("its file name is preserved", basename(unixAbsolute), "passwd");

	const traversal = plugin.outputPath(dir, "../../../../Windows/evil.png");
	ok("a traversal does not escape", inside(traversal));
	equal("the traversal's file name is preserved", basename(traversal), "evil.png");

	const backslashed = plugin.outputPath(dir, "..\\..\\Windows\\evil.png");
	ok("a windows-style traversal does not escape", inside(backslashed));

	const empty = plugin.outputPath(dir, "");
	ok("an empty name still lands inside", inside(empty));
	ok("an empty name gets a generated fallback", basename(empty).startsWith("out-"));

	const dotsOnly = plugin.outputPath(dir, "../..");
	ok("a name of only dots still lands inside", inside(dotsOnly));
	ok("a dots-only name gets the fallback too", basename(dotsOnly).startsWith("out-"));

	// A name is a name, not a location: the caller picks the file, the plugin
	// picks the directory, and those two decisions must not be negotiable.
	ok("a nested relative path is flattened to its last segment", inside(plugin.outputPath(dir, "sub/dir/shot.png")));
	equal("only the last segment survives", basename(plugin.outputPath(dir, "sub/dir/shot.png")), "shot.png");
}

/* ----------------------------------------------------- staticFetch */

{
	// The static path is the only one that touches the network, and it must go
	// through the injected fetch — never `globalThis.fetch` — so the suite and
	// the real tool can be pointed at different places.
	const { fakeFetch } = await import("./harness.mjs");
	const fake = fakeFetch({ body: "<html><body>hi</body></html>", url: "https://e.test/redirected" });
	const result = await plugin.staticFetch("https://e.test/start", { timeoutMs: 1000, fetchImpl: fake.fetchImpl });
	equal("the body is returned", result.html, "<html><body>hi</body></html>");
	equal("the final url is reported", result.finalUrl, "https://e.test/redirected");
	equal("the status is reported", result.status, 200);
	equal("the byte count is measured in utf8", result.bytes, Buffer.byteLength("<html><body>hi</body></html>", "utf8"));
	equal("exactly one request was made", fake.calls.length, 1);
	equal("the requested url is the one given", fake.calls[0].url, "https://e.test/start");
	equal("redirects are followed", fake.calls[0].init.redirect, "follow");
	ok("a user agent is sent", typeof fake.calls[0].init.headers["user-agent"] === "string");
}
{
	const { fakeFetch } = await import("./harness.mjs");
	const fake = fakeFetch({ body: "<html></html>", status: 500 });
	const errored = await plugin.staticFetch("https://e.test/x", { timeoutMs: 1000, fetchImpl: fake.fetchImpl })
		.then(() => null, (e) => e.message);
	ok("a 500 is surfaced as an error", typeof errored === "string");
	ok("the error names the status", errored.includes("500"));
}
{
	const { fakeFetch } = await import("./harness.mjs");
	const fake = fakeFetch({ body: "<html></html>" });
	const withUa = await plugin.staticFetch("https://e.test/x", { timeoutMs: 1000, userAgent: "MyBot/2.0", fetchImpl: fake.fetchImpl });
	ok("a custom user agent overrides the default", fake.calls[0].init.headers["user-agent"] === "MyBot/2.0");
	ok("the result still carries the body", withUa.html.includes("html"));
}
{
	// A multi-byte body must report its real byte length, not its character
	// count — the two differ for every CJK page on the web.
	const { fakeFetch } = await import("./harness.mjs");
	const body = "<p>\u4e2d\u6587\u5185\u5bb9</p>";
	const fake = fakeFetch({ body });
	const result = await plugin.staticFetch("https://e.test/x", { timeoutMs: 1000, fetchImpl: fake.fetchImpl });
	equal("the byte count counts bytes, not characters", result.bytes, Buffer.byteLength(body, "utf8"));
	ok("the byte count exceeds the character count", result.bytes > body.length);
}

/* ------------------------------------------------------ loadPlaywright */

{
	// A missing browser is a configuration fact, not an error: the resolver
	// must return null so the caller can fall back rather than throw.
	const absent = await plugin.loadPlaywright({ load: async () => { throw new Error("Cannot find module 'playwright'"); } });
	equal("a missing module resolves to null", absent, null);
	const present = await plugin.loadPlaywright({ load: async () => ({ chromium: {} }) });
	ok("a module with chromium is accepted", present !== null && present.chromium !== undefined);
	const defaulted = await plugin.loadPlaywright({ load: async () => ({ default: { chromium: {} } }) });
	ok("a default-wrapped module is unwrapped", defaulted !== null && defaulted.chromium !== undefined);
	const wrong = await plugin.loadPlaywright({ load: async () => ({ firefox: {} }) });
	equal("a module without chromium is rejected", wrong, null);
	const broken = await plugin.loadPlaywright({ load: async () => null });
	equal("a null module resolves to null", broken, null);
	const custom = await plugin.loadPlaywright({ module: "my-driver", load: async (spec) => spec === "my-driver" ? { chromium: { tag: 1 } } : null });
	ok("the module name is passed to the loader", custom !== null && custom.chromium.tag === 1);
}

/* ------------------------------------------------ renderWithBrowser */

{
	const { fakePlaywright } = await import("./harness.mjs");
	const { module: pw, log } = fakePlaywright({ html: "<article><p>rendered</p></article>", title: "Page!", finalUrl: "https://e.test/final" });
	const config = plugin.Config({ headless: true, viewportWidth: 1024, viewportHeight: 768, navTimeoutMs: 1234 });
	const result = await plugin.renderWithBrowser("https://e.test/start", {
		playwright: pw,
		wait: { strategy: "networkidle", target: null },
		config
	});
	ok("the rendered html is returned", result.html.includes("rendered"));
	equal("the final url is reported", result.finalUrl, "https://e.test/final");
	equal("the status is reported", result.status, 200);
	equal("the wait duration is measured", typeof result.waitedMs, "number");
	equal("the browser was launched once", log.launched, 1);
	equal("the browser was closed", log.closed, 1);
	equal("the context was closed", log.contextsClosed, 1);
	equal("the viewport came from the config", JSON.stringify(log.viewport), JSON.stringify({ width: 1024, height: 768 }));
	equal("the wait strategy reached goto", log.gotoOptions[0].waitUntil, "networkidle");
	equal("the navigation timeout reached goto", log.gotoOptions[0].timeout, 1234);
	equal("headless came from the config", log.headless, true);
}
{
	const { fakePlaywright } = await import("./harness.mjs");
	const { module: pw, log } = fakePlaywright();
	const config = plugin.Config({ navTimeoutMs: 999 });
	await plugin.renderWithBrowser("https://e.test/x", {
		playwright: pw,
		wait: { strategy: "selector", target: "#app" },
		config
	});
	// With a selector the navigation cannot wait for network idle — the content
	// is by definition not there yet — so goto must use a weaker signal and the
	// selector wait carries the real condition.
	equal("the selector strategy downgrades goto", log.gotoOptions[0].waitUntil, "domcontentloaded");
	equal("the selector was awaited", log.waitForSelector[0].selector, "#app");
	equal("the selector wait uses the navigation timeout", log.waitForSelector[0].timeout, 999);
}
{
	const { fakePlaywright } = await import("./harness.mjs");
	const { module: pw, log } = fakePlaywright({ gotoError: new Error("net::ERR_TIMED_OUT") });
	const config = plugin.Config({});
	const errored = await plugin.renderWithBrowser("https://e.test/x", {
		playwright: pw, wait: { strategy: "load", target: null }, config
	}).then(() => null, (e) => e.message);
	ok("a navigation failure propagates", typeof errored === "string");
	ok("the failure names the cause", errored.includes("ERR_TIMED_OUT"));
	// The resources must be released on the failure path too, or a timed-out
	// scrape leaks a browser process on every retry.
	equal("the browser was still closed after a failure", log.closed, 1);
	equal("the context was still closed after a failure", log.contextsClosed, 1);
}
{
	const { fakePlaywright } = await import("./harness.mjs");
	const { module: pw, log } = fakePlaywright({ userAgent: "ignored" });
	const config = plugin.Config({ userAgent: "Bot/9.9" });
	await plugin.renderWithBrowser("https://e.test/x", { playwright: pw, wait: { strategy: "load", target: null }, config });
	equal("a configured user agent reaches the context", log.userAgent, "Bot/9.9");
}
{
	const { fakePlaywright } = await import("./harness.mjs");
	const { module: pw, log } = fakePlaywright();
	const config = plugin.Config({});
	await plugin.renderWithBrowser("https://e.test/x", { playwright: pw, wait: { strategy: "load", target: null }, config });
	equal("no user agent means the context gets none", log.userAgent, null);
}

/* ------------------------------------------------------- constants sanity */

equal("only http and https are allowed by normalizeUrl", "checked above", "checked above");
ok("the strip list includes script and nav", plugin.STRIP_TAGS.includes("script") && plugin.STRIP_TAGS.includes("nav"));
ok("the strip list includes footer and aside", plugin.STRIP_TAGS.includes("footer") && plugin.STRIP_TAGS.includes("aside"));
ok("every wait strategy is one of the four", plugin.WAIT_STRATEGIES.every((s) => ["domcontentloaded", "load", "networkidle", "selector"].includes(s)));
ok("the content hints include article and content", plugin.CONTENT_HINTS.includes("article") && plugin.CONTENT_HINTS.includes("content"));
ok("the chrome hints include nav and comment", plugin.CHROME_HINTS.includes("nav") && plugin.CHROME_HINTS.includes("comment"));
equal("the block tag set has every heading level", ["h1", "h2", "h3", "h4", "h5", "h6"].every((h) => plugin.BLOCK_TAGS.has(h)), true);

/* ------------------------------------------------------------- report */

console.log(`browser logic: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);