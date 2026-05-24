/**
 * Extraction pipeline — single source of truth for both:
 *   - the Node MCP server (consumes via plain TS import, runs against jsdom Documents)
 *   - the Chrome extension content script (bundled via esbuild, runs against the live DOM)
 *
 * Everything here is generic over `Document` from the DOM lib so it works in both
 * environments. Do NOT import jsdom, ws, or any Node-only module here — that
 * would prevent the extension from bundling this file.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
/**
 * Selectors for elements that are almost always noise.
 * Kept conservative — we want to keep all real content.
 */
export const JUNK_SELECTORS = [
    // standard noise
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "link",
    "meta",
    // site chrome
    "nav",
    "header > nav",
    "footer",
    "aside",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='complementary']",
    "[aria-hidden='true']",
    ".sidebar",
    ".toc",
    ".table-of-contents",
    ".breadcrumb",
    ".skip-link",
    ".cookie-banner",
    ".newsletter",
    "[class*='advertisement']",
    "[class*='social-share']",
    // heading permalinks (Mintlify, Docusaurus, etc.)
    "a.header-anchor",
    "a[href^='#'][aria-label*='ermalink']",
    // Mintlify step number badges / rails (rendered icons, no text content)
    "[data-component-part='step-number']",
    "[data-component-part='step-rail']",
    "[data-component-part='step-marker']",
];
/** Strip noise selectors from the document in-place. */
export function applyJunkSelectors(doc) {
    for (const sel of JUNK_SELECTORS) {
        doc.querySelectorAll(sel).forEach((n) => n.remove());
    }
}
/**
 * Site-specific normalizations applied to the DOM before conversion.
 * Each is small and targeted; they never remove content that could be
 * meaningful, only restructure or strip noise.
 */
export function normalizeDom(doc) {
    // Mintlify renders <Step title="Foo"> as a nested div tree where the title
    // ends up in a <p data-component-part="step-title">. Promote those to <h4>
    // so they survive as Markdown headings.
    doc.querySelectorAll('[data-component-part="step-title"]').forEach((el) => {
        const h = doc.createElement("h4");
        h.textContent = el.textContent ?? "";
        el.replaceWith(h);
    });
    // Many doc sites (Mintlify, Docusaurus, MkDocs) wrap heading text in
    // permalink <a> tags. Turndown then renders the heading as several lines
    // of brackets and arrows. Replace each heading's content with plain text.
    for (let level = 1; level <= 6; level++) {
        doc.querySelectorAll(`h${level}`).forEach((h) => {
            const text = (h.textContent ?? "")
                .replace(/\s+/g, " ")
                .replace(/​/g, "") // zero-width space
                .trim();
            h.textContent = text;
        });
    }
    // Some Mintlify pages use <span data-as="p"> instead of <p>. Convert so
    // Markdown sees them as proper paragraphs.
    doc.querySelectorAll('span[data-as="p"]').forEach((el) => {
        const p = doc.createElement("p");
        p.innerHTML = el.innerHTML;
        el.replaceWith(p);
    });
}
/**
 * Pick the main content root, in priority order:
 *   <main> → <article> → [role='main'] → #content / .content → <body>
 * Always returns a root (falls back to body).
 */
export function pickContentRoot(doc) {
    const main = doc.querySelector("main");
    if (main)
        return { root: main, kind: "main" };
    const article = doc.querySelector("article");
    if (article)
        return { root: article, kind: "article" };
    const roleMain = doc.querySelector("[role='main']");
    if (roleMain)
        return { root: roleMain, kind: "role-main" };
    const idContent = doc.querySelector("#content") ?? doc.querySelector(".content");
    if (idContent)
        return { root: idContent, kind: "id-content" };
    return { root: doc.body, kind: "body" };
}
/**
 * Configure Turndown to produce high-fidelity Markdown:
 *   - ATX-style headings (#, ##, ###)
 *   - Fenced code blocks with language hints when available
 *   - GFM tables, strikethrough, task lists
 *   - Inline-style links
 *   - Clean <img> tags with just src + alt (drop srcset/sizes/data-* noise)
 */
export function makeTurndown() {
    const td = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        fence: "```",
        bulletListMarker: "*",
        emDelimiter: "*",
        strongDelimiter: "**",
        linkStyle: "inlined",
    });
    td.use(gfm);
    // Drop noise tags. Using a filter function rather than .remove(["svg",...])
    // because some tag names aren't in TS's HTMLElementTagNameMap.
    const dropTags = new Set([
        "SCRIPT",
        "STYLE",
        "NOSCRIPT",
        "IFRAME",
        "SVG",
        "LINK",
        "META",
    ]);
    td.addRule("drop-noise", {
        filter: (node) => dropTags.has(node.nodeName),
        replacement: () => "",
    });
    // <img>: emit a clean inline tag with just essential attributes.
    td.addRule("clean-img", {
        filter: "img",
        replacement: (_content, node) => {
            const el = node;
            const src = el.getAttribute("src") ?? "";
            if (!src)
                return "";
            const alt = (el.getAttribute("alt") ?? "").replace(/"/g, "&quot;");
            const w = el.getAttribute("width");
            const h = el.getAttribute("height");
            const dims = w && h ? ` width="${w}" height="${h}"` : "";
            return `<img src="${src}" alt="${alt}"${dims}>`;
        },
    });
    // <pre><code class="language-foo">...</code></pre> → fenced block with lang.
    td.addRule("fenced-code-with-lang", {
        filter: (node) => {
            if (node.nodeName !== "PRE")
                return false;
            const first = node.firstChild;
            return !!first && first.nodeName === "CODE";
        },
        replacement: (_content, node) => {
            const codeEl = node.firstChild;
            const className = codeEl.getAttribute?.("class") ?? "";
            const langMatch = /language-([^\s]+)/.exec(className);
            const lang = langMatch ? langMatch[1] : "";
            const text = codeEl.textContent ?? "";
            const body = text.replace(/\n$/, "");
            return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
        },
    });
    return td;
}
