import { describe, expect, it } from "vitest";
import {
  dirnameOf,
  isAbsolutePath,
  joinPath,
  resolveLocalImageSrc,
} from "./imagePath";

describe("image path resolution", () => {
  it("dirname handles windows and posix separators", () => {
    expect(dirnameOf("D:\\docs\\notes.md")).toBe("D:\\docs");
    expect(dirnameOf("/home/u/docs/notes.md")).toBe("/home/u/docs");
  });

  it("isAbsolutePath recognizes drive and root paths", () => {
    expect(isAbsolutePath("D:\\pic.png")).toBe(true);
    expect(isAbsolutePath("D:/pic.png")).toBe(true);
    expect(isAbsolutePath("/abs/pic.png")).toBe(true);
    expect(isAbsolutePath("pic.png")).toBe(false);
    expect(isAbsolutePath("./pic.png")).toBe(false);
  });

  it("joinPath keeps the dir separator style", () => {
    expect(joinPath("D:\\docs", "img\\a.png")).toBe("D:\\docs\\img\\a.png");
    expect(joinPath("/docs", "img/a.png")).toBe("/docs/img/a.png");
  });

  it("leaves remote/data/protocol-relative srcs untouched", () => {
    const d = "D:\\docs";
    expect(resolveLocalImageSrc("https://x.com/a.png", d)).toBeNull();
    expect(resolveLocalImageSrc("data:image/png;base64,AA", d)).toBeNull();
    expect(resolveLocalImageSrc("//cdn/x.png", d)).toBeNull();
    expect(resolveLocalImageSrc("file:///C:/x.png", d)).toBeNull();
  });

  it("resolves relative paths against the base dir", () => {
    expect(resolveLocalImageSrc("img/a.png", "D:\\docs")).toBe("D:\\docs\\img\\a.png");
    expect(resolveLocalImageSrc("./a.png", "/docs")).toBe("/docs/a.png");
    expect(resolveLocalImageSrc("../shared/a.png", "/docs/sub")).toBe("/docs/shared/a.png");
  });

  it("returns absolute paths unchanged and null without a base dir", () => {
    expect(resolveLocalImageSrc("D:\\abs\\x.png", "D:\\docs")).toBe("D:\\abs\\x.png");
    expect(resolveLocalImageSrc("img/a.png", null)).toBeNull();
    expect(resolveLocalImageSrc("  ", "D:\\docs")).toBeNull();
  });

  it("percent-decodes markdown-it encoded srcs before resolving", () => {
    const base = "D:\\诗词";
    expect(
      resolveLocalImageSrc(
        "visual/%E7%99%BD%E5%B1%85%E6%98%93%E4%BC%A0-%E6%8F%92%E5%9B%BE/%E5%94%90%E9%A3%8E%E6%A7%90%E4%B8%8B%E5%AF%B9%E9%A5%AE%E6%B0%B4%E5%A2%A8%E7%94%BB.png",
        base,
      ),
    ).toBe("D:\\诗词\\visual\\白居易传-插图\\唐风槐下对饮水墨画.png");
    // %20 spaces and absolute Windows paths encoded with %5C backslashes
    expect(resolveLocalImageSrc("img/a%20b.png", "D:\\docs")).toBe("D:\\docs\\img\\a b.png");
    expect(resolveLocalImageSrc("D:%5Cdocs%5Cpic.png", "D:\\docs")).toBe("D:\\docs\\pic.png");
    // remote URLs survive decoding and are still rejected
    expect(resolveLocalImageSrc("https://x.com/a%20b.png", "D:\\docs")).toBeNull();
  });

  it("keeps malformed escape sequences instead of throwing", () => {
    expect(resolveLocalImageSrc("img/100%25.png", "D:\\docs")).toBe("D:\\docs\\img\\100%.png");
    expect(resolveLocalImageSrc("img/50%.png", "D:\\docs")).toBe("D:\\docs\\img\\50%.png");
  });
});
