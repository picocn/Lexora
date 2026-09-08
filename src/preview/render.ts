import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

export const md: MarkdownIt = new MarkdownIt({
  html: false, // security: never render raw HTML from the edited document
  linkify: true,
  breaks: false,
  highlight(code: string, lang: string): string {
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

md.enable(["table", "strikethrough"]);

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
