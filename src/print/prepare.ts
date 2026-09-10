// Printing a markdown document: render it with the preview pipeline and make
// the result self-contained, because a print window has no access to the app's
// local-file IPC and (unlike the preview) no chance to fix images up later.

import { renderMarkdown } from "../preview/render";
import { renderMermaidIn } from "../preview/mermaid";
import { materializeImages } from "../preview/fixup";

/** Off-screen host style: rendered (so mermaid can measure text) but invisible
 * and click-through; the host is removed again before this function returns. */
const HOST_STYLE = [
  "position: absolute",
  "left: -100000px",
  "top: 0",
  "width: 900px",
  "opacity: 0",
  "pointer-events: none",
  "z-index: -1",
].join("; ");

/**
 * Restores the fenced source of diagrams that were not replaced by an inline
 * `<svg>` (mermaid unavailable or the diagram failed), so printing degrades to
 * the code block instead of an error line or an empty gap.
 */
function restoreUnrenderedMermaid(sources: Map<HTMLElement, string>): void {
  for (const [node, source] of sources) {
    if (node.querySelector("svg")) continue;
    if (node.textContent !== source) node.textContent = source;
  }
}

/**
 * Renders markdown and inlines local images so the result is printable.
 * Reuses the preview pipeline (`preview/render.ts`: html:false, highlight.js,
 * KaTeX, mermaid fences) and renders mermaid diagrams to inline SVG when the
 * mermaid helper can run (it needs a DOM); failures fall back to the fenced
 * code block. Returns an HTML fragment body for the print document - the caller
 * wraps it with `buildPrintCss()` and the document title.
 */
export async function prepareMarkdownPrint(source: string, docPath: string | null): Promise<string> {
  const html = renderMarkdown(source);
  // Without a DOM (unit tests, non-webview hosts) the rendered HTML is returned
  // as-is: there is nothing to inline and local images keep their src.
  if (typeof document === "undefined") return html;

  const host = document.createElement("div");
  host.className = "print-body";
  host.setAttribute("style", HOST_STYLE);
  const mermaidSources = new Map<HTMLElement, string>();
  // Detached rendering still works for images; attaching the host lets mermaid
  // measure text like it does inside the preview pane (removed in `finally`).
  if (document.body) document.body.appendChild(host);
  try {
    host.innerHTML = html;
    for (const node of Array.from(host.querySelectorAll<HTMLElement>("pre.mermaid"))) {
      mermaidSources.set(node, node.textContent ?? "");
    }
    if (mermaidSources.size) {
      // renderMermaidIn only imports/initializes mermaid when diagrams exist and
      // never rejects (it marks failures itself), but a broken import must not
      // lose the document: the catch keeps the code block.
      try {
        await renderMermaidIn(host);
      } catch {
        /* fall through to the restore step below */
      }
      restoreUnrenderedMermaid(mermaidSources);
    }
    await materializeImages(host, docPath);
    return host.innerHTML;
  } finally {
    host.remove();
  }
}
