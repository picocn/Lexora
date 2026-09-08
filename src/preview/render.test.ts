import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render";

describe("markdown 预览渲染", () => {
  it("renders headings, lists and emphasis", () => {
    const html = renderMarkdown("# 标题\n\n- 甲\n- 乙\n\n**粗体** *斜体*");
    expect(html).toContain("<h1");
    expect(html).toContain(">标题</h1>");
    expect(html).toContain(">甲</li>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
  });

  it("html:false never emits raw html or script", () => {
    const html = renderMarkdown("正文\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders GFM tables and task lists", () => {
    const html = renderMarkdown(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo",
    );
    expect(html).toContain("<table");
    expect(html).toContain("checked");
    expect(html).toContain("disabled");
  });

  it("stamps data-line anchors for scroll sync", () => {
    const html = renderMarkdown("# 标题\n\n正文段\n\n| a |\n|---|\n| 1 |\n\n- 项");
    expect(html).toContain('<h1 data-line="1"');
    expect(html).toContain('<p data-line="3"');
    expect(html).toContain('<table data-line="5"');
    expect(html).toMatch(/<li data-line="\d+"/);
    // Fenced code blocks get data-line too.
    const fenced = renderMarkdown("```js\nconst x = 1;\n```");
    expect(fenced).toContain('<pre data-line="1"');
  });

  it("highlights fenced code blocks with hljs classes", () => {
    const html = renderMarkdown("```ts\nconst x: number = 1;\n```");
    expect(html).toContain('class="hljs"');
    expect(html).toContain("<code>");
  });

  it("escapes unknown language code blocks", () => {
    const html = renderMarkdown("```\n<a href=x>raw</a>\n```");
    expect(html).toContain("&lt;a");
  });
});
