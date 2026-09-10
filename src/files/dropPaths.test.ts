import { describe, expect, it } from "vitest";
import { dropSummary, isLikelyTextFile, isProbablyBinaryFile, normalizePathList } from "./dropPaths";

describe("normalizePathList", () => {
  it("trims and drops empty entries", () => {
    expect(normalizePathList(["  D:\\a.md  ", "", "   ", "\t"])).toEqual(["D:\\a.md"]);
  });

  it("keeps the original order", () => {
    expect(normalizePathList(["b.md", "a.md", "c.md"])).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("de-duplicates case-insensitively and across separator styles", () => {
    expect(normalizePathList(["D:\\Docs\\A.md", "d:/docs/a.MD"])).toEqual(["D:\\Docs\\A.md"]);
    expect(
      normalizePathList(["C:\\x\\y.txt", "C:/x/Y.txt", "C:\\x\\y.txt", "D:\\x\\y.txt"]),
    ).toEqual(["C:\\x\\y.txt", "D:\\x\\y.txt"]);
  });

  it("keeps the first spelling of a duplicated path", () => {
    expect(normalizePathList(["D:/Docs/A.md", "D:\\docs\\a.md"])[0]).toBe("D:/Docs/A.md");
  });

  it("returns an empty list for empty input", () => {
    expect(normalizePathList([])).toEqual([]);
  });
});

describe("dropSummary", () => {
  it("counts the normalized, de-duplicated files", () => {
    expect(dropSummary(["a.md", "b.md", "c.md"])).toBe("松开以打开 3 个文件");
    expect(dropSummary(["a.md", "A.MD"])).toBe("松开以打开 1 个文件");
  });

  it("reports when nothing can be opened", () => {
    expect(dropSummary([])).toBe("未识别到可打开的文件");
    expect(dropSummary(["   ", ""])).toBe("未识别到可打开的文件");
  });
});

describe("isLikelyTextFile", () => {
  const textNames = [
    "notes.md",
    "README.MD",
    "readme.txt",
    "main.rs",
    "package.json",
    "data.csv",
    "config.yaml",
    "notes.markdown",
    "index.html",
    "app.tsx",
    "D:\\docs\\deep\\a.yml",
    "Makefile",
    ".gitignore",
  ];
  const binaryNames = [
    "photo.png",
    "pic.jpg",
    "clip.mp4",
    "bundle.zip",
    "setup.exe",
    "song.mp3",
    "doc.pdf",
    "font.ttf",
    "archive.7z",
  ];

  it.each(textNames)("treats %s as text", (name) => {
    expect(isLikelyTextFile(name)).toBe(true);
  });

  it.each(binaryNames)("treats %s as not-text", (name) => {
    expect(isLikelyTextFile(name)).toBe(false);
  });

  it("rejects unknown extensions, directories and blanks", () => {
    expect(isLikelyTextFile("weird.zzz")).toBe(false);
    expect(isLikelyTextFile("noextension")).toBe(false);
    expect(isLikelyTextFile("D:\\docs\\folder\\")).toBe(false);
    expect(isLikelyTextFile("")).toBe(false);
    expect(isLikelyTextFile("   ")).toBe(false);
  });

  it("ignores dots inside directories", () => {
    expect(isLikelyTextFile("D:\\my.docs\\notes.md")).toBe(true);
    expect(isLikelyTextFile("D:\\my.docs\\photo.png")).toBe(false);
  });
});

describe("isProbablyBinaryFile", () => {
  it.each([
    "photo.PNG",
    "setup.exe",
    "bundle.7z",
    "clip.mkv",
    "report.pdf",
    "font.woff2",
    "data.sqlite",
    "app.dll",
  ])("flags %s as binary", (name) => {
    expect(isProbablyBinaryFile(name)).toBe(true);
  });

  it.each(["notes.md", "script.rs", "config.zzz", "Makefile", "noextension", "data.unknown"])(
    "lets %s through (unknown extensions are attempted)",
    (name) => {
      expect(isProbablyBinaryFile(name)).toBe(false);
    },
  );

  it("handles blanks and paths with dots in directories", () => {
    expect(isProbablyBinaryFile("")).toBe(false);
    expect(isProbablyBinaryFile("   ")).toBe(false);
    expect(isProbablyBinaryFile("D:\\my.docs\\notes.md")).toBe(false);
    expect(isProbablyBinaryFile("D:\\my.docs\\photo.jpeg")).toBe(true);
  });
});
