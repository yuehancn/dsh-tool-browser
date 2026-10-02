/**
 * Model-facing browser tools: open a page, wait for it the way the page
 * actually needs, pull out the readable content, and take a picture.
 *
 * Why this exists
 * - A page that renders its article with JavaScript returns an empty body to a
 *   plain HTTP GET. A page that renders it on the server returns the full
 *   article to that same GET, and paying for a whole browser to fetch it is
 *   waste. The hard part is not "which is better" — it is deciding, per URL,
 *   which one you are looking at, and being honest when you cannot.
 * - "Wait for the page to load" is four different waits wearing one name:
 *   wait for the DOM, wait for the network to go quiet, wait for one element to
 *   exist, or wait a fixed number of milliseconds. Picking the wrong one is how
 *   a scraper returns a loading spinner as if it were content.
 * - The extraction step is where scrapers quietly fail: an <article> that
 *   contains a nav bar and 40 footer links is not "the content", and neither is
 *   a <div> chain chosen by guessing. This plugin scores candidate subtrees by
 *   the density of prose in them, which is a property of the text and not of
 *   the markup's names.
 *
 * Notes
 * - Playwright is a *peer* dependency, resolved at call time and never
 *   bundled. If it is not installed, the tools do not crash and do not
 *   silently pretend: they fall back to a static fetch and say in the result
 *   that the page's JavaScript never ran, because that changes what the answer
 *   means.
 * - The static path shares the extraction code with the browser path, so the
 *   two cannot drift into disagreeing about what "the article" is.
 * - Every tool reports which of the two engines produced the result and how
 *   long the wait actually took, so a surprising answer can be diagnosed
 *   instead of re-run blindly.
 * @module dsh-tool-browser
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-tool-browser";

/** Services required by the browser tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms). A real browser launch is slow. */
const DEFAULT_TIMEOUT_MS = 300000;

/** Playwright's own navigation timeout default, if the caller does not say. */
const DEFAULT_NAV_TIMEOUT_MS = 30000;

/** The four waits, named for what they actually wait on. */
const WAIT_STRATEGIES = ["domcontentloaded", "load", "networkidle", "selector"];

/**
 * Tags whose text is never part of the article.
 *
 * These are removed *before* scoring rather than after, because a nav bar full
 * of link text would otherwise be scored as if it were prose.
 */
const STRIP_TAGS = [
	"script", "style", "noscript", "template", "svg", "canvas", "iframe",
	"nav", "footer", "header", "aside", "form", "button", "select", "option"
];

/** Tags that, on their own, strongly suggest "this is the article". */
const CONTENT_HINTS = ["article", "main", "post", "content", "entry", "story", "body", "text"];

/** Tags that suggest "this is chrome around the article". */
const CHROME_HINTS = ["nav", "menu", "sidebar", "footer", "header", "comment", "share", "related", "promo", "ad", "breadcrumb", "pagination", "meta"];

/** Block-level tags that deserve their own line in the Markdown output. */
const BLOCK_TAGS = new Set([
	"p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6",
	"ul", "ol", "li", "blockquote", "pre", "table", "tr", "br", "hr", "figure",
	"figcaption", "dl", "dt", "dd", "address"
]);

/** Heading tag → Markdown prefix. */
const HEADING_PREFIX = { h1: "# ", h2: "## ", h3: "### ", h4: "#### ", h5: "##### ", h6: "###### " };

/* ------------------------------------------------------------------ config */

const Config = z.object({
	/** Directory that relative output paths resolve against. */
	workDir: z.string().default("."),
	/** Directory that screenshots and saved pages are written to. */
	outputDir: z.string().default("browser-output"),
	/** How to wait after navigating. One of `WAIT_STRATEGIES`. */
	waitStrategy: z.string().default("domcontentloaded"),
	/** Navigation timeout in milliseconds. */
	navTimeoutMs: z.number().default(DEFAULT_NAV_TIMEOUT_MS),
	/** Run the browser without a visible window. */
	headless: z.boolean().default(true),
	/** Viewport width in CSS pixels. */
	viewportWidth: z.number().default(1280),
	/** Viewport height in CSS pixels. */
	viewportHeight: z.number().default(800),
	/** Send a realistic user agent instead of the default headless one. */
	userAgent: z.string().default(""),
	/** When true, the static fallback is refused and a missing browser is an error. */
	requireBrowser: z.boolean().default(false),
	/** Register `browser_status`. */
	status: z.boolean().default(true),
	/** Register `browser_fetch`. */
	fetchPage: z.boolean().default(true),
	/** Register `browser_extract`. */
	extract: z.boolean().default(true),
	/** Register `browser_screenshot`. */
	screenshot: z.boolean().default(true),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
});

/* ------------------------------------------------------------- html utils */

/**
 * Collapse whitespace the way a reader sees it.
 *
 * HTML is indented for the author's benefit, not the reader's; a paragraph
 * broken across six source lines is one paragraph. Runs of spaces become one
 * space, and runs of blank lines become one newline.
 *
 * @param {string} text - raw text, possibly with markup-induced whitespace.
 * @returns {string} the collapsed text.
 */
function collapseWhitespace(text) {
	return String(text ?? "")
		.replace(/[\t\f\v\u00a0]+/gu, " ")
		.replace(/ *\r?\n */gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.replace(/ {2,}/gu, " ")
		.trim();
}

/**
 * Decode the HTML entities that survive plain-text extraction.
 *
 * A regex pass, not a parser: by the time this runs the markup is gone, so the
 * only entities left are the ones that were written as escapes in the text.
 *
 * @param {string} text - text that may contain entities.
 * @returns {string} text with numeric and named entities decoded.
 */
function decodeEntities(text) {
	const NAMED = {
		amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
		mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019",
		lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", middot: "\u00b7",
		copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
		times: "\u00d7", divide: "\u00f7", laquo: "\u00ab", raquo: "\u00bb",
		eacute: "\u00e9", egrave: "\u00e8", uuml: "\u00fc", ouml: "\u00f6"
	};
	return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, body) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X"
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const key = body.toLowerCase();
		return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : match;
	});
}

/**
 * Decide whether a tag name looks like the article or like chrome around it.
 *
 * The score is a hint, not a verdict — it breaks ties between candidates whose
 * prose density is otherwise similar.
 *
 * @param {string} tag - the element's tag name, lower case.
 * @param {string} attrs - the element's attribute source.
 * @returns {number} a small positive score for content, negative for chrome.
 */
function nameScore(tag, attrs) {
	const haystack = `${tag} ${attrs}`.toLowerCase();
	let score = 0;
	if (tag === "article") score += 30;
	if (tag === "main") score += 20;
	// The trailing optional `s` matters: class names on real pages are plural
	// far more often than singular (`comments`, `links`, `related-articles`),
	// and a matcher that only accepts the singular would miss the most common
	// form of the very thing it exists to catch. The boundary guards are what
	// stop `contest` matching `content` and `adventure` matching `ad`.
	const hit = (hint) => new RegExp(`(^|[^a-z])${hint}s?([^a-z]|$)`, "u").test(haystack);
	for (const hint of CONTENT_HINTS) {
		if (hit(hint)) score += 8;
	}
	for (const hint of CHROME_HINTS) {
		if (hit(hint)) score -= 12;
	}
	if (hit("comment")) score -= 20;
	return score;
}

/**
 * Strip the elements that are never article text.
 *
 * @param {string} html - the document source.
 * @returns {string} the document with those elements removed wholesale.
 */
function stripChrome(html) {
	let out = String(html ?? "");
	for (const tag of STRIP_TAGS) {
		out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "giu"), " ");
		out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "giu"), " ");
	}
	out = out.replace(/<!--[\s\S]*?-->/gu, " ");
	return out;
}

/**
 * Drop every tag, keeping the text and inserting line breaks at block edges.
 *
 * This is deliberately not a full HTML parser. It is the "give me the words"
 * pass, and the extractor's job is to feed it a *subtree* that already excludes
 * the chrome — which is why the subtree selection happens first.
 *
 * @param {string} html - a fragment of markup.
 * @returns {string} plain text with block boundaries preserved as newlines.
 */
function htmlToText(html) {
	let out = String(html ?? "");
	out = out.replace(/<br\b[^>]*\/?>/giu, "\n");
	out = out.replace(/<hr\b[^>]*\/?>/giu, "\n");
	out = out.replace(/<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption|address)>/giu, "\n\n");
	out = out.replace(/<li\b[^>]*>/giu, "\n- ");
	out = out.replace(/<[^>]+>/gu, "");
	return decodeEntities(out);
}

/**
 * Convert a fragment of markup to Markdown, keeping only the structures a
 * reader would miss: headings, lists, links, emphasis and code.
 *
 * @param {string} html - a fragment of markup.
 * @returns {string} Markdown.
 */
function htmlToMarkdown(html) {
	let out = String(html ?? "");
	out = out.replace(/<!--[\s\S]*?-->/gu, "");
	out = out.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, " ");

	// Images and links before the generic tag sweep, so their attributes are
	// still readable. A link with no text keeps its href; a decorative image
	// with an empty alt is dropped rather than left as a bare `![]()`.
	out = out.replace(/<img\b([^>]*)\/?>/giu, (match, attrs) => {
		const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
		const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
		const altText = (alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? "").trim();
		const srcUrl = (src?.[2] ?? src?.[3] ?? src?.[4] ?? "").trim();
		if (srcUrl === "") return altText;
		return `![${decodeEntities(altText)}](${srcUrl})`;
	});
	// -- inline emphasis, in one place, so the link branch can reuse it ---------
	//
	// The link branch has to run *before* the emphasis passes (while the `href`
	// attribute is still readable), but a link's *content* can itself be
	// emphasised: `<a href><strong>label</strong></a>`. Flattening the inner
	// markup with `htmlToText` there would silently drop that emphasis, which
	// is how a scraper turns a bolded warning into ordinary text. So the
	// converter below is applied to the anchor's inner markup, and the same
	// function backs the document-level passes.
	const inlineEmphasis = (fragment) => String(fragment ?? "")
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/giu, (match, tag, inner) => `**${collapseWhitespace(htmlToText(inner))}**`)
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/giu, (match, tag, inner) => `*${collapseWhitespace(htmlToText(inner))}*`)
		.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/giu, (match, inner) => `~~${collapseWhitespace(htmlToText(inner))}~~`);

	out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu, (match, attrs, inner) => {
		const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attrs);
		const url = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
		// Keep the emphasis the label carries; collapse whatever is left.
		const label = collapseWhitespace(inlineEmphasis(inner));
		if (url === "" || url.startsWith("javascript:")) return label;
		// A label-less link must not be written as `<url>`: the generic tag
		// sweep at the end of this function cannot tell that apart from a real
		// closing tag and would delete the whole thing. The `[](url)` form is
		// unambiguous Markdown and survives the sweep.
		return `[${label}](${url})`;
	});

	// Code before emphasis: a `<code>` inside a `<strong>` must not have its
	// backticks wrapped in asterisks that the reader cannot distinguish.
	out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (match, inner) => {
		const text = decodeEntities(htmlToText(inner)).replace(/\n+$/u, "");
		return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
	});
	out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, (match, inner) => {
		const text = collapseWhitespace(decodeEntities(htmlToText(inner)));
		if (text === "") return "";
		// Widening the fence is not optional: a run of backticks inside the
		// span would otherwise close the span early and leak the rest as prose.
		const longest = (text.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
		const fence = "`".repeat(longest + 1);
		const pad = /^`|`$/u.test(text) ? " " : "";
		return `${fence}${pad}${text}${pad}${fence}`;
	});

	out = inlineEmphasis(out);

	for (const [tag, prefix] of Object.entries(HEADING_PREFIX)) {
		out = out.replace(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "giu"), (match, inner) => {
			const text = collapseWhitespace(htmlToText(inner));
			return text === "" ? "" : `\n\n${prefix}${text}\n\n`;
		});
	}
	out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (match, inner) => {
		const text = collapseWhitespace(htmlToText(inner));
		if (text === "") return "";
		return `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
	});
	out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (match, inner) => {
		const text = collapseWhitespace(htmlToText(inner));
		return text === "" ? "" : `\n- ${text}`;
	});
	out = out.replace(/<\/?(ul|ol)\b[^>]*>/giu, "\n");
	out = out.replace(/<hr\b[^>]*\/?>/giu, "\n\n---\n\n");
	out = out.replace(/<br\b[^>]*\/?>/giu, "\n");
	out = out.replace(/<\/(p|div|section|article|main|h[1-6]|tr|figure|figcaption|address)>/giu, "\n\n");
	out = out.replace(/<[^>]+>/gu, "");

	return decodeEntities(out);
}

/* --------------------------------------------------------------- extractor */

/**
 * Find the direct children of a container, pairing each opening tag with its
 * own closing tag.
 *
 * A regex cannot do this: `<div><div></div></div>` needs a counter, and a
 * non-greedy match would stop at the first inner close.
 *
 * @param {string} html - the container's inner markup.
 * @param {string} tag - the child tag to collect.
 * @returns {Array<{attrs: string, inner: string}>} the children, in order.
 */
function childElements(html, tag) {
	const children = [];
	const open = new RegExp(`<${tag}\\b([^>]*)>`, "giu");
	const anyTag = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/giu;
	let match;
	while ((match = open.exec(html)) !== null) {
		const attrs = match[1] ?? "";
		const start = match.index + match[0].length;
		let depth = 1;
		let end = html.length;
		anyTag.lastIndex = start;
		let inner;
		while ((inner = anyTag.exec(html)) !== null) {
			if (inner[3] === "/") continue;
			if ((inner[2] ?? "").toLowerCase() !== tag) continue;
			depth += inner[1] === "/" ? -1 : 1;
			if (depth === 0) {
				end = inner.index;
				open.lastIndex = inner.index + inner[0].length;
				break;
			}
		}
		if (depth === 0) children.push({ attrs, inner: html.slice(start, end) });
	}
	return children;
}

/**
 * Score a fragment by how much of it reads as prose rather than as markup.
 *
 * The score is deliberately **density**, not volume. A candidate is judged per
 * character of its own text, so a container does not win merely by containing
 * more of the document than its child does.
 *
 * That distinction is the whole reason this function exists. A total score
 * makes the comparison unwinnable for the child: the `<body>` of any page
 * contains every other candidate, so "most total prose" always returns the
 * outermost element — including the nav bar and the footer, which is exactly
 * what an extractor is supposed to remove. Density inverted the comparison the
 * right way round: the container holds its best child *plus chrome*, so it is
 * strictly less dense, and it loses.
 *
 * The three terms:
 *   - prose ratio   — the fraction of the text that is not inside a link. A
 *                     200-link sitemap is long and still not prose.
 *   - paragraph     — prose comes in paragraphs; a link farm does not.
 *   - punctuation   — sentences are punctuated. This is a small tiebreaker,
 *                     capped so that one enormous page cannot swamp the ratio.
 *
 * @param {string} html - the candidate subtree.
 * @param {number} [bonus] - an extra score from the element's names.
 * @returns {{score: number, textLength: number, linkDensity: number}} the verdict.
 */
function scoreFragment(html, bonus = 0) {
	const text = collapseWhitespace(htmlToText(html));
	const textLength = text.length;
	if (textLength === 0) return { score: 0, textLength: 0, linkDensity: 0 };

	const linkText = collapseWhitespace((html.match(/<a\b[^>]*>[\s\S]*?<\/a>/giu) ?? [])
		.map((anchor) => htmlToText(anchor)).join(" "));
	const linkDensity = Math.min(linkText.length / textLength, 1);
	const paragraphs = (html.match(/<p\b[^>]*>/giu) ?? []).length;
	const paragraphDensity = Math.min(paragraphs / (textLength / 200), 1);
	const commas = (text.match(/[,;:\u3001\uff0c\uff1b\uff1a]/gu) ?? []).length;
	const punctuationDensity = Math.min(commas / (textLength / 60), 1);

	const density = (1 - linkDensity) * 0.7 + paragraphDensity * 0.2 + punctuationDensity * 0.1;
	const score = density * 100 + bonus;
	return { score, textLength, linkDensity };
}

/**
 * Pick the subtree of the document that is most likely the article.
 *
 * Candidates are the content-bearing containers (`article`, `main`, and any
 * `div`/`section`), scored by prose density with a name-based tie-breaker. When
 * the winner is a bare `div` with no content hint, the parent is preferred —
 * that is usually where the title lives, next to the body.
 *
 * @param {string} html - the document, already stripped of chrome.
 * @returns {{html: string, selector: string, score: number}} the best subtree.
 */
function pickContentRoot(html) {
	const candidates = [
		{ tag: "article", attrs: "", inner: null },
		{ tag: "main", attrs: "", inner: null },
		{ tag: "div", attrs: "", inner: null },
		{ tag: "section", attrs: "", inner: null }
	];

	let best = { html, selector: "body", score: scoreFragment(html).score };
	for (const { tag } of candidates) {
		for (const child of childElements(html, tag)) {
			const { score } = scoreFragment(child.inner, nameScore(tag, child.attrs));
			if (score > best.score) {
				best = { html: child.inner, selector: `${tag}${child.attrs ? "[…]" : ""}`, score };
			}
		}
	}
	return best;
}

/**
 * Turn a document into readable content.
 *
 * The order matters: remove the chrome first, so the scorer never sees the nav
 * bar; then pick the heaviest prose subtree, and only then flatten it. Doing
 * the flatten first would destroy the structure the scorer needs.
 *
 * @param {string} html - the raw document.
 * @param {object} [options] - extraction options.
 * @param {string} [options.format] - `"text"` or `"markdown"`.
 * @param {boolean} [options.keepLinks] - keep link markup in Markdown output.
 * @param {number} [options.maxChars] - truncate the result to this many characters.
 * @returns {{content: string, selector: string, score: number, truncated: boolean, title: string}} the extraction.
 */
function extractContent(html, options = {}) {
	const format = options.format === "markdown" ? "markdown" : "text";
	const keepLinks = options.keepLinks !== false;
	const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.trunc(options.maxChars) : 0;

	const title = extractTitle(html);
	const stripped = stripChrome(html);
	const picked = pickContentRoot(stripped);

	let content = format === "markdown" ? htmlToMarkdown(picked.html) : htmlToText(picked.html);
	if (format === "markdown" && !keepLinks) {
		content = content.replace(/\[([^\]]*)\]\(([^)]*)\)/gu, "$1");
	}
	content = collapseWhitespace(content);
	if (format === "markdown") {
		// Collapsing whitespace must not eat the blank line that separates two
		// Markdown blocks, or headings stop being headings.
		content = content.replace(/\n{3,}/gu, "\n\n");
	}

	let truncated = false;
	if (maxChars > 0 && content.length > maxChars) {
		content = content.slice(0, maxChars);
		truncated = true;
	}
	return { content, selector: picked.selector, score: picked.score, truncated, title };
}

/**
 * Read the document title.
 *
 * @param {string} html - the document.
 * @returns {string} the title, or an empty string.
 */
function extractTitle(html) {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(String(html ?? ""));
	if (match === null) {
		const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/iu.exec(String(html ?? ""));
		return og === null ? "" : decodeEntities(og[1]).trim();
	}
	return collapseWhitespace(decodeEntities(match[1]));
}

/**
 * Read the document's meta description, if it has one.
 *
 * @param {string} html - the document.
 * @returns {string} the description, or an empty string.
 */
function extractDescription(html) {
	const source = String(html ?? "");
	const patterns = [
		/<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/iu,
		/<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/iu,
		/<meta\b[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["']/iu
	];
	for (const pattern of patterns) {
		const match = pattern.exec(source);
		if (match !== null) return collapseWhitespace(decodeEntities(match[1]));
	}
	return "";
}

/**
 * List the links on a page, resolved to absolute URLs and de-duplicated.
 *
 * @param {string} html - the document.
 * @param {string} baseUrl - the URL the document was fetched from.
 * @returns {Array<{text: string, url: string}>} the links.
 */
function extractLinks(html, baseUrl) {
	const out = [];
	const seen = new Set();
	const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
	let match;
	while ((match = pattern.exec(String(html ?? ""))) !== null) {
		const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(match[1]);
		const raw = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
		if (raw === "" || raw.startsWith("#") || raw.startsWith("javascript:")) continue;
		let absolute;
		try {
			absolute = new URL(raw, baseUrl || "http://localhost/").href;
		} catch {
			continue;
		}
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		out.push({ text: collapseWhitespace(htmlToText(match[2])), url: absolute });
	}
	return out;
}

/* ------------------------------------------------------------ wait strategy */

/**
 * Resolve which wait to use, and explain the choice.
 *
 * The precedence is deliberate: an explicit selector beats everything, because
 * a caller who names an element is saying "the content is not there yet". Only
 * when nothing is named does the configured default apply.
 *
 * @param {object} args - tool arguments.
 * @param {string} fallback - the configured default strategy.
 * @returns {{strategy: string, target: string|null}} the resolved wait.
 */
function resolveWait(args, fallback) {
	const selector = typeof args.waitForSelector === "string" ? args.waitForSelector.trim() : "";
	if (selector !== "") return { strategy: "selector", target: selector };
	const requested = typeof args.waitStrategy === "string" ? args.waitStrategy.trim() : "";
	if (requested !== "") {
		if (!WAIT_STRATEGIES.includes(requested)) {
			throw new Error(`browser: waitStrategy must be one of ${WAIT_STRATEGIES.join(", ")} — got "${requested}".`);
		}
		return { strategy: requested, target: null };
	}
	if (!WAIT_STRATEGIES.includes(fallback)) {
		throw new Error(`browser: the configured waitStrategy "${fallback}" is not one of ${WAIT_STRATEGIES.join(", ")}.`);
	}
	return { strategy: fallback, target: null };
}

/* --------------------------------------------------------------- network */

/**
 * Fetch a URL and return its body, following redirects and reporting the
 * final URL.
 *
 * @param {string} url - the absolute URL.
 * @param {object} options - request options.
 * @param {number} options.timeoutMs - the timeout.
 * @param {string} [options.userAgent] - an override user agent.
 * @param {AbortSignal} [options.signal] - a cancellation signal.
 * @param {Function} [options.fetchImpl] - an injectable fetch, for tests.
 * @returns {Promise<{html: string, finalUrl: string, status: number, contentType: string, bytes: number}>} the response.
 */
async function staticFetch(url, options) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new Error("browser: no fetch implementation is available in this runtime.");
	}
	const headers = { "user-agent": options.userAgent || "Mozilla/5.0 (compatible; dsh-tool-browser/1.0)" };
	const response = await fetchImpl(url, { headers, redirect: "follow", signal: options.signal });
	const body = await response.text();
	// A `content-length` is the honest byte count only when nothing was
	// decompressed; measuring the string we actually hold is always right.
	const bytes = Buffer.byteLength(body, "utf8");
	if (!response.ok) {
		throw new Error(`browser: ${url} responded ${response.status} ${response.statusText || ""}`.trim());
	}
	return {
		html: body,
		finalUrl: response.url || url,
		status: response.status,
		contentType: response.headers?.get?.("content-type") ?? "",
		bytes
	};
}

/**
 * Resolve Playwright, if it is installed.
 *
 * The import is dynamic and wrapped, because `require("playwright")` throwing
 * is the normal case on a machine that only wants the static path. A missing
 * browser is a configuration fact, not an error.
 *
 * @param {object} [options] - resolution options.
 * @param {Function} [options.load] - an injectable loader, for tests.
 * @param {string} [options.module] - the module name to load.
 * @returns {Promise<object|null>} the module, or null when it is absent.
 */
async function loadPlaywright(options = {}) {
	const loader = options.load ?? ((specifier) => import(specifier));
	try {
		const loaded = await loader(options.module ?? "playwright");
		return loaded?.chromium !== undefined ? loaded : (loaded?.default?.chromium !== undefined ? loaded.default : null);
	} catch {
		return null;
	}
}

/**
 * Open a page with a real browser and return its rendered HTML.
 *
 * Every resource is released in a `finally`, so a navigation that times out
 * does not leave a browser process behind.
 *
 * @param {string} url - the URL to open.
 * @param {object} options - render options.
 * @param {object} options.playwright - the resolved Playwright module.
 * @param {object} options.wait - `{strategy, target}` from `resolveWait`.
 * @param {object} options.config - the resolved plugin config.
 * @param {AbortSignal} [options.signal] - a cancellation signal.
 * @returns {Promise<object>} the rendered page.
 */
async function renderWithBrowser(url, options) {
	const { playwright, wait, config } = options;
	const browser = await playwright.chromium.launch({ headless: config.headless });
	try {
		const context = await browser.newContext({
			viewport: { width: config.viewportWidth, height: config.viewportHeight },
			...(config.userAgent ? { userAgent: config.userAgent } : {})
		});
		try {
			const page = await context.newPage();
			const started = Date.now();
			const response = await page.goto(url, {
				waitUntil: wait.strategy === "selector" ? "domcontentloaded" : wait.strategy,
				timeout: config.navTimeoutMs
			});
			if (wait.strategy === "selector") {
				await page.waitForSelector(wait.target, { timeout: config.navTimeoutMs });
			}
			const html = await page.content();
			return {
				html,
				finalUrl: page.url(),
				status: response === null ? 0 : response.status(),
				waitedMs: Date.now() - started,
				title: await page.title()
			};
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

/* ---------------------------------------------------------------- helpers */

/**
 * Normalize a URL argument, rejecting the schemes a browser tool should not
 * touch.
 *
 * @param {unknown} value - the raw argument.
 * @returns {string} the normalized URL.
 */
function normalizeUrl(value) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text === "") throw new Error("browser: a `url` is required.");
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		throw new Error(`browser: "${text}" is not an absolute URL. Include the scheme, e.g. https://example.com/page.`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`browser: only http and https are supported — got "${parsed.protocol}".`);
	}
	return parsed.href;
}

/**
 * Truncate content to a character budget, marking that it happened.
 *
 * @param {string} content - the full content.
 * @param {number} maxChars - the budget, or 0 for unlimited.
 * @returns {{content: string, truncated: boolean}} the possibly-shortened content.
 */
function clamp(content, maxChars) {
	if (!Number.isFinite(maxChars) || maxChars <= 0 || content.length <= maxChars) {
		return { content, truncated: false };
	}
	return { content: content.slice(0, maxChars), truncated: true };
}

/**
 * Resolve an output filename against the configured directory, keeping it
 * inside that directory.
 *
 * `path.resolve(dir, name)` is not enough on its own: `resolve` honours an
 * absolute second argument, so `resolve("/out", "C:/Windows/evil.png")` returns
 * the Windows path and the write escapes the configured tree. The same is true
 * of `../../` traversal. Both are stripped down to the file name here, because
 * a caller naming an output file is choosing a *name*, not a location — the
 * location is the plugin's business, and it is always `outputDir`.
 *
 * A name that reduces to nothing usable falls back to a timestamp, so a caller
 * cannot turn a bad argument into an error quite that easily.
 *
 * @param {string} dir - the configured output directory.
 * @param {string} filename - the requested file name.
 * @returns {string} the absolute path to write, always under `dir`.
 */
function outputPath(dir, filename) {
	const raw = String(filename ?? "").trim();
	// Normalize separators first, so a Windows-style path is recognised on
	// every platform, then take the last segment — which discards a drive
	// letter, a leading slash, and any `../` in one step.
	const segments = raw.replace(/\\/gu, "/").split("/").filter((part) => part !== "" && part !== "." && part !== "..");
	const name = segments.length > 0 ? segments[segments.length - 1] : "";
	const safe = name.replace(/[<>:"|?*\u0000-\u001f]/gu, "_");
	return resolve(dir, safe === "" ? `out-${stamp()}` : safe);
}

/**
 * Today's timestamp as a filename-safe string.
 *
 * @returns {string} e.g. `2026-10-02T16-52-22`.
 */
function stamp() {
	return new Date().toISOString().replace(/\.\d+Z$/u, "").replace(/:/gu, "-");
}

/* ------------------------------------------------------------------ apply */

/**
 * Register the enabled browser tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	// Hoisted: the status tool closes over this, and reading it from `config`
	// inside every closure would let a later mutation change one tool's budget
	// and not another's.
	const timeoutMs = config.timeoutMs;
	const outputDir = resolve(config.workDir, config.outputDir);

	// The injectable seams live on one object the caller can reach, so a test can
	// swap the fetch, the Playwright loader, and the browser without the tools
	// ever reading a different copy.
	//
	// Every read below is a *live* read of a field on that shared object, taken
	// inside the call that needs it — never snapshotted into a local at apply
	// time. Snapshotting the field into a local here would capture `undefined` on
	// a context whose fields the caller fills in later, and the tool would then
	// reach the real network while a test believed it had installed a fake.
	const transport = ctx.transport ?? {};

	/**
	 * Produce rendered HTML, preferring the browser and falling back to a
	 * static fetch.
	 *
	 * The fallback is never silent: `engine` is reported back to the caller,
	 * because "the JavaScript never ran" changes what the extracted text means.
	 *
	 * @param {string} url - the URL.
	 * @param {object} args - tool arguments.
	 * @param {object} wait - the resolved wait.
	 * @param {AbortSignal} [signal] - a cancellation signal.
	 * @returns {Promise<object>} `{html, finalUrl, status, engine, engineNote, waitedMs}`.
	 */
	async function acquire(url, args, wait, signal) {
		const mode = typeof args.mode === "string" ? args.mode : "auto";
		if (!["auto", "browser", "static"].includes(mode)) {
			throw new Error(`browser: mode must be "auto", "browser" or "static" — got "${mode}".`);
		}
		if (mode === "static") {
			const result = await staticFetch(url, { timeoutMs, userAgent: config.userAgent, signal, fetchImpl: transport.fetchImpl });
			return { ...result, engine: "static", engineNote: "requested: static", waitedMs: 0 };
		}

		const playwright = transport.playwrightModule ?? await loadPlaywright({ load: transport.playwrightLoader });
		if (playwright === null) {
			if (config.requireBrowser || mode === "browser") {
				throw new Error(
					"browser: Playwright is not installed, and this call requires a real browser. " +
					"Install it with `npm install playwright` then `npx playwright install chromium`, " +
					"or run with mode \"static\" to accept a non-rendered fetch."
				);
			}
			const result = await staticFetch(url, { timeoutMs, userAgent: config.userAgent, signal, fetchImpl: transport.fetchImpl });
			return {
				...result,
				engine: "static",
				engineNote: "Playwright is not installed, so the page's JavaScript never ran; the content below is what the server returned.",
				waitedMs: 0
			};
		}

		try {
			const result = await renderWithBrowser(url, { playwright, wait, config });
			return { ...result, engine: "browser", engineNote: `waited for ${wait.strategy}${wait.target ? ` (${wait.target})` : ""}` };
		} catch (error) {
			if (mode === "browser") throw error;
			const result = await staticFetch(url, { timeoutMs, userAgent: config.userAgent, signal, fetchImpl: transport.fetchImpl });
			return {
				...result,
				engine: "static",
				engineNote: `the browser failed (${error?.message ?? error}); the content below is what the server returned without running JavaScript.`,
				waitedMs: 0
			};
		}
	}

	/* -- browser_status ---------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "browser_status",
			description: "Report whether a real browser is available, which wait strategies this plugin understands, and where its output goes. Check this before a scrape so an unrendered page is a known condition rather than a mystery.",
			parameters: {},
			output: {
				// `required` in this DSL is a boolean flag on each *property*
				// (`{ type: "string", required: true }`), not a top-level
				// `required: [...]` array. A nested object and an array's
				// `items` each forbid the array form outright, and the
				// framework throws while the plugin loads if one appears.
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						browser: { type: "boolean", required: true, description: "Whether Playwright with Chromium is usable." },
						engine: { type: "string", required: true, description: "The engine that will be used by default." },
						note: { type: "string", required: true, description: "A human-readable explanation of the browser state." },
						waitStrategies: { type: "array", required: true, items: { type: "string" }, description: "The accepted waitStrategy values." },
						operations: { type: "array", required: true, items: { type: "string" }, description: "The analysis tools this plugin registers." },
						directories: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								workDir: { type: "string", required: true },
								outputDir: { type: "string", required: true }
							}
						},
						defaults: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								waitStrategy: { type: "string", required: true },
								headless: { type: "boolean", required: true },
								viewport: { type: "string", required: true },
								navTimeoutMs: { type: "number", required: true },
								requireBrowser: { type: "boolean", required: true }
							}
						}
					}
				}
			},
			timeoutMs,
			isConcurrencySafe: () => true,
			async execute() {
				const playwright = transport.playwrightModule ?? await loadPlaywright({ load: transport.playwrightLoader });
				const available = playwright !== null;
				return {
					browser: available,
					engine: available ? "browser" : "static",
					note: available
						? "Playwright is available; pages will be rendered in a real Chromium unless mode is set to \"static\"."
						: "Playwright is not installed; pages will be fetched statically and their JavaScript will not run. Install it with `npm install playwright` then `npx playwright install chromium`.",
					waitStrategies: [...WAIT_STRATEGIES],
					operations: ["browser_fetch", "browser_extract", "browser_screenshot"],
					directories: { workDir: resolve(config.workDir), outputDir },
					defaults: {
						waitStrategy: config.waitStrategy,
						headless: config.headless,
						viewport: `${config.viewportWidth}x${config.viewportHeight}`,
						navTimeoutMs: config.navTimeoutMs,
						requireBrowser: config.requireBrowser
					}
				};
			}
		}));
	}

	/* -- browser_fetch ----------------------------------------------------- */
	if (config.fetchPage) {
		ctx.tools.register(defineTool({
			name: "browser_fetch",
			description: "Open a URL and return the page's HTML, optionally saving it to a file. Reports which engine produced it, so the caller can tell a rendered page from a static one. Use this when the raw markup matters; use browser_extract when the readable text does.",
			parameters: {
				url: { type: "string", description: "The absolute http(s) URL to open.", required: true },
				mode: { type: "string", description: "\"auto\" (browser, falling back to static), \"browser\" (require a real browser), or \"static\" (plain fetch)." },
				waitStrategy: { type: "string", description: "How to wait after navigating: domcontentloaded, load, networkidle, or selector (via waitForSelector)." },
				waitForSelector: { type: "string", description: "A CSS selector to wait for; implies waitStrategy=selector." },
				saveAs: { type: "string", description: "Write the HTML to this file name under outputDir." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						url: { type: "string", required: true, description: "The URL that was requested." },
						finalUrl: { type: "string", required: true, description: "The URL after redirects." },
						status: { type: "number", required: true, description: "The HTTP status, or 0 if unknown." },
						engine: { type: "string", required: true, description: "\"browser\" or \"static\"." },
						engineNote: { type: "string", required: true, description: "Why that engine was used." },
						waitedMs: { type: "number", required: true, description: "How long the wait took, in milliseconds." },
						title: { type: "string", required: true, description: "The document title." },
						bytes: { type: "number", required: true, description: "The size of the HTML, in bytes." },
						html: { type: "string", required: true, description: "The HTML, truncated if it is very large." },
						truncated: { type: "boolean", required: true, description: "Whether the HTML was truncated." },
						savedTo: { type: "string", description: "Where the HTML was saved, if it was." }
					}
				}
			},
			timeoutMs,
			isConcurrencySafe: (args) => args?.mode === "static",
			async execute(args, exec) {
				const url = normalizeUrl(args.url);
				const wait = resolveWait(args, config.waitStrategy);
				const result = await acquire(url, args, wait, exec.signal);

				const maxChars = Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.trunc(args.maxChars) : 200000;
				const { content, truncated } = clamp(result.html, maxChars);

				const out = {
					url,
					finalUrl: result.finalUrl,
					status: result.status,
					engine: result.engine,
					engineNote: result.engineNote,
					waitedMs: result.waitedMs,
					title: result.title ?? extractTitle(result.html),
					bytes: result.bytes ?? Buffer.byteLength(result.html, "utf8"),
					html: content,
					truncated
				};

				if (typeof args.saveAs === "string" && args.saveAs.trim() !== "") {
					await mkdir(outputDir, { recursive: true });
					const target = outputPath(outputDir, args.saveAs.trim());
					await writeFile(target, result.html, "utf8");
					out.savedTo = target;
				}
				return out;
			}
		}));
	}

	/* -- browser_extract --------------------------------------------------- */
	if (config.extract) {
		ctx.tools.register(defineTool({
			name: "browser_extract",
			description: "Open a URL and return just the readable part: the article text as plain text or Markdown, plus the title, description and links. Strips navigation, footers and comment sections by scoring prose density rather than trusting tag names.",
			parameters: {
				url: { type: "string", description: "The absolute http(s) URL to open.", required: true },
				format: { type: "string", description: "\"text\" (default) or \"markdown\"." },
				mode: { type: "string", description: "\"auto\" (browser, falling back to static), \"browser\", or \"static\"." },
				waitStrategy: { type: "string", description: "How to wait after navigating." },
				waitForSelector: { type: "string", description: "A CSS selector to wait for; implies waitStrategy=selector." },
				keepLinks: { type: "boolean", description: "In Markdown output, keep link syntax. Defaults to true." },
				includeLinks: { type: "boolean", description: "Also return the page's link list. Defaults to false." },
				maxChars: { type: "number", description: "Truncate the extracted content to this many characters." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						url: { type: "string", required: true },
						finalUrl: { type: "string", required: true },
						status: { type: "number", required: true },
						engine: { type: "string", required: true },
						engineNote: { type: "string", required: true },
						waitedMs: { type: "number", required: true },
						title: { type: "string", required: true },
						description: { type: "string", required: true },
						format: { type: "string", required: true },
						selector: { type: "string", required: true, description: "Which subtree the content was taken from." },
						score: { type: "number", required: true, description: "The winning prose-density score." },
						contentChars: { type: "number", required: true },
						truncated: { type: "boolean", required: true },
						content: { type: "string", required: true },
						// Array items forbid `required` outright — it is only a
						// property-level flag — so the link objects declare their
						// shape without it.
						links: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									text: { type: "string" },
									url: { type: "string" }
								}
							},
							description: "The page's links, when requested."
						}
					}
				}
			},
			timeoutMs,
			isConcurrencySafe: (args) => args?.mode === "static",
			async execute(args, exec) {
				const url = normalizeUrl(args.url);
				const wait = resolveWait(args, config.waitStrategy);
				const result = await acquire(url, args, wait, exec.signal);
				const format = args.format === "markdown" ? "markdown" : "text";

				const extracted = extractContent(result.html, {
					format,
					keepLinks: args.keepLinks !== false,
					maxChars: args.maxChars
				});

				const out = {
					url,
					finalUrl: result.finalUrl,
					status: result.status,
					engine: result.engine,
					engineNote: result.engineNote,
					waitedMs: result.waitedMs,
					title: result.title ?? extracted.title,
					description: extractDescription(result.html),
					format,
					selector: extracted.selector,
					score: extracted.score,
					contentChars: extracted.content.length,
					truncated: extracted.truncated,
					content: extracted.content
				};
				if (args.includeLinks === true) {
					out.links = extractLinks(result.html, result.finalUrl);
				}
				return out;
			}
		}));
	}

	/* -- browser_screenshot ------------------------------------------------ */
	if (config.screenshot) {
		ctx.tools.register(defineTool({
			name: "browser_screenshot",
			description: "Open a URL in a real browser and capture a PNG. Requires Playwright — there is no static fallback, because a screenshot of a page nobody rendered is a picture of an empty document.",
			parameters: {
				url: { type: "string", description: "The absolute http(s) URL to capture.", required: true },
				filename: { type: "string", description: "The output file name under outputDir. Defaults to a timestamped name." },
				fullPage: { type: "boolean", description: "Capture the whole scrollable page rather than just the viewport." },
				width: { type: "number", description: "Viewport width in CSS pixels." },
				height: { type: "number", description: "Viewport height in CSS pixels." },
				waitStrategy: { type: "string", description: "How to wait after navigating." },
				waitForSelector: { type: "string", description: "A CSS selector to wait for; implies waitStrategy=selector." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						url: { type: "string", required: true },
						finalUrl: { type: "string", required: true },
						status: { type: "number", required: true },
						engine: { type: "string", required: true },
						waitedMs: { type: "number", required: true },
						title: { type: "string", required: true },
						file: { type: "string", required: true, description: "The absolute path of the written PNG." },
						bytes: { type: "number", required: true },
						fullPage: { type: "boolean", required: true },
						viewport: { type: "string", required: true }
					}
				}
			},
			timeoutMs,
			isConcurrencySafe: () => false,
			async execute(args) {
				const url = normalizeUrl(args.url);
				const wait = resolveWait(args, config.waitStrategy);
				const playwright = transport.playwrightModule ?? await loadPlaywright({ load: transport.playwrightLoader });
				if (playwright === null) {
					throw new Error(
						"browser: browser_screenshot needs Playwright, which is not installed. " +
						"Install it with `npm install playwright` then `npx playwright install chromium`. " +
						"There is no static fallback for a screenshot."
					);
				}

				const width = Number.isFinite(args.width) && args.width > 0 ? Math.trunc(args.width) : config.viewportWidth;
				const height = Number.isFinite(args.height) && args.height > 0 ? Math.trunc(args.height) : config.viewportHeight;
				const fullPage = args.fullPage === true;

				const browser = await playwright.chromium.launch({ headless: config.headless });
				try {
					const context = await browser.newContext({
						viewport: { width, height },
						...(config.userAgent ? { userAgent: config.userAgent } : {})
					});
					try {
						const page = await context.newPage();
						const started = Date.now();
						const response = await page.goto(url, {
							waitUntil: wait.strategy === "selector" ? "domcontentloaded" : wait.strategy,
							timeout: config.navTimeoutMs
						});
						if (wait.strategy === "selector") {
							await page.waitForSelector(wait.target, { timeout: config.navTimeoutMs });
						}
						const buffer = await page.screenshot({ fullPage, type: "png" });
						await mkdir(outputDir, { recursive: true });
						const requested = typeof args.filename === "string" && args.filename.trim() !== ""
							? args.filename.trim()
							: `shot-${stamp()}.png`;
						const file = outputPath(outputDir, extname(requested) === "" ? `${requested}.png` : requested);
						await writeFile(file, buffer);
						return {
							url,
							finalUrl: page.url(),
							status: response === null ? 0 : response.status(),
							engine: "browser",
							waitedMs: Date.now() - started,
							title: await page.title(),
							file,
							bytes: buffer.length,
							fullPage,
							viewport: `${width}x${height}`
						};
					} finally {
						await context.close();
					}
				} finally {
					await browser.close();
				}
			}
		}));
	}
}

export { Config, apply, inject, name };
export {
	WAIT_STRATEGIES,
	STRIP_TAGS,
	CONTENT_HINTS,
	CHROME_HINTS,
	HEADING_PREFIX,
	collapseWhitespace,
	decodeEntities,
	nameScore,
	stripChrome,
	htmlToText,
	htmlToMarkdown,
	childElements,
	scoreFragment,
	pickContentRoot,
	extractContent,
	extractTitle,
	extractDescription,
	extractLinks,
	resolveWait,
	normalizeUrl,
	clamp,
	outputPath,
	staticFetch,
	loadPlaywright,
	renderWithBrowser
};