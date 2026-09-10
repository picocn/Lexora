import { describe, expect, it } from "vitest";
import {
  decideExternalChange,
  describeExternalChange,
  formatStat,
  statsDiffer,
  type FileStat,
} from "./externalChange";

/** Stat helper with overridable fields. */
function stat(partial: Partial<FileStat> = {}): FileStat {
  return { exists: true, byteLen: 100, modifiedMs: 1_700_000_000_000, ...partial };
}

describe("statsDiffer", () => {
  it("never reports a change without a baseline", () => {
    expect(statsDiffer(null, stat())).toBe(false);
    // Even a deleted file is not a "change" when nothing was recorded yet.
    expect(statsDiffer(null, stat({ exists: false }))).toBe(false);
  });

  it("reports no change for identical stats", () => {
    expect(statsDiffer(stat(), stat())).toBe(false);
  });

  it("detects a size-only change", () => {
    expect(statsDiffer(stat(), stat({ byteLen: 101 }))).toBe(true);
  });

  it("detects a modification-time-only change", () => {
    expect(statsDiffer(stat(), stat({ modifiedMs: 1_700_000_005_000 }))).toBe(true);
  });

  it("detects a deleted file and treats it as changed until it comes back", () => {
    expect(statsDiffer(stat(), stat({ exists: false }))).toBe(true);
    // Both sides missing: nothing new to report.
    expect(statsDiffer(stat({ exists: false }), stat({ exists: false }))).toBe(false);
    // Re-created file counts as changed.
    expect(statsDiffer(stat({ exists: false }), stat())).toBe(true);
  });

  it("ignores size/mtime fields while the file does not exist", () => {
    expect(statsDiffer(stat({ exists: false }), stat({ exists: false, byteLen: 42 }))).toBe(false);
  });
});

describe("decideExternalChange", () => {
  it("returns none when nothing changed", () => {
    expect(decideExternalChange({ changed: false, dirty: false })).toBe("none");
    expect(decideExternalChange({ changed: false, dirty: true })).toBe("none");
  });

  it("reloads a clean document", () => {
    expect(decideExternalChange({ changed: true, dirty: false })).toBe("reload");
  });

  it("asks the user when the document is dirty", () => {
    expect(decideExternalChange({ changed: true, dirty: true })).toBe("conflict");
  });
});

describe("describeExternalChange", () => {
  it("mentions the path and mentions no data loss when clean", () => {
    const text = describeExternalChange("D:\\docs\\a.md", false);
    expect(text).toContain("D:\\docs\\a.md");
    expect(text).toContain("外部被修改");
    expect(text).not.toContain("未保存");
  });

  it("warns about unsaved edits when dirty", () => {
    const text = describeExternalChange("D:\\docs\\a.md", true);
    expect(text).toContain("D:\\docs\\a.md");
    expect(text).toContain("未保存");
    expect(text).toContain("重新加载");
    expect(text).not.toBe(describeExternalChange("D:\\docs\\a.md", false));
  });

  it("falls back to a label for pathless (untitled) documents", () => {
    expect(describeExternalChange("   ", true)).toContain("未保存的文档");
  });
});

describe("formatStat", () => {
  it("formats size and local modification time on one line", () => {
    const modifiedMs = new Date(2026, 1, 3, 14, 5, 7).getTime();
    expect(formatStat(stat({ byteLen: 12595, modifiedMs }))).toBe(
      "12.3 KB · 2026-02-03 14:05:07",
    );
  });

  it("uses bytes/kilobytes/megabytes units", () => {
    const modifiedMs = new Date(2026, 0, 1, 0, 0, 0).getTime();
    expect(formatStat(stat({ byteLen: 0, modifiedMs }))).toContain("0 B · ");
    expect(formatStat(stat({ byteLen: 512, modifiedMs }))).toContain("512 B · ");
    expect(formatStat(stat({ byteLen: 1024, modifiedMs }))).toContain("1.0 KB · ");
    expect(formatStat(stat({ byteLen: 2 * 1024 * 1024, modifiedMs }))).toContain("2.0 MB · ");
  });

  it("reports a missing file", () => {
    expect(formatStat(stat({ exists: false }))).toBe("文件不存在");
  });

  it("handles an empty stat without inventing a date", () => {
    const empty: FileStat = { exists: true, byteLen: 0, modifiedMs: 0 };
    expect(formatStat(empty)).toBe("0 B · 未知修改时间");
    expect(formatStat({ exists: true, byteLen: Number.NaN, modifiedMs: Number.NaN })).toBe(
      "0 B · 未知修改时间",
    );
  });
});
