import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface FileReadResult {
  content: string;
  utf8Ok: boolean;
  /** File started with a UTF-8 BOM (re-added on same-file saves). */
  utf8Bom: boolean;
  byteLen: number;
}

export interface SnapshotInfo {
  key: string;
  originalPath: string | null;
  title: string;
  modifiedAtMs: number;
  snippet: string;
}

export interface FileStat {
  exists: boolean;
  byteLen: number;
  modifiedMs: number;
}

export interface PathKindInfo {
  path: string;
  kind: "file" | "dir" | "missing";
}

/** Result of the portable .md file-association registration (HKCU only). */
export interface AssocStatus {
  exePath: string;
  progId: string;
  /** Our ProgID key tree exists and points at this executable. */
  registered: boolean;
  /** Current default ProgID of the .md extension. */
  mdDefault: string | null;
  /** Whether .md currently resolves to this app. */
  mdPointsToUs: boolean;
  /** Windows "UserChoice" ProgID, which overrides the fallback association. */
  userChoice: string | null;
  /** False on non-Windows builds. */
  supported: boolean;
}

export interface PrintDoc {
  title: string;
  html: string;
}

export interface AppSettings {
  autosave: { enabled: boolean; intervalSec: number };
  /** File-watching / association options. */
  files: { watchExternal: boolean };
  editor: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    tabSize: number;
    wordWrap: boolean;
    lineNumbers: boolean;
  };
  preview: { fontFamily: string; fontSize: number };
  theme: { kind: "builtin" | "vscode"; id: string };
  layout: "split" | "edit" | "preview";
  recentFiles: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  autosave: { enabled: true, intervalSec: 5 },
  files: { watchExternal: true },
  editor: {
    fontFamily: "Consolas, 'Courier New', 'Sarasa Mono SC', monospace",
    fontSize: 15,
    lineHeight: 1.6,
    tabSize: 4,
    wordWrap: false,
    lineNumbers: true,
  },
  preview: {
    fontFamily: "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    fontSize: 15,
  },
  theme: { kind: "builtin", id: "light" },
  layout: "edit",
  recentFiles: [],
};

/** Native open dialog + read. Returns null when the user cancels; when the
 * pick succeeded but the read failed, returns { path, error }. */
export async function pickAndReadFile(): Promise<
  { path: string; read: FileReadResult } | { path: string; error: string } | null
> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: "打开文件",
  });
  if (typeof picked !== "string") return null;
  try {
    const read = await invoke<FileReadResult>("read_text_file", { path: picked });
    return { path: picked, read };
  } catch (e) {
    return { path: picked, error: String(e) };
  }
}

/** Read a specific path (used by recovery to get current disk content). */
export async function readTextFile(path: string): Promise<FileReadResult> {
  return invoke<FileReadResult>("read_text_file", { path });
}

/** Native save dialog; returns chosen path or null when cancelled. */
export async function pickSavePath(defaultPath?: string): Promise<string | null> {
  const picked = await save({
    title: "保存文件",
    defaultPath,
  });
  return typeof picked === "string" ? picked : null;
}

/** Manual save ONLY (real file writes happen here / write_text_file). */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}

export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** Reads a local image file into a base64 payload (data URL body). */
export function readImageBase64(path: string): Promise<string> {
  return invoke<string>("read_image_base64", { path });
}

/** Opens an http(s) URL in the OS default browser (never navigates the app). */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
}

export async function snapshotWrite(
  docKey: string,
  content: string,
  title: string,
  originalPath: string | null,
): Promise<void> {
  await invoke("snapshot_write", { docKey, content, title, originalPath });
}

export function snapshotList(): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>("snapshot_list");
}

export function snapshotRemove(docKey: string): Promise<void> {
  return invoke("snapshot_remove", { key: docKey });
}

export interface SnapshotContent {
  content: string;
  originalPath: string | null;
  title: string;
  modifiedAtMs: number;
}

export function snapshotRead(key: string): Promise<SnapshotContent> {
  return invoke<SnapshotContent>("snapshot_read", { key });
}

export function readSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("read_settings");
}

export function writeSettings(settings: AppSettings): Promise<void> {
  return invoke("write_settings", { settings });
}

// ---- session (re-open last opened files) ---------------------------------

export interface SessionData {
  paths: string[];
  activePath: string | null;
}

export function sessionSave(paths: string[], activePath: string | null): Promise<void> {
  return invoke("session_save", { paths, activePath });
}

export function sessionLoad(): Promise<SessionData> {
  return invoke<SessionData>("session_load");
}

// ---- system font picker (Windows) ------------------------------------------

export interface FontPick {
  family: string;
  sizePt: number;
}

/** Opens the OS font dialog. Returns null when cancelled. */
export function pickSystemFont(
  currentFamily: string | null,
  currentSizePt: number | null,
): Promise<FontPick | null> {
  return invoke<FontPick | null>("pick_system_font", {
    currentFamily,
    currentSizePt,
  });
}

/** Points to CSS pixels (1pt = 4/3 px @96dpi). */
export function ptToPx(pt: number): number {
  return Math.max(1, Math.round((pt * 4) / 3));
}

// ---- internal performance benchmark (inert unless bench-targets.json exists)

export interface BenchTargets {
  files: string[];
  out: string;
}

/** Returns the bench targets when `settings/bench-targets.json` exists. */
export async function benchTargets(): Promise<BenchTargets | null> {
  try {
    return await invoke<BenchTargets>("bench_targets");
  } catch {
    return null;
  }
}

/** Current process working-set size in KiB. */
export function processMemKb(): Promise<number> {
  return invoke<number>("process_mem_kb");
}

// ---- external-change detection ---------------------------------------------

/** Size/mtime snapshot of a file on disk (used to detect outside edits). */
export function fileStat(path: string): Promise<FileStat> {
  return invoke<FileStat>("file_stat", { path });
}

/** Classifies paths as file / dir / missing (drag & drop filtering). */
export function classifyPaths(paths: string[]): Promise<PathKindInfo[]> {
  return invoke<PathKindInfo[]>("classify_paths", { paths });
}

// ---- launch arguments / second instance ------------------------------------

/** Drains the file paths the app was launched with (Explorer "open with"). */
export function takeLaunchPaths(): Promise<string[]> {
  return invoke<string[]>("take_launch_paths");
}

/** Subscribes to paths forwarded by a second launch (single instance). */
export async function onOpenPaths(cb: (paths: string[]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<string[]>("open-paths", (e) => cb(e.payload));
}

// ---- .md file association (Windows, HKCU only) -----------------------------

export function assocStatus(): Promise<AssocStatus> {
  return invoke<AssocStatus>("assoc_status");
}

export function registerMdAssociation(): Promise<AssocStatus> {
  return invoke<AssocStatus>("register_md_association");
}

export function unregisterMdAssociation(): Promise<AssocStatus> {
  return invoke<AssocStatus>("unregister_md_association");
}

/** Opens the Windows "默认应用" settings page (UserChoice override path). */
export function openDefaultAppsSettings(): Promise<void> {
  return invoke("open_default_apps_settings");
}

// ---- printing --------------------------------------------------------------

/** Stores the printable document for the print window to pick up. */
export function stagePrintDoc(title: string, html: string): Promise<void> {
  return invoke("stage_print_doc", { title, html });
}

/** Takes (and clears) the staged printable document. */
export function takePrintDoc(): Promise<PrintDoc | null> {
  return invoke<PrintDoc | null>("take_print_doc");
}

/** Opens (or focuses) the dedicated print window. */
export function openPrintWindow(): Promise<void> {
  return invoke("open_print_window");
}

export function closePrintWindow(): Promise<void> {
  return invoke("close_print_window");
}
