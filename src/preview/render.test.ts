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
    expect(html).toContain('id="标题"');
    expect(html).toContain('data-line="1"');
    expect(html).toContain('<p data-line="3"');
    expect(html).toContain('<table data-line="5"');
    expect(html).toMatch(/<li data-line="\d+"/);
    // Fenced code blocks get data-line too.
    const fenced = renderMarkdown("```js\nconst x = 1;\n```");
    expect(fenced).toContain('<pre data-line="1"');
  });

  it("generates heading anchors and a [TOC] block", () => {
    const html = renderMarkdown("[TOC]\n\n# 快速上手\n\n## 安装 & 配置\n\n# 快速上手\n\n正文");
    // duplicate heading gets a -2 suffix; Chinese stays as the id
    expect(html).toContain('<h1 id="快速上手"');
    expect(html).toContain('<h1 id="快速上手-2"');
    expect(html).toContain('<h2 id="安装-配置"');
    expect(html).toContain('class="md-toc"');
    expect(html).toMatch(/href="#%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B"/);
    // without [TOC] no nav is emitted
    const noToc = renderMarkdown("# 只有标题");
    expect(noToc).not.toContain("md-toc");
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

  it("renders LaTeX math (inline and display)", () => {
    const inline = renderMarkdown("欧拉公式 $e^{i\\pi}+1=0$ 很美");
    expect(inline).toContain("katex");
    const display = renderMarkdown("$$\n\\int_0^1 x\\,dx\n$$");
    expect(display).toContain("katex-display");
  });

  it("emits mermaid fences without hljs markup", () => {
    const html = renderMarkdown(
      "```mermaid\ngraph TD\n  A-->B\n```",
    );
    expect(html).toContain('class="mermaid"');
    expect(html).not.toContain("hljs");
  });
});
