// Building the printable document (TODO requirement 5: print support).
// Markdown files let the user choose between the rendered preview and the raw
// text; every other text file is printed as raw text. This module is pure
// string work so it can be unit-tested; the caller owns the print window.

/** Kind of document being printed. */
export type PrintKind = "markdown" | "html" | "text";

/** Which representation to print. */
export type PrintMode = "preview" | "raw";

/** A ready-to-print document body plus its stylesheet. */
export interface PrintContent {
  title: string;
  html: string;
  css: string;
}

const DEFAULT_SANS = "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif";
const DEFAULT_MONO = "Consolas, 'Courier New', 'Microsoft YaHei Mono', monospace";

/** Fallback title when the caller has none (untitled document). */
const FALLBACK_TITLE = "未命名文档";

/**
 * Print modes offered for a kind. Only markdown can be printed from the
 * rendered preview; html/text are printed as raw text.
 */
export function printModesFor(kind: PrintKind): PrintMode[] {
  return kind === "markdown" ? ["preview", "raw"] : ["raw"];
}

/** Chinese label of a print mode, used by the choose-print-mode dialog. */
export function printModeLabel(mode: PrintMode): string {
  return mode === "preview" ? "打印预览版（渲染后）" : "打印原始文本";
}

/** Escapes text for HTML text/attribute contexts (tabs are preserved). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Raw (unrendered) printable body: the source text escaped into a
 * `<pre class="print-raw">` so whitespace and tab stops survive printing.
 */
export function rawPrintHtml(text: string): string {
  return `<pre class="print-raw">${escapeHtml(text)}</pre>`;
}

/** Strips characters that could break out of a CSS declaration. */
function sanitizeCssValue(value: string): string {
  return value
    .replace(/[;{}<>@\\]/g, " ")
    .replace(/\/\*|\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function cssFontFamily(value: string | undefined, fallback: string): string {
  const cleaned = typeof value === "string" ? sanitizeCssValue(value) : "";
  return cleaned || fallback;
}

function cssFontSize(px: number | undefined, fallback: number): number {
  if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) return fallback;
  return Math.min(48, Math.max(8, Math.round(px)));
}

/**
 * Print-oriented stylesheet: A4/auto page box, white-paper body reset, readable
 * typography, table borders and page-break rules that keep code blocks, tables,
 * quotes and images in one piece. `fontFamily`/`fontSizePx` are applied to the
 * body and to the raw-text (`.print-raw`) block; `rawFontFamily` optionally
 * overrides the raw block only (e.g. a monospace editor font while the page
 * itself stays in the preview font). Invalid values fall back to defaults.
 */
export function buildPrintCss(opts?: {
  fontFamily?: string;
  fontSizePx?: number;
  rawFontFamily?: string;
}): string {
  const bodyFamily = cssFontFamily(opts?.fontFamily, DEFAULT_SANS);
  const rawFamily = cssFontFamily(opts?.rawFontFamily ?? opts?.fontFamily, DEFAULT_MONO);
  const givenSize = opts?.fontSizePx;
  const bodySize = cssFontSize(givenSize, 15);
  const rawSize = cssFontSize(givenSize, 13);
  return [
    "@page { size: auto; margin: 16mm }",
    "",
    "html, body { margin: 0; padding: 0; background: #fff; }",
    "body {",
    `  font-family: ${bodyFamily};`,
    `  font-size: ${bodySize}px;`,
    "  line-height: 1.7;",
    "  color: #1f2328;",
    "  -webkit-print-color-adjust: exact;",
    "  print-color-adjust: exact;",
    "}",
    "",
    "h1, h2, h3, h4, h5, h6 { margin: 1.2em 0 0.6em; font-weight: 600; line-height: 1.35; }",
    "h1 { font-size: 1.8em; padding-bottom: 0.2em; border-bottom: 1px solid #d8dee4; }",
    "h2 { font-size: 1.5em; padding-bottom: 0.15em; border-bottom: 1px solid #eaeef2; }",
    "h3 { font-size: 1.25em; }",
    "h4, h5, h6 { font-size: 1.1em; }",
    "p, ul, ol, dl { margin: 0.6em 0; }",
    "ul, ol { padding-left: 1.6em; }",
    "li { margin: 0.2em 0; }",
    "blockquote {",
    "  margin: 0.8em 0;",
    "  padding: 0.2em 1em;",
    "  border-left: 3px solid #d0d7de;",
    "  color: #57606a;",
    "}",
    "a { color: #0969da; text-decoration: underline; word-break: break-all; }",
    "hr { border: 0; border-top: 1px solid #d8dee4; margin: 1.4em 0; }",
    `code, kbd, samp { font-family: ${DEFAULT_MONO}; font-size: 0.92em; background: #f6f8fa; padding: 0.1em 0.3em; border-radius: 3px; }`,
    "pre {",
    "  white-space: pre-wrap;",
    "  word-break: break-word;",
    "  margin: 0.8em 0;",
    "  padding: 0.6em 0.8em;",
    "  border: 1px solid #eaeef2;",
    "  border-radius: 4px;",
    "  background: #f6f8fa;",
    `  font-family: ${DEFAULT_MONO};`,
    "  font-size: 0.92em;",
    "  line-height: 1.5;",
    "}",
    "pre code { background: none; padding: 0; font-size: inherit; }",
    "img { max-width: 100% }",
    "svg { max-width: 100%; height: auto; }",
    "table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }",
    "th, td { border: 1px solid #d0d7de; padding: 5px 10px; text-align: left; vertical-align: top; }",
    "thead th { background: #f6f8fa; }",
    "/* 分页：块级内容整体保留，标题不与后文分离 */",
    "pre, table, blockquote, img { page-break-inside: avoid; break-inside: avoid; }",
    "h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }",
    "tr, li { page-break-inside: avoid; }",
    "",
    "/* 原始文本（未渲染）打印：等宽、保留缩进与制表符 */",
    ".print-raw {",
    `  font-family: ${rawFamily};`,
    `  font-size: ${rawSize}px;`,
    "  line-height: 1.5;",
    "  margin: 0;",
    "  padding: 0;",
    "  border: 0;",
    "  background: #fff;",
    "  color: #111;",
    "  white-space: pre-wrap;",
    "  word-break: break-word;",
    "  tab-size: 8;",
    "  -moz-tab-size: 8;",
    "}",
    "",
  ].join("\n");
}

/**
 * Builds the printable body for the chosen mode.
 * - "preview" prints the already rendered HTML and requires `renderedHtml`.
 * - "raw" escapes `text` into a `<pre class="print-raw">` block.
 * The title falls back to a placeholder so the print header is never blank.
 */
export function buildPrintContent(opts: {
  kind: PrintKind;
  mode: PrintMode;
  title: string;
  renderedHtml?: string;
  text?: string;
}): PrintContent {
  const title = opts.title.trim() || FALLBACK_TITLE;
  if (opts.mode === "preview") {
    const rendered = opts.renderedHtml;
    if (typeof rendered !== "string") {
      throw new Error(
        "打印预览版需要先渲染 Markdown：缺少 renderedHtml（请先调用 prepareMarkdownPrint）",
      );
    }
    return { title, html: rendered, css: buildPrintCss() };
  }
  return { title, html: rawPrintHtml(opts.text ?? ""), css: buildPrintCss() };
}
