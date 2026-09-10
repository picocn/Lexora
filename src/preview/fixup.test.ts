import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearImageCache,
  imageCacheKey,
  imageCacheSize,
  loadImageDataUrl,
  mimeOfPath,
  resolveLocalImage,
} from "./fixup";

// NOTE: jsdom/happy-dom are not installed in this repo (vitest runs with
// environment "node"), so materializeImages itself cannot be exercised here.
// The DOM-independent parts it is built from (src resolution, cache keying and
// the caching reader) are covered instead.

afterEach(() => {
  clearImageCache();
});

describe("mimeOfPath", () => {
  it("maps image extensions to MIME types", () => {
    expect(mimeOfPath("D:\\pics\\a.PNG")).toBe("image/png");
    expect(mimeOfPath("a.jpeg")).toBe("image/jpeg");
    expect(mimeOfPath("a.svg")).toBe("image/svg+xml");
    expect(mimeOfPath("a.webp")).toBe("image/webp");
  });

  it("falls back for unknown and missing extensions", () => {
    expect(mimeOfPath("a.unknown")).toBe("application/octet-stream");
    expect(mimeOfPath("noext")).toBe("application/octet-stream");
  });
});

describe("imageCacheKey", () => {
  it("unifies separator styles and trims", () => {
    expect(imageCacheKey("D:\\docs\\a.png")).toBe(imageCacheKey("D:/docs/a.png"));
    expect(imageCacheKey("  D:\\docs\\a.png  ")).toBe("D:\\docs\\a.png");
    expect(imageCacheKey("D://docs//a.png")).toBe("D:\\docs\\a.png");
  });

  it("keeps distinct files distinct", () => {
    expect(imageCacheKey("D:\\docs\\a.png")).not.toBe(imageCacheKey("D:\\docs\\b.png"));
    expect(imageCacheKey("D:\\Docs\\a.png")).not.toBe(imageCacheKey("D:\\docs\\A.png"));
  });
});

describe("resolveLocalImage", () => {
  it("leaves non-local sources alone", () => {
    const doc = "D:\\docs\\notes.md";
    for (const src of [
      "https://x.com/a.png",
      "http://x.com/a.png",
      "data:image/png;base64,AAA",
      "//cdn.example.com/a.png",
      "file:///C:/a.png",
      "asset://localhost/a.png",
      "   ",
    ]) {
      expect(resolveLocalImage(src, doc)).toBeNull();
    }
  });

  it("resolves relative paths against the document folder", () => {
    expect(resolveLocalImage("img/a.png", "D:\\docs\\notes.md")).toEqual({
      path: "D:\\docs\\img\\a.png",
      mime: "image/png",
    });
    expect(resolveLocalImage("./a.jpg", "/home/u/docs/n.md")).toEqual({
      path: "/home/u/docs/a.jpg",
      mime: "image/jpeg",
    });
  });

  it("resolves relative paths for percent-encoded (CJK) sources", () => {
    expect(resolveLocalImage("img/%E7%99%BD.png", "D:\\诗词\\a.md")).toEqual({
      path: "D:\\诗词\\img\\白.png",
      mime: "image/png",
    });
  });

  it("resolves absolute paths even without a document path", () => {
    expect(resolveLocalImage("D:\\pics\\x.png", null)).toEqual({
      path: "D:\\pics\\x.png",
      mime: "image/png",
    });
    expect(resolveLocalImage("/tmp/pic.gif", null)).toEqual({
      path: "/tmp/pic.gif",
      mime: "image/gif",
    });
  });

  it("cannot resolve a relative path for an unsaved document", () => {
    expect(resolveLocalImage("img/a.png", null)).toBeNull();
  });
});

describe("loadImageDataUrl", () => {
  it("reads once and serves the cached data URL afterwards", async () => {
    const read = vi.fn(() => Promise.resolve("QUJD"));
    const first = await loadImageDataUrl("D:\\docs\\a.png", "image/png", read);
    const second = await loadImageDataUrl("D:\\docs\\a.png", "image/png", read);
    expect(first).toBe("data:image/png;base64,QUJD");
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(imageCacheSize()).toBe(1);
  });

  it("deduplicates across separator spellings of the same path", async () => {
    const read = vi.fn(() => Promise.resolve("QUJD"));
    await loadImageDataUrl("D:\\docs\\a.png", "image/png", read);
    await loadImageDataUrl("D:/docs/a.png", "image/png", read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(imageCacheSize()).toBe(1);
  });

  it("does not cache failures", async () => {
    const read = vi
      .fn<(path: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValueOnce("QUJD");
    await expect(loadImageDataUrl("D:\\a.png", "image/png", read)).rejects.toThrow("读取失败");
    expect(imageCacheSize()).toBe(0);
    await expect(loadImageDataUrl("D:\\a.png", "image/png", read)).resolves.toBe(
      "data:image/png;base64,QUJD",
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry beyond the cache limit", async () => {
    const read = vi.fn((path: string) => Promise.resolve(path));
    for (let i = 0; i < 129; i++) {
      await loadImageDataUrl(`D:\\pics\\${i}.png`, "image/png", read);
    }
    expect(imageCacheSize()).toBe(128);
    // The first image was evicted, so reading it again hits the reader once more.
    await loadImageDataUrl("D:\\pics\\0.png", "image/png", read);
    expect(read).toHaveBeenCalledTimes(130);
  });

  it("clearImageCache drops every entry", async () => {
    const read = vi.fn(() => Promise.resolve("QUJD"));
    await loadImageDataUrl("D:\\a.png", "image/png", read);
    expect(imageCacheSize()).toBe(1);
    clearImageCache();
    expect(imageCacheSize()).toBe(0);
    await loadImageDataUrl("D:\\a.png", "image/png", read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
