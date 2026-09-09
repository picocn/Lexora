import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import texmath from "markdown-it-texmath";

const md: MarkdownIt = new MarkdownIt({
  html: false, // security: never render raw HTML from the edited document
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
    if (lang === "mermaid") {
      // Mermaid diagrams are rendered client-side after the preview mounts.
      return `<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

// LaTeX math: $...$ inline, $$...$$ display, \(...\)/\[...\] and begin{} envs.
md.use(texmath, {
  engine: katex,
  delimiters: "dollars",
  katexOptions: { throwOnError: false, output: "html" },
});

md.enable(["table", "strikethrough"]);

// External links: open in a new context and never let the preview navigate
// the whole app window. Click interception in PreviewPane routes them to the
// OS browser; target/rel here are defense in depth.
{
  const prevLinkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
    }
    return prevLinkOpen
      ? prevLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

// Task lists: convert list-item text that starts with "[ ]"/"[x]".
md.core.ruler.after("inline", "task-lists", (state) => {
  let itemDepth = 0;
  for (const token of state.tokens) {
    if (token.type === "list_item_open") itemDepth++;
    else if (token.type === "list_item_close") itemDepth--;
    if (token.type !== "inline" || itemDepth <= 0 || !token.children?.length) continue;
    const first = token.children[0];
    if (first.type !== "text") continue;
    const m = /^\[([ xX])\]\s+/.exec(first.content);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x" ? "checked" : "";
    const cb = new state.Token("html_inline", "", 0);
    cb.content = `<input type="checkbox" disabled ${checked}> `;
    token.children.unshift(cb);
    first.content = first.content.slice(m[0].length);
  }
  return true;
});

// ---- anchors + [TOC] ---------------------------------------------------------
// GitHub-style behavior: every heading gets an auto-generated `id` (unicode
// aware slug, duplicates get -2/-3...), so `[跳转](#slug)` works in-preview.
// A standalone `[TOC]` line is replaced by a generated table of contents.

/** GitHub-ish slug: unicode letters/digits kept, others collapsed to '-'. */
function slugify(text: string): string {
  const base = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collects a heading's plain text (from its inline children). */
function headingText(state: { tokens: unknown[] }, openIdx: number): string {
  const tokens = state.tokens as Array<{
    type: string;
    content: string;
    children?: Array<{ type: string; content: string }>;
  }>;
  let out = "";
  for (let j = openIdx + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === "heading_close") break;
    if (t.type === "inline") {
      if (t.children?.length) {
        for (const c of t.children) {
          if (c.type === "text" || c.type === "code_inline") out += c.content;
        }
      } else {
        out += t.content;
      }
    }
  }
  return out.trim();
}

md.core.ruler.after("inline", "anchors-toc", (state) => {
  const tokens = state.tokens as Array<{
    type: string;
    tag?: string;
    content: string;
    attrSet?: (name: string, value: string) => void;
    level?: number;
  }>;
  const used = new Set<string>();
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const headingOpen: Array<{ idx: number; level: number }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open" || !t.tag) continue;
    const level = Number(t.tag.slice(1)) || 1;
    headingOpen.push({ idx: i, level });
    const text = headingText(state, i);
    const base = slugify(text);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    t.attrSet?.("id", id);
    headings.push({ level, text, id });
  }
  void headingOpen;

  if (headings.length === 0) return true;

  const tocHtml =
    headings.length > 0
      ? `<nav class="md-toc"><ul>${headings
          .map(
            (h) =>
              `<li class="toc-l${Math.min(Math.max(h.level, 1), 6)}"><a href="#${encodeURIComponent(h.id)}">${escHtml(h.text)}</a></li>`,
          )
          .join("")}</ul></nav>`
      : "";

  // Replace a standalone paragraph whose text is exactly "[TOC]".
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "paragraph_open") continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== "inline") continue;
    if ((inline.content ?? "").trim() === "[TOC]") {
      const nav = new state.Token("html_block", "", 0);
      nav.content = tocHtml;
      tokens.splice(i, 3, nav);
      break; // only the first [TOC]
    }
  }
  return true;
});

/** Renders markdown source to an HTML string. Safe: html:false. */
export function renderMarkdown(src: string): string {
  return md.render(src);
}

// ---- source-line anchors for split-view scroll sync -------------------------
// Every top-level block token carries `map: [startLine, endLine]` (0-based).
// We stamp `data-line` (1-based, matching the editor gutter) on rendered block
// open tags so the preview DOM can be scrolled to the markdown line a scroll
// position corresponds to.

const BLOCK_OPEN_TYPES = [
  "paragraph_open",
  "heading_open",
  "bullet_list_open",
  "ordered_list_open",
  "blockquote_open",
  "table_open",
  "list_item_open",
  "tr_open",
];

for (const type of BLOCK_OPEN_TYPES) {
  const prev = md.renderer.rules[type];
  md.renderer.rules[type] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.map) {
      token.attrSet("data-line", String(token.map[0] + 1));
    }
    return prev ? prev(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

// Fenced code blocks are single self-closing tokens; stamp the <pre>.
{
  const prev = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = prev ? prev(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    const token = tokens[idx];
    if (token.map && html.startsWith("<pre")) {
      return html.replace(/^<pre/, `<pre data-line="${token.map[0] + 1}"`);
    }
    return html;
  };
}
