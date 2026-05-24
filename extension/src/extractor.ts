/**
 * tab-reader content-script extractor.
 *
 * Bundled by esbuild into ../dist/extractor.js (IIFE for chrome116+).
 * Injected by the extension's service worker via chrome.scripting.executeScript
 * with world="ISOLATED". On load it assigns window.__tabReader = { extract }
 * so a second executeScript with `func:` can call it and return the result.
 *
 * Uses the shared pipeline from ../../server/src/pipeline.ts — the same
 * JUNK_SELECTORS, normalizeDom, pickContentRoot, and Turndown configuration
 * the server uses for its fallback path. Single source of truth.
 *
 * When includeImages=true: tag qualifying images in the live DOM, clone, run
 * the pipeline on the clone (drops junk zones), then walk the clone and emit
 * an interleaved sequence of text and image content blocks. Section alignment
 * is encoded purely by position — each image block appears in the response
 * right after the text of its section.
 */

import TurndownService from "turndown";
import {
  applyJunkSelectors,
  makeTurndown,
  normalizeDom,
  pickContentRoot,
} from "../../server/src/pipeline";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ExtractResult {
  rootKind: string;
  /** Live page URL at the moment extraction ran — may differ from the server's last-known URL if the user switched tabs mid-flight. */
  url: string;
  /** Live page title at the moment extraction ran. */
  title: string;
  content: ContentBlock[];
}

// Hard limits — decided in the content script so the SW never holds oversized
// blobs. Excess images become inline placeholder text so section alignment is
// preserved even when we couldn't fetch the bytes.
const MAX_IMAGES = 20;
const MAX_BYTES_PER_IMAGE = 2 * 1024 * 1024;
const MIN_RENDERED_SIDE = 100;

const turndown = makeTurndown();

function cleanMarkdown(raw: string): string {
  return raw
    .trim()
    .replace(/​/g, "") // zero-width space
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function snapshotDocument(): Document {
  const cloned = document.implementation.createHTMLDocument(document.title);
  cloned.documentElement.innerHTML = document.documentElement.innerHTML;
  return cloned;
}

function qualifiesByLayout(img: HTMLImageElement): boolean {
  const rect = img.getBoundingClientRect();
  if (rect.width < MIN_RENDERED_SIDE || rect.height < MIN_RENDERED_SIDE) {
    return false;
  }
  const style = window.getComputedStyle(img);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  return true;
}

function imageUrlFor(img: HTMLImageElement): string {
  return img.currentSrc || img.src || img.dataset.src || "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Ask the service worker to fetch this URL from extension context.
 * Bypasses page-context CORS at the cost of losing the user's cookies — so
 * we use this only as a fallback when in-page fetch fails.
 */
function swFetchImage(url: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "fetchImage", url, maxBytes: MAX_BYTES_PER_IMAGE },
      (resp: { ok: boolean; data?: string; mimeType?: string; error?: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp && resp.ok && resp.data) {
          resolve({ data: resp.data, mimeType: resp.mimeType || "image/png" });
        } else {
          reject(new Error(resp?.error || "SW fetch failed"));
        }
      },
    );
  });
}

async function fetchImageBytes(
  img: HTMLImageElement,
): Promise<{ data: string; mimeType: string }> {
  const url = imageUrlFor(img);
  if (!url) throw new Error("no resolvable image URL");

  // Page-context fetch first: carries user cookies, hits the browser cache
  // (the image was already loaded to render the page), and works for same-
  // origin + CORS-permissive cross-origin images.
  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size > MAX_BYTES_PER_IMAGE) {
      throw new Error(`image exceeds ${MAX_BYTES_PER_IMAGE} bytes (${blob.size})`);
    }
    const data = await blobToBase64(blob);
    return { data, mimeType: blob.type || "image/png" };
  } catch (pageErr) {
    // CORS-blocked or network error — fall through to SW fetch.
    void pageErr;
  }

  return swFetchImage(url);
}

interface ImageResolution {
  id: string;
  block: ContentBlock; // either {type:"image", ...} or a placeholder text block
}

async function resolveImage(id: string, liveImg: HTMLImageElement): Promise<ImageResolution> {
  try {
    const { data, mimeType } = await fetchImageBytes(liveImg);
    return { id, block: { type: "image", data, mimeType } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const alt = (liveImg.getAttribute("alt") || "").trim();
    const url = imageUrlFor(liveImg);
    return {
      id,
      block: {
        type: "text",
        text: `[image omitted (${reason})${alt ? `: ${alt}` : ""}${url ? ` — ${url}` : ""}]`,
      },
    };
  }
}

/**
 * Turndown configured with marker rules for tagged images. When it hits an
 * <img data-tr-id="N">, it emits `\n\n[[TR_IMAGE_N]]\n\n` instead of the
 * normal img tag. We split the final Markdown on these markers to interleave
 * the actual image content blocks.
 */
function makeTurndownWithMarkers(): TurndownService {
  const td = makeTurndown();
  td.addRule("tr-image-marker", {
    filter: (node) => {
      if (node.nodeName !== "IMG") return false;
      const id = (node as Element).getAttribute?.("data-tr-id");
      return !!id;
    },
    replacement: (_content, node) => {
      const id = (node as Element).getAttribute?.("data-tr-id") ?? "";
      return `\n\n[[TR_IMAGE_${id}]]\n\n`;
    },
  });
  td.addRule("tr-image-skip", {
    filter: (node) => {
      if (node.nodeName !== "IMG") return false;
      const skip = (node as Element).getAttribute?.("data-tr-skip");
      return !!skip;
    },
    replacement: (_c, node) => {
      const reason = (node as Element).getAttribute?.("data-tr-skip") || "skipped";
      return `\n\n[[TR_IMAGE_PLACEHOLDER:${reason}]]\n\n`;
    },
  });
  return td;
}

function extractTextOnly(): ExtractResult {
  const cloned = snapshotDocument();
  applyJunkSelectors(cloned);
  normalizeDom(cloned);
  const { root, kind } = pickContentRoot(cloned);
  const md = cleanMarkdown(turndown.turndown(root.innerHTML));
  return {
    rootKind: kind,
    url: location.href,
    title: document.title,
    content: [{ type: "text", text: md }],
  };
}

async function extractWithImages(): Promise<ExtractResult> {
  // Step 1: tag qualifying images in the LIVE DOM. We need the live DOM for
  // getBoundingClientRect (the clone has no layout). data-tr-id is removed
  // from the live DOM as soon as the clone is taken — the mutation is
  // invisible to the user.
  const allImgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
  const liveById = new Map<string, HTMLImageElement>();
  let counter = 0;
  for (const img of allImgs) {
    if (!qualifiesByLayout(img)) continue;
    const id = String(counter++);
    img.setAttribute("data-tr-id", id);
    liveById.set(id, img);
  }

  let cloned: Document;
  try {
    cloned = snapshotDocument();
  } finally {
    for (const img of liveById.values()) {
      img.removeAttribute("data-tr-id");
    }
  }

  // Step 2: apply the shared pipeline to the clone. Junk-zone images get
  // removed here (the data-tr-id tag goes with them).
  applyJunkSelectors(cloned);
  normalizeDom(cloned);
  const { root, kind } = pickContentRoot(cloned);

  // Step 3: enforce MAX_IMAGES on the survivors, in document order. Excess
  // ones get swapped for skip markers so their position is still represented
  // in the output.
  const survivedClonedImgs = Array.from(
    root.querySelectorAll("img[data-tr-id]"),
  ) as HTMLImageElement[];
  const includedIds: string[] = [];
  for (let i = 0; i < survivedClonedImgs.length; i++) {
    const el = survivedClonedImgs[i];
    const id = el.getAttribute("data-tr-id");
    if (!id) continue;
    if (i < MAX_IMAGES) {
      includedIds.push(id);
    } else {
      el.setAttribute("data-tr-skip", `exceeded ${MAX_IMAGES}-image limit`);
      el.removeAttribute("data-tr-id");
    }
  }

  // Step 4: fetch image bytes in parallel. Failed fetches become inline
  // placeholder text blocks so section alignment is preserved.
  const resolutions = await Promise.all(
    includedIds.map((id) => {
      const liveImg = liveById.get(id);
      if (!liveImg) {
        return Promise.resolve<ImageResolution>({
          id,
          block: { type: "text", text: `[image omitted: live element missing]` },
        });
      }
      return resolveImage(id, liveImg);
    }),
  );
  const blockById = new Map<string, ContentBlock>();
  for (const r of resolutions) blockById.set(r.id, r.block);

  // Step 5: run Turndown on the clone's content root with the marker rules.
  const tdWithMarkers = makeTurndownWithMarkers();
  const rawMd = tdWithMarkers.turndown(root.innerHTML);
  const cleaned = cleanMarkdown(rawMd);

  // Step 6: split the Markdown on markers and interleave with image blocks.
  // Pattern matches:
  //   [[TR_IMAGE_<id>]]                — a real image at that position
  //   [[TR_IMAGE_PLACEHOLDER:<reason>]] — an over-cap image as text
  const markerPattern = /\[\[TR_IMAGE_(?:PLACEHOLDER:([^\]]*)|([^\]]+))\]\]/g;
  const content: ContentBlock[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(cleaned)) !== null) {
    const before = cleaned.slice(lastIdx, match.index).trim();
    if (before) content.push({ type: "text", text: before });
    if (match[1]) {
      // placeholder marker (over-cap)
      content.push({
        type: "text",
        text: `[image omitted: ${match[1]}]`,
      });
    } else if (match[2]) {
      const id = match[2];
      const block = blockById.get(id);
      if (block) {
        content.push(block);
      } else {
        content.push({
          type: "text",
          text: `[image omitted: no data for id ${id}]`,
        });
      }
    }
    lastIdx = match.index + match[0].length;
  }
  const tail = cleaned.slice(lastIdx).trim();
  if (tail) content.push({ type: "text", text: tail });

  // Empty-images case: if zero markers matched, fall back to single text block
  if (content.length === 0) {
    content.push({ type: "text", text: cleaned });
  }

  return {
    rootKind: kind,
    url: location.href,
    title: document.title,
    content,
  };
}

async function extract(opts: { includeImages: boolean }): Promise<ExtractResult> {
  if (opts.includeImages) {
    return extractWithImages();
  }
  return extractTextOnly();
}

(window as unknown as { __tabReader: { extract: typeof extract } }).__tabReader = { extract };
