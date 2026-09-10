import { describe, expect, it } from "vitest";
import { prepareMarkdownPrint } from "./prepare";

// vitest runs with environment "node" (no DOM), so these tests exercise the
// DOM-free path of prepareMarkdownPrint: the markdown preview pipeline output is
// returned as-is, because there is no DOM to render mermaid into or to inline
// local images through. The DOM-dependent steps (mermaid SVG, image data URLs)
// are covered indirectly by preview/fixup.test.ts and are verified in the app.

describe("prepareMarkdownPrint", () => {
  it("renders markdown with the preview pipeline", async () => {
    const html = await prepareMarkdownPrint("# 标题\n\n正文 **加粗**。", null);
    expect(html).toContain('<h1 id="标题"');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("data-line");
  });

  it("keeps raw HTML in the source escaped (html:false)", async () => {
    const html = await prepareMarkdownPrint("<script>alert(1)</script>", null);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns an empty body for empty source", async () => {
    expect(await prepareMarkdownPrint("", null)).toBe("");
  });

  it("keeps local image sources when they cannot be inlined", async () => {
    const html = await prepareMarkdownPrint("![图](img/白.png)", "D:\\诗词\\a.md");
    expect(html).toContain('src="img/%E7%99%BD.png"');
    expect(html).not.toContain("data:image");
  });

  it("keeps the mermaid fenced block as code before/without rendering", async () => {
    const html = await prepareMarkdownPrint("```mermaid\ngraph TD;\nA-->B;\n```", null);
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD;");
  });

  it("renders tables and math like the preview does", async () => {
    const html = await prepareMarkdownPrint("| a | b |\n| - | - |\n| 1 | 2 |\n\n$x^2$", null);
    expect(html).toMatch(/<table\b/);
    expect(html).toContain("katex");
  });
});
