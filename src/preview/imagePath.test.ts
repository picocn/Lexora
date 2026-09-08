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
});
