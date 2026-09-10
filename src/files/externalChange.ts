// Detecting that an opened file changed on disk (edited by another program).
// The Rust side owns the privileged work (stat/read); this module is pure logic
// + user-facing text so it can be unit-tested without Tauri.

/** Snapshot of a file's on-disk state as reported by the backend. */
export interface FileStat {
  exists: boolean;
  byteLen: number;
  modifiedMs: number;
}

/** What to do about an external change. */
export type ExternalChangeDecision = "none" | "reload" | "conflict";

/**
 * True when the on-disk state differs from the recorded baseline.
 * `recorded === null` means "no baseline yet" (the file was never read or the
 * backend could not stat it) → never report a change, so a failed stat call
 * cannot turn into a spurious "file changed" prompt.
 * A vanished file (exists flipped to false) always counts as changed.
 */
export function statsDiffer(recorded: FileStat | null, current: FileStat): boolean {
  if (recorded === null) return false;
  if (recorded.exists !== current.exists) return true;
  if (!current.exists) return false; // still missing: nothing new to report
  return recorded.byteLen !== current.byteLen || recorded.modifiedMs !== current.modifiedMs;
}

/**
 * Classifies a detected change: "none" when nothing changed, "conflict" when
 * the editor holds unsaved edits (reloading would lose them, so the user must
 * choose), "reload" when silently re-reading the file is safe.
 */
export function decideExternalChange(opts: { changed: boolean; dirty: boolean }): ExternalChangeDecision {
  if (!opts.changed) return "none";
  return opts.dirty ? "conflict" : "reload";
}

/**
 * User-facing Chinese body text for the external-change prompt. `dirty` adds a
 * warning about the unsaved edits a reload would discard.
 */
export function describeExternalChange(path: string, dirty: boolean): string {
  const shown = path.trim() || "未保存的文档";
  if (dirty) {
    return (
      `检测到文件已在外部被修改：\n${shown}\n\n` +
      "当前编辑器中有未保存的修改，重新加载会丢弃这些修改。\n" +
      "请选择「保留当前内容」（之后可另存为其他文件）或「重新加载」（放弃本地修改）。"
    );
  }
  return (
    `检测到文件已在外部被修改：\n${shown}\n\n` +
    "是否重新加载磁盘上的最新内容？"
  );
}

/** Human-readable byte size ("0 B" / "512 B" / "12.3 KB" / "1.5 MB"). */
function formatBytes(byteLen: number): string {
  const n = Number.isFinite(byteLen) && byteLen > 0 ? byteLen : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Local-time "YYYY-MM-DD HH:mm:ss"; invalid/zero timestamps become a note. */
function formatTime(modifiedMs: number): string {
  if (!Number.isFinite(modifiedMs) || modifiedMs <= 0) return "未知修改时间";
  const d = new Date(modifiedMs);
  const p2 = (v: number): string => String(v).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/**
 * One-line Chinese summary of a stat, e.g. "12.3 KB · 2026-02-03 14:05:07".
 * A missing file reports that instead of a size/time pair.
 */
export function formatStat(stat: FileStat): string {
  if (!stat.exists) return "文件不存在";
  return `${formatBytes(stat.byteLen)} · ${formatTime(stat.modifiedMs)}`;
}
