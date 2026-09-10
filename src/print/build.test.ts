import { describe, expect, it } from "vitest";
import {
  buildPrintContent,
  buildPrintCss,
  buildStandalonePrintDocument,
  escapeHtml,
  printModeLabel,
  printModesFor,
  rawPrintHtml,
} from "./build";

describe("printModesFor", () => {
  it("offers preview + raw only for markdown", () => {
    expect(printModesFor("markdown")).toEqual(["preview", "raw"]);
  });

  it("offers raw only for html and text", () => {
    expect(printModesFor("html")).toEqual(["raw"]);
    expect(printModesFor("text")).toEqual(["raw"]);
  });
});

describe("printModeLabel", () => {
  it("labels both modes in Chinese", () => {
    expect(printModeLabel("preview")).toBe("打印预览版（渲染后）");
    expect(printModeLabel("raw")).toBe("打印原始文本");
  });
});

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml("<a href=\"x\">&</a>")).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands before other entities", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("keeps tabs, newlines and CJK text untouched", () => {
    expect(escapeHtml("\t行1\n行2")).toBe("\t行1\n行2");
  });
});

describe("rawPrintHtml", () => {
  it("wraps escaped text in a pre.print-raw block", () => {
    expect(rawPrintHtml("a < b")).toBe('<pre class="print-raw">a &lt; b</pre>');
  });

  it("keeps tab characters (tab expansion happens in CSS)", () => {
    expect(rawPrintHtml("\tif (x < 1) {\n\t}")).toBe(
      '<pre class="print-raw">\tif (x &lt; 1) {\n\t}</pre>',
    );
  });

  it("renders an empty body for empty text", () => {
    expect(rawPrintHtml("")).toBe('<pre class="print-raw"></pre>');
  });
});

describe("buildPrintCss", () => {
  const css = buildPrintCss();

  it("declares the page box and a body reset", () => {
    expect(css).toContain("@page { size: auto; margin: 16mm }");
    expect(css).toContain("html, body { margin: 0; padding: 0;");
  });

  it("contains the required page-break rules", () => {
    expect(css).toContain("pre, table, blockquote, img { page-break-inside: avoid;");
    expect(css).toContain("h1, h2, h3, h4 { page-break-after: avoid;");
  });

  it("keeps pre-wrap code, bounded images and bordered tables", () => {
    expect(css).toContain("white-space: pre-wrap;");
    expect(css).toContain("word-break: break-word;");
    expect(css).toContain("img { max-width: 100% }");
    expect(css).toContain("border-collapse: collapse;");
    expect(css).toContain("th, td { border: 1px solid");
  });

  it("styles the raw monospace block with the configured font", () => {
    const custom = buildPrintCss({ fontFamily: "'Sarasa Mono SC', monospace", fontSizePx: 18 });
    expect(custom).toContain(".print-raw {");
    expect(custom).toContain("font-family: 'Sarasa Mono SC', monospace;");
    expect(custom).toContain("font-size: 18px;");
    expect(custom).toContain("tab-size: 8;");
  });

  it("can style the raw block independently of the page font", () => {
    const css = buildPrintCss({
      fontFamily: "system-ui, sans-serif",
      rawFontFamily: "Consolas, monospace",
      fontSizePx: 14,
    });
    const raw = css.slice(css.indexOf(".print-raw {"));
    expect(css).toContain("font-family: system-ui, sans-serif;");
    expect(raw).toContain("font-family: Consolas, monospace;");
    expect(raw).toContain("font-size: 14px;");
  });

  it("falls back to defaults for missing or invalid font options", () => {
    const dflt = buildPrintCss({ fontFamily: "   ", fontSizePx: Number.NaN });
    expect(dflt).toContain("font-size: 15px;");
    const tiny = buildPrintCss({ fontSizePx: 0 });
    expect(tiny).toContain("font-size: 15px;");
    const huge = buildPrintCss({ fontSizePx: 500 });
    expect(huge).toContain("font-size: 48px;");
  });

  it("cannot be broken out of with a crafted font family", () => {
    const evil = buildPrintCss({ fontFamily: "Arial; } body { display: none }" });
    expect(evil).not.toContain("body { display: none }");
  });
});

describe("buildPrintContent", () => {
  it("prints the rendered preview for markdown", () => {
    const content = buildPrintContent({
      kind: "markdown",
      mode: "preview",
      title: "说明文档",
      renderedHtml: "<h1>标题</h1>",
    });
    expect(content).toEqual({
      title: "说明文档",
      html: "<h1>标题</h1>",
      css: buildPrintCss(),
    });
  });

  it("prints raw text for markdown in raw mode", () => {
    const content = buildPrintContent({
      kind: "markdown",
      mode: "raw",
      title: "n.md",
      text: "# 标题 & <b>",
    });
    expect(content.html).toBe('<pre class="print-raw"># 标题 &amp; &lt;b&gt;</pre>');
  });

  it("prints raw text for text and html kinds", () => {
    expect(
      buildPrintContent({ kind: "text", mode: "raw", title: "a.log", text: "log line" }).html,
    ).toBe('<pre class="print-raw">log line</pre>');
    expect(
      buildPrintContent({
        kind: "html",
        mode: "raw",
        title: "a.html",
        text: "<p>hi</p>",
      }).html,
    ).toBe('<pre class="print-raw">&lt;p&gt;hi&lt;/p&gt;</pre>');
  });

  it("throws a clear error when preview mode has no rendered html", () => {
    expect(() =>
      buildPrintContent({ kind: "markdown", mode: "preview", title: "a.md" }),
    ).toThrowError(/renderedHtml/);
    expect(() =>
      buildPrintContent({
        kind: "markdown",
        mode: "preview",
        title: "a.md",
        renderedHtml: undefined,
      }),
    ).toThrowError(/预览/);
  });

  it("accepts an empty rendered preview but rejects a missing one", () => {
    expect(
      buildPrintContent({ kind: "markdown", mode: "preview", title: "a.md", renderedHtml: "" }).html,
    ).toBe("");
  });

  it("handles titles: trimmed, empty, whitespace-only and path-like", () => {
    const title = (t: string): string =>
      buildPrintContent({ kind: "text", mode: "raw", title: t, text: "" }).title;
    expect(title("  a.md  ")).toBe("a.md");
    expect(title("")).toBe("未命名文档");
    expect(title("   ")).toBe("未命名文档");
    expect(title("D:\\docs\\说明.md")).toBe("D:\\docs\\说明.md");
  });

  it("always returns a stylesheet", () => {
    const content = buildPrintContent({ kind: "text", mode: "raw", title: "a.txt", text: "x" });
    expect(content.css).toContain("@page");
  });
});

describe("buildStandalonePrintDocument", () => {
  const doc = (autoPrint?: boolean): string =>
    buildStandalonePrintDocument({
      title: "报告",
      html: "<h1>标题</h1>",
      css: "@page { margin: 16mm }",
      autoPrint,
    });

  it("produces a complete document with charset, title and styles", () => {
    const html = doc();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain("<title>报告</title>");
    expect(html).toContain("@page { margin: 16mm }");
    expect(html).toContain('<article class="print-body"><h1>标题</h1></article>');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("only adds the auto-print script when asked", () => {
    expect(doc()).not.toContain("window.print()");
    expect(doc(true)).toContain("window.print()");
  });

  it("escapes the title and falls back for an empty one", () => {
    expect(doc()).toBeTruthy();
    const evil = buildStandalonePrintDocument({
      title: '</title><script>alert(1)</script>',
      html: "",
      css: "",
    });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
    const empty = buildStandalonePrintDocument({ title: "   ", html: "", css: "" });
    expect(empty).toContain("<title>未命名文档</title>");
  });
});
