import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo, selectAll } from "@codemirror/commands";
import {
  openSearchPanel,
  getSearchQuery,
  replaceAll,
  type SearchQuery,
} from "@codemirror/search";
import type { AppSettings, FileReadResult } from "./ipc/commands";
import {
  readSettings,
  writeSettings,
  pickAndReadFile,
  readTextFile,
  pickSavePath,
  writeTextFile,
  pathExists,
  snapshotWrite,
  snapshotList,
  snapshotRead,
  snapshotRemove,
  sessionSave,
  sessionLoad,
  pickSystemFont,
  ptToPx,
  benchTargets,
  processMemKb,
  DEFAULT_SETTINGS,
  fileStat,
  classifyPaths,
  takeLaunchPaths,
  onOpenPaths,
  assocStatus,
  registerMdAssociation,
  unregisterMdAssociation,
  openDefaultAppsSettings,
  stagePrintDoc,
  openPrintWindow,
  type AssocStatus,
} from "./ipc/commands";
import { statsDiffer, type FileStat } from "./files/externalChange";
import { isProbablyBinaryFile, normalizePathList, dropSummary } from "./files/dropPaths";
import {
  buildPrintContent,
  printModesFor,
  type PrintKind,
  type PrintMode,
} from "./print/build";
import { prepareMarkdownPrint } from "./print/prepare";
import { ExternalChangeDialog } from "./components/ExternalChangeDialog";
import { PrintDialog } from "./components/PrintDialog";
import type { TabsState, Tab } from "./tabs/types";
import { tabDirty, tabText, isPreview, isEditor } from "./tabs/types";
import * as store from "./tabs/store";
import { runAutosaveTick } from "./tabs/autosave";
import {
  LARGE_FILE_WARN_BYTES,
  UNLOAD_BIG_CHARS,
  KEEP_LOADED_BIG,
  SESSION_SKIP_BYTES,
  PREVIEW_MAX_CHARS,
} from "./tabs/thresholds";
import {
  languageForFile,
  languageForOverride,
  labelOfOverride,
} from "./editor/languages";
import { builtinTheme, themeFromVscode, type ResolvedTheme } from "./editor/themes";
import { parseVscodeTheme } from "./editor/vscodeTheme";
import type { EditorPrefs } from "./editor/cmCore";
import type { CursorInfo } from "./editor/docBus";
import { EditorHost } from "./components/EditorHost";
import { MenuBar, menuChildList, type MenuGroupDef } from "./components/MenuBar";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { PreviewPane, type PreviewPaneHandle } from "./components/PreviewPane";
import { SettingsModal, firstFamilyOf } from "./components/SettingsModal";
import { CloseConfirm } from "./components/CloseConfirm";
import { InfoDialog, type InfoKind } from "./components/InfoDialog";
import { Modal } from "./components/Modal";
import { viewTabs } from "./components/appState";

const THEME_STORAGE_KEY = "lexora.vscodeThemes.v1";
type StoredThemeMap = Record<string, unknown>;

function loadStoredThemes(): StoredThemeMap {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return typeof v === "object" && v !== null ? (v as StoredThemeMap) : {};
  } catch {
    return {};
  }
}

function persistStoredThemes(map: StoredThemeMap): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

/** Resolves the active ResolvedTheme from settings + imported VS Code themes. */
function resolveTheme(settings: AppSettings, imported: StoredThemeMap): ResolvedTheme {
  if (settings.theme.kind === "vscode") {
    const raw = imported[settings.theme.id];
    const parsed = raw === undefined ? null : parseVscodeTheme(raw);
    if (parsed) return themeFromVscode(parsed);
    return builtinTheme("dark");
  }
  return builtinTheme(settings.theme.id === "dark" ? "dark" : "light");
}

function labelForName(name: string): string {
  const base = name.toLowerCase();
  if (/\.(md|markdown|mdown)$/.test(base)) return "Markdown";
  if (/\.ya?ml$/.test(base)) return "YAML";
  if (/\.toml$/.test(base)) return "TOML";
  if (/\.html?$/.test(base)) return "HTML";
  if (/\.css$/.test(base)) return "CSS";
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) return "JavaScript";
  if (/\.(ts|mts|cts|tsx)$/.test(base)) return "TypeScript";
  if (/\.json$/.test(base)) return "JSON";
  if (/\.(xml|svg)$/.test(base)) return "XML";
  if (/\.rs$/.test(base)) return "Rust";
  if (/\.py$/.test(base)) return "Python";
  if (/\.java$/.test(base)) return "Java";
  if (/\.(c|h)$/.test(base)) return "C";
  if (/\.(cpp|cc|cxx|hpp)$/.test(base)) return "C++";
  if (/\.cs$/.test(base)) return "C#";
  if (/\.go$/.test(base)) return "Go";
  if (/\.sql$/.test(base)) return "SQL";
  if (/\.(sh|bash|zsh)$/.test(base)) return "Shell";
  if (/\.(ps1|psm1)$/.test(base)) return "PowerShell";
  if (/\.php$/.test(base)) return "PHP";
  if (/\.rb$/.test(base)) return "Ruby";
  return "纯文本";
}

/** Document kinds that support preview. */
type PreviewKind = "markdown" | "html";

/** Whether a doc (by filename and/or language override) supports preview, and
 * with which renderer. */
function previewKindOf(title: string, override: string | null): PreviewKind | null {
  const over = (override ?? "").toLowerCase();
  if (over === "markdown") return "markdown";
  if (over === "html" || over === "htm") return "html";
  const t = title.toLowerCase();
  if (/\.(md|markdown|mdown)$/.test(t)) return "markdown";
  if (/\.html?$/.test(t)) return "html";
  return null;
}

/** Escapes a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last path segment of a Windows or POSIX path. */
function baseNameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Counts how many times `query` matches in the editor state's document
 * (used for the replace-all confirmation). Case/whole-word/regexp aware and
 * non-overlapping, mirroring CodeMirror's own matching semantics. */
function countQueryMatches(state: EditorState, query: SearchQuery): number {
  const text = state.doc.toString();
  let needle = query.search;
  if (!query.regexp && !query.literal) {
    needle = needle.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  }
  const body = query.regexp ? needle : escapeRegExp(needle);
  const whole = query.wholeWord
    ? `(?:^|[^\\p{L}\\p{N}_])(${body})(?=$|[^\\p{L}\\p{N}_])`
    : body;
  const flags = `g${query.caseSensitive ? "" : "i"}u`;
  try {
    let count = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _m of text.matchAll(new RegExp(whole, flags))) count++;
    return count;
  } catch {
    return 0; // invalid regexp (query.valid should already have guarded)
  }
}

/** Tauri main-window helper (browser preview resolves to nothing). */
async function withMainWindow<T>(fn: (w: import("@tauri-apps/api/window").Window) => Promise<T>): Promise<T | undefined> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await fn(getCurrentWindow());
  } catch {
    return undefined; // running outside Tauri
  }
}

/** Starts a native window drag (custom title bar, decorations off). */
function startWindowDrag(e: ReactMouseEvent): void {
  if (e.button !== 0) return;
  void withMainWindow((w) => w.startDragging());
}

function minimizeWindow(): void {
  void withMainWindow((w) => w.minimize());
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tabsState, setTabsState] = useState<TabsState>(() => store.emptyState());
  const [importedThemes, setImportedThemes] = useState<StoredThemeMap>(loadStoredThemes);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClose, setConfirmClose] = useState<{ tabId: string } | null>(null);
  const [infoDialog, setInfoDialog] = useState<InfoKind | null>(null);
  const [autosaveText, setAutosaveText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);
  /** Pending "全部替换" confirmation: number of matches that would change. */
  const [replaceConfirmCount, setReplaceConfirmCount] = useState<number | null>(null);
  /** L1: pending confirmation for opening a file above LARGE_FILE_WARN_BYTES. */
  const [bigFileAsk, setBigFileAsk] = useState<{ path: string; read: FileReadResult } | null>(null);
  /** Whether the main window is currently maximized (caption button glyph). */
  const [winMaximized, setWinMaximized] = useState(false);
  /** Brand dropdown (logo + app name click reveals 文件/编辑/帮助). */
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const brandRef = useRef<HTMLDivElement | null>(null);
  /** Paths currently being dragged over the window (drop overlay). */
  const [dropPaths, setDropPaths] = useState<string[]>([]);
  /** Pending "file changed on disk" prompt. */
  const [externalAsk, setExternalAsk] = useState<{
    path: string;
    title: string;
    dirty: boolean;
    stat: FileStat;
  } | null>(null);
  /** Pending print mode choice (Markdown only). */
  const [printAsk, setPrintAsk] = useState<{
    tabId: string;
    title: string;
    kind: PrintKind;
    modes: PrintMode[];
  } | null>(null);
  /** .md association state shown in the settings dialog. */
  const [assoc, setAssoc] = useState<AssocStatus | null>(null);
  /** Last observed on-disk stat per path (baseline for change detection). */
  const diskStatRef = useRef<Map<string, FileStat>>(new Map());
  const externalAskRef = useRef<typeof externalAsk>(null);
  const externalQueueRef = useRef<NonNullable<typeof externalAsk>[]>([]);
  const externalPendingRef = useRef<Set<string>>(new Set());
  /** L1 confirmations queue (several large files dropped at once). */
  const bigAskQueueRef = useRef<{ path: string; read: FileReadResult }[]>([]);
  const bigAskRef = useRef<{ path: string; read: FileReadResult } | null>(null);
  /** True while some other dialog is open (gates new external-change prompts). */
  const modalsBusyRef = useRef(false);

  useEffect(() => {
    if (!brandMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!brandRef.current?.contains(e.target as Node)) setBrandMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBrandMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [brandMenuOpen]);

  const closeBrandMenu = useCallback(() => setBrandMenuOpen(false), []);

  const refreshMaximized = useCallback(async () => {
    const v = await withMainWindow((w) => w.isMaximized());
    if (v !== undefined) setWinMaximized(v);
  }, []);

  /** Track maximize state (caption buttons / double click) so the correct
   * 最大化/还原 glyph shows, including maximize via Aero-snap. */
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (!disposed) await refreshMaximized();
        un = await win.onResized(() => {
          if (!disposed) void refreshMaximized();
        });
      } catch {
        /* browser preview */
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, [refreshMaximized]);

  const onToggleMaximize = useCallback(async () => {
    await withMainWindow((w) => w.toggleMaximize());
    // isMaximized right after toggling can lag one frame; refresh shortly after.
    window.setTimeout(() => void refreshMaximized(), 120);
  }, [refreshMaximized]);

  /** Notices with autoHideMs > 0 dismiss themselves after that time, but only
   * when the currently shown notice is still the same text (a later notice of
   * a different text is never cleared by an expired timer). */
  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((text: string, autoHideMs = 0) => {
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    setNotice(text);
    if (autoHideMs > 0) {
      noticeTimerRef.current = window.setTimeout(() => {
        noticeTimerRef.current = null;
        setNotice((cur) => (cur === text ? null : cur));
      }, autoHideMs);
    }
  }, []);
  useEffect(
    () => () => {
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  /** Files above the L1 threshold are confirmed one at a time; extra ones
   * (e.g. several large files dropped together) wait in a queue. */
  const queueBigFileAsk = useCallback((item: { path: string; read: FileReadResult }) => {
    if (bigAskRef.current) {
      bigAskQueueRef.current.push(item);
      return;
    }
    bigAskRef.current = item;
    setBigFileAsk(item);
  }, []);

  /** Closes the current L1 prompt and shows the next queued one, if any. */
  const shiftBigFileAsk = useCallback(() => {
    const next = bigAskQueueRef.current.shift() ?? null;
    bigAskRef.current = next;
    setBigFileAsk(next);
  }, []);

  const tabsRef = useRef(tabsState);
  tabsRef.current = tabsState;
  const editorViewRef = useRef<EditorView | null>(null);
  const previewHandleRef = useRef<PreviewPaneHandle | null>(null);
  /** Set once the user confirmed quitting so the close request is not
   * intercepted again by the dirty-tab guard. */
  const allowCloseRef = useRef(false);

  const activeTab: Tab | undefined = useMemo(
    () => store.getTab(tabsState, tabsState.activeId),
    [tabsState],
  );

  // Reset the status-bar cursor when the active view is not an editor
  // (preview tab or empty workbench).
  useEffect(() => {
    if (!activeTab || !isEditor(activeTab)) setCursorInfo(null);
  }, [activeTab]);

  // ---- settings boot ---------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const s = await readSettings();
        setSettings(s);
      } catch {
        // Running outside the Tauri runtime (e.g. plain vite): use defaults,
        // with autosave disabled (no snapshot backend in the browser).
        setSettings({
          ...DEFAULT_SETTINGS,
          autosave: { ...DEFAULT_SETTINGS.autosave, enabled: false },
        });
      }
    })();
  }, []);

  // Startup auto-restore is registered right after `restoreSnapshot` below
  // (it must close over that callback's latest definition).

  // ---- session persistence helpers ---------------------------------------
  /** Collects the ordered file paths of open editor tabs + the active one. */
  const collectSession = useCallback(() => {
    const paths: string[] = [];
    let activePath: string | null = null;
    for (const t of tabsRef.current.tabs) {
      if (!isEditor(t) || !t.model.path) continue;
      paths.push(t.model.path);
    }
    const active = store.getTab(tabsRef.current, tabsRef.current.activeId);
    if (active && isEditor(active) && active.model.path) activePath = active.model.path;
    else if (active && isPreview(active) && active.model.sourceTabId) {
      const src = store.getTab(tabsRef.current, active.model.sourceTabId);
      if (src?.model.path) activePath = src.model.path;
    }
    return { paths, activePath };
  }, []);

  /** Persists the open-tab list so the next launch can restore them. */
  const saveSessionNow = useCallback(async () => {
    const { paths, activePath } = collectSession();
    try {
      await sessionSave(paths, activePath);
    } catch {
      /* not in tauri */
    }
  }, [collectSession]);

  // Window close handling: quitting never asks to save. Every close request
  // persists the session, writes a fresh recovery snapshot for every unsaved
  // (dirty) tab, drops stale snapshots of clean tabs, then exits - so nothing
  // is lost and the next launch restores unsaved documents automatically.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      try {
        const win = getCurrentWindow();
        const un = await win.onCloseRequested(async (event) => {
          if (allowCloseRef.current) return; // already exiting: let it close
          event.preventDefault(); // we decide everything below
          await saveSessionNow();
          await syncSnapshotsForExit();
          await forceQuit();
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* browser preview */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Actually closes the window / exits the app. Prefers the Rust
   * exit_app command (guaranteed process exit), then destroy(), then close(). */
  const forceQuit = useCallback(async () => {
    await saveSessionNow();
    allowCloseRef.current = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
      return;
    } catch {
      /* not available (browser preview) */
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      try {
        await win.destroy();
        return;
      } catch {
        // destroy unsupported -> fall back to close()
      }
      await win.close();
    } catch {
      window.close();
    }
  }, [saveSessionNow]);

  /** 文件→退出 / 关窗入口：发起一次真实关闭请求，拦截器按“先自动快照、后退出”
   * 的统一流程处理（不弹保存询问）。 */
  const requestQuit = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      /* browser preview: no-op */
    }
  }, []);

  // ---- derived config ---------------------------------------------------------
  // Memoized on the *field objects actually consumed* (settings.theme /
  // settings.editor), not on the whole settings identity - so updating only
  // recentFiles or layout (every file open via pushRecent, F5 cycling) does
  // NOT re-parse/re-apply the theme or editor prefs.
  const themeChoice: ResolvedTheme = useMemo(
    () => (settings ? resolveTheme(settings, importedThemes) : builtinTheme("light")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings?.theme, importedThemes],
  );
  const themeExt: Extension = themeChoice.cm;
  const palette = themeChoice.palette;

  const prefs: EditorPrefs = useMemo(
    () => ({
      fontFamily: settings?.editor.fontFamily || DEFAULT_SETTINGS.editor.fontFamily,
      fontSize: settings?.editor.fontSize ?? DEFAULT_SETTINGS.editor.fontSize,
      lineHeight: settings?.editor.lineHeight ?? DEFAULT_SETTINGS.editor.lineHeight,
      tabSize: settings?.editor.tabSize ?? DEFAULT_SETTINGS.editor.tabSize,
      wordWrap: settings?.editor.wordWrap ?? DEFAULT_SETTINGS.editor.wordWrap,
      lineNumbers: settings?.editor.lineNumbers ?? DEFAULT_SETTINGS.editor.lineNumbers,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings?.editor],
  );

  // Apply theme / prefs changes to all open tab states.
  useEffect(() => {
    if (!settings) return;
    setTabsState((prev) => store.applyGlobalConfig(prev, themeExt, prefs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeChoice, prefs]);

  // L3: keep at most KEEP_LOADED_BIG "very large" clean tabs resident. Extra
  // very-large clean tabs (never the active one, never a dirty one) are
  // unloaded into lightweight placeholders; they reload on activation.
  useEffect(() => {
    if (!settings) return;
    const loadedBig = tabsState.tabs.filter(
      (t) =>
        isEditor(t) &&
        !t.unloaded &&
        !tabDirty(t) &&
        t.model.path != null &&
        t.cmState.doc.length >= UNLOAD_BIG_CHARS,
    );
    if (loadedBig.length <= KEEP_LOADED_BIG) return;
    let excess = loadedBig.length - KEEP_LOADED_BIG;
    let next: TabsState = tabsState;
    for (const t of loadedBig) {
      // oldest first; keep the active tab resident even if it is very large
      if (excess <= 0) break;
      if (t.model.id === tabsState.activeId) continue;
      next = store.unloadBigTab(next, t.model.id, { theme: themeExt, prefs });
      excess--;
    }
    if (next !== tabsState) setTabsState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsState, settings]);

  // ---- recent files -----------------------------------------------------------
  const pushRecent = useCallback((path: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, recentFiles: [path, ...prev.recentFiles.filter((f) => f !== path)].slice(0, 20) };
      writeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  // ---- open ----------------------------------------------------------------
  /** Opens an already-read file into a tab. `focus=false` opens in the
   * background (L2: keep the current tab on screen for big files). */
  const openLoaded = useCallback(
    async (
      path: string,
      r: FileReadResult,
      focus: boolean,
      opts?: { recent?: boolean },
    ) => {
      const langExt = await languageForFile(path);
      const veryLarge = r.content.length >= UNLOAD_BIG_CHARS;
      setTabsState((prev) => {
        let n = prev;
        // L3 pre-unload: before a very large tab becomes resident, free the
        // oldest resident very-large clean tabs so the resident count never
        // exceeds KEEP_LOADED_BIG even at the peak of this open.
        if (veryLarge) {
          const loaded = prev.tabs.filter(
            (t) =>
              isEditor(t) &&
              !t.unloaded &&
              !tabDirty(t) &&
              t.model.path != null &&
              t.model.id !== prev.activeId &&
              t.cmState.doc.length >= UNLOAD_BIG_CHARS,
          );
          const excess = loaded.length - Math.max(0, KEEP_LOADED_BIG - 1);
          for (let i = 0; i < excess; i++) {
            n = store.unloadBigTab(n, loaded[i].model.id, { theme: themeExt, prefs });
          }
        }
        return store.openFile(n, {
          path,
          diskContent: r.content,
          utf8Ok: r.utf8Ok,
          utf8Bom: r.utf8Bom,
          content: r.content,
          langExt,
          theme: themeExt,
          prefs,
          focus,
          noHistory: veryLarge,
        });
      });
      if (opts?.recent !== false) pushRecent(path);
      // Baseline for the "changed on disk" watcher (best effort).
      void fileStat(path)
        .then((st) => diskStatRef.current.set(path, st))
        .catch(() => {});
    },
    [prefs, themeExt, pushRecent],
  );

  /** Entry for user-triggered opens (dialog / recent list). Files above the
   * L1 threshold ask first; confirming opens them in the background (L2). */
  const openUserFile = useCallback(
    async (path: string) => {
      try {
        const r = await readTextFile(path);
        if (r.byteLen > LARGE_FILE_WARN_BYTES) {
          queueBigFileAsk({ path, read: r });
          return;
        }
        await openLoaded(path, r, true);
      } catch (e) {
        setNotice(`打开失败：${e}`);
      }
    },
    [openLoaded, queueBigFileAsk],
  );

  const onOpen = useCallback(async () => {
    const picked = await pickAndReadFile();
    if (!picked) return;
    if ("read" in picked) {
      if (picked.read.byteLen > LARGE_FILE_WARN_BYTES) {
        queueBigFileAsk({ path: picked.path, read: picked.read });
        return;
      }
      await openLoaded(picked.path, picked.read, true);
      return;
    }
    const reason = "error" in picked ? `：${picked.error}` : "";
    setNotice(`读取 ${picked.path} 失败${reason}`);
  }, [openLoaded, queueBigFileAsk]);

  const confirmOpenBig = useCallback(() => {
    const ask = bigAskRef.current;
    shiftBigFileAsk();
    if (!ask) return;
    void openLoaded(ask.path, ask.read, false).then(() => {
      showNotice(`已在后台打开大文件（未切换标签）：${ask.path.split(/[\\/]/).pop()}`);
    });
  }, [openLoaded, shiftBigFileAsk, showNotice]);

  const onNew = useCallback(() => {
    setTabsState((prev) => store.newUntitled(prev, { theme: themeExt, prefs }));
  }, [prefs, themeExt]);

  // ---- drag & drop -----------------------------------------------------------
  /** Opens files dropped onto the window (folders and obvious binaries are
   * ignored with a notice). */
  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      const list = normalizePathList(paths);
      if (!list.length) return;
      let existing: string[] = list;
      try {
        const infos = await classifyPaths(list);
        existing = infos.filter((i) => i.kind === "file").map((i) => i.path);
      } catch {
        /* not in tauri: fall back to the raw list */
      }
      const openable = existing.filter((p) => !isProbablyBinaryFile(baseNameOf(p)));
      const skipped = list.length - openable.length;
      if (skipped > 0) showNotice(`已忽略 ${skipped} 个文件夹或非文本文件`, 4000);
      for (const p of openable) await openUserFile(p);
    },
    [openUserFile, showNotice],
  );

  useEffect(() => {
    let un: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const u = await getCurrentWebview().onDragDropEvent((ev) => {
          const payload = ev.payload;
          // "over" only carries a position; "enter" is the payload with paths.
          if (payload.type === "over") return;
          if (payload.type === "enter") {
            setDropPaths(normalizePathList(payload.paths));
            return;
          }
          setDropPaths([]);
          if (payload.type === "drop") void handleDroppedPaths(payload.paths);
        });
        if (disposed) u();
        else un = u;
      } catch {
        /* browser preview: no native drag events */
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, [handleDroppedPaths]);

  // ---- files handed to the app from outside ----------------------------------
  /** Opens files passed on the command line (Explorer "打开方式") or
   * forwarded by a second launch. */
  const openLaunchPaths = useCallback(
    async (paths: string[]) => {
      const list = normalizePathList(paths);
      if (!list.length) return;
      for (const p of list) await openUserFile(p);
      showNotice(`已打开外部传入的 ${list.length} 个文件`, 4000);
    },
    [openUserFile, showNotice],
  );

  useEffect(() => {
    let un: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      try {
        const u = await onOpenPaths((paths) => void openLaunchPaths(paths));
        if (disposed) u();
        else un = u;
      } catch {
        /* browser preview */
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, [openLaunchPaths]);

  // ---- external modification detection ---------------------------------------
  /** Polls the on-disk stat of every open file and queues a reload prompt when
   * it changed outside Lexora. The observed stat becomes the new baseline as
   * soon as it is reported, so a single change prompts exactly once. */
  const checkExternalChanges = useCallback(async () => {
    const paths = new Set<string>();
    for (const t of tabsRef.current.tabs) {
      if (isEditor(t) && !t.unloaded && t.model.path) paths.add(t.model.path);
    }
    for (const p of paths) {
      let st: FileStat;
      try {
        st = await fileStat(p);
      } catch {
        continue;
      }
      const recorded = diskStatRef.current.get(p) ?? null;
      if (!statsDiffer(recorded, st)) continue;
      diskStatRef.current.set(p, st);
      if (externalPendingRef.current.has(p)) continue;
      const tab = store.findByPath(tabsRef.current, p);
      if (!tab) continue;
      externalPendingRef.current.add(p);
      const item = { path: p, title: tab.model.title, dirty: tabDirty(tab), stat: st };
      if (externalAskRef.current || modalsBusyRef.current) {
        externalQueueRef.current.push(item);
      } else {
        externalAskRef.current = item;
        setExternalAsk(item);
      }
    }
  }, []);

  useEffect(() => {
    if (!settings) return;
    if (settings.files?.watchExternal === false) return;
    const timer = window.setInterval(() => void checkExternalChanges(), 3000);
    return () => window.clearInterval(timer);
  }, [settings, checkExternalChanges]);

  /** While another dialog is open, change prompts wait in the queue instead of
   * stacking on top of it. */
  const modalsBusy = Boolean(
    showSettings || infoDialog || confirmClose || replaceConfirmCount != null || bigFileAsk || printAsk,
  );
  modalsBusyRef.current = modalsBusy;
  useEffect(() => {
    if (modalsBusyRef.current || externalAskRef.current) return;
    const next = externalQueueRef.current.shift();
    if (next) {
      externalAskRef.current = next;
      setExternalAsk(next);
    }
  }, [modalsBusy, externalAsk]);

  /** Answers the current "changed on disk" prompt (and shows the next one). */
  const resolveExternalAsk = useCallback(
    async (reload: boolean) => {
      const ask = externalAskRef.current;
      const next = externalQueueRef.current.shift() ?? null;
      externalAskRef.current = next;
      setExternalAsk(next);
      if (!ask) return;
      externalPendingRef.current.delete(ask.path);
      if (!reload) {
        showNotice(`已保留当前内容：${ask.title}`, 3000);
        return;
      }
      const tab = store.findByPath(tabsRef.current, ask.path);
      if (!tab) return;
      try {
        const r = await readTextFile(ask.path);
        const override = tab.model.languageOverride;
        const langExt = override
          ? await languageForOverride(override)
          : await languageForFile(ask.path);
        const veryLarge = r.content.length >= UNLOAD_BIG_CHARS;
        setTabsState((prev) =>
          store.reloadBigTab(prev, tab.model.id, {
            path: ask.path,
            diskContent: r.content,
            utf8Ok: r.utf8Ok,
            utf8Bom: r.utf8Bom,
            content: r.content,
            langExt,
            theme: themeExt,
            prefs,
            noHistory: veryLarge,
          }),
        );
        const st = await fileStat(ask.path);
        diskStatRef.current.set(ask.path, st);
        try {
          await snapshotRemove(tab.model.docKey);
        } catch {
          /* no snapshot: fine */
        }
        showNotice(`已从磁盘重新加载：${ask.title}`, 4000);
      } catch (e) {
        setNotice(`重新加载失败：${e}`);
      }
    },
    [prefs, themeExt, showNotice],
  );

  // ---- printing ---------------------------------------------------------------
  /** Editor tab that print acts on (a preview tab resolves to its source). */
  const printSource = useMemo(() => {
    if (!activeTab) return undefined;
    if (isPreview(activeTab)) {
      return activeTab.model.sourceTabId
        ? store.getTab(tabsState, activeTab.model.sourceTabId)
        : undefined;
    }
    return isEditor(activeTab) ? activeTab : undefined;
  }, [activeTab, tabsState]);

  /** Stages the printable document and opens the dedicated print window. */
  const runPrint = useCallback(
    async (tabId: string, kind: PrintKind, mode: PrintMode) => {
      const tab = store.getTab(tabsRef.current, tabId);
      if (!tab || !isEditor(tab)) return;
      const text = tabText(tab);
      const title = `${store.stem(tab.model.title)} - 打印`;
      try {
        const renderedHtml =
          kind === "markdown" && mode === "preview"
            ? await prepareMarkdownPrint(text, tab.model.path)
            : undefined;
        const content = buildPrintContent({ kind, mode, title, renderedHtml, text });
        await stagePrintDoc(content.title, content.html);
        await openPrintWindow();
      } catch (e) {
        setNotice(`打印失败：${e}`);
      }
    },
    [],
  );

  /** 文件→打印：Markdown 先让用户选择“预览版 / 原始文本”，其它文本直接打印原文。 */
  const requestPrint = useCallback(() => {
    const tab = printSource;
    if (!tab) {
      setNotice("当前没有可打印的文档。");
      return;
    }
    const kind: PrintKind =
      previewKindOf(tab.model.title, tab.model.languageOverride) ?? "text";
    const modes = printModesFor(kind);
    if (modes.length <= 1) {
      void runPrint(tab.model.id, kind, modes[0]);
      return;
    }
    setPrintAsk({ tabId: tab.model.id, title: tab.model.title, kind, modes });
  }, [printSource, runPrint]);

  // ---- .md file association (Windows) ----------------------------------------
  const refreshAssoc = useCallback(async () => {
    try {
      setAssoc(await assocStatus());
    } catch {
      setAssoc(null);
    }
  }, []);

  useEffect(() => {
    if (showSettings) void refreshAssoc();
  }, [showSettings, refreshAssoc]);

  const onAssocRegister = useCallback(async () => {
    setAssoc(await registerMdAssociation());
    showNotice("已注册为 .md 默认打开方式（若系统已指定用户选择，请在 Windows 默认应用中确认）", 6000);
  }, [showNotice]);

  const onAssocUnregister = useCallback(async () => {
    setAssoc(await unregisterMdAssociation());
    showNotice("已取消 .md 关联注册", 4000);
  }, [showNotice]);

  const onOpenDefaultApps = useCallback(async () => {
    await openDefaultAppsSettings();
  }, []);

  /** Activates a tab; an unloaded very-large tab is reloaded from disk first
   * (L3) with a short "正在加载…" hint. */
  const onActivate = useCallback(
    async (id: string) => {
      const tab = store.getTab(tabsRef.current, id);
      if (tab && isEditor(tab) && tab.unloaded && tab.model.path) {
        const path = tab.model.path;
        setAutosaveText(`正在加载大文件：${tab.model.title}…`);
        try {
          const r = await readTextFile(path);
          const override = tab.model.languageOverride;
          const langExt = override
            ? await languageForOverride(override)
            : await languageForFile(path);
          const veryLarge = r.content.length >= UNLOAD_BIG_CHARS;
          setTabsState((prev) => {
            const next = store.reloadBigTab(prev, id, {
              path,
              diskContent: r.content,
              utf8Ok: r.utf8Ok,
              utf8Bom: r.utf8Bom,
              content: r.content,
              langExt,
              theme: themeExt,
              prefs,
              noHistory: veryLarge,
            });
            return store.setActive(next, id);
          });
          setAutosaveText("");
          return;
        } catch (e) {
          setAutosaveText("");
          setNotice(`加载失败：${e}`);
          return;
        }
      }
      setTabsState((prev) => store.setActive(prev, id));
    },
    [prefs, themeExt],
  );

  /** Active editable tab id (preview tabs resolve to their source). */
  const activeEditorId = useMemo(() => {
    if (!activeTab) return null;
    if (isEditor(activeTab)) return activeTab.model.id;
    return activeTab.model.sourceTabId;
  }, [activeTab]);

  // ---- save ------------------------------------------------------------------
  const saveTabById = useCallback(
    async (id: string | null, forcePick: boolean): Promise<boolean> => {
      if (!id) return false;
      const tab = store.getTab(tabsRef.current, id);
      if (!tab || !isEditor(tab)) return false;
      const content = tabText(tab);
      let target = forcePick ? null : tab.model.path;
      if (!target) {
        target = await pickSavePath(tab.model.path ?? `${tab.model.title}.md`);
        if (!target) return false;
      }
      const sameFile = target === tab.model.path;
      // Non-UTF-8 originals were lossily decoded on open; overwriting them in
      // place would destroy the original bytes. Refuse and guide to Save As.
      if (!tab.model.utf8Ok && sameFile && !forcePick) {
        setNotice("原文件不是 UTF-8 编码：为避免覆盖损坏，请用「另存为」转存为 UTF-8 文件。");
        return false;
      }
      // Re-add the UTF-8 BOM when saving over the BOM'd file in place.
      const text = sameFile && tab.model.utf8Bom ? `\uFEFF${content}` : content;
      try {
        await writeTextFile(target, text);
      } catch (e) {
        setNotice(`保存失败：${e}`);
        return false;
      }
      const oldKey = tab.model.docKey;
      const newBom = sameFile && tab.model.utf8Bom;
      setTabsState((prev) => store.markSaved(prev, tab.model.id, target, content, newBom));
      // 另存为后按新文件名重新识别语言，避免新建文件存为 .md 后仍是纯文本。
      if (!tab.model.languageOverride) {
        const langExt = await languageForFile(target);
        setTabsState((prev) => store.applyLanguage(prev, tab.model.id, langExt));
      }
      // New baseline for the external-change watcher (we wrote this ourselves).
      void fileStat(target)
        .then((st) => diskStatRef.current.set(target, st))
        .catch(() => {});
      // Awaited so the stale snapshot is gone before the process can exit
      // (prevents resurrecting older content on the next launch).
      try {
        await snapshotRemove(oldKey);
      } catch {
        /* ignore */
      }
      if (target !== oldKey) pushRecent(target);
      return true;
    },
    [pushRecent],
  );

  const onSave = useCallback(async () => {
    await saveTabById(activeEditorId, false);
  }, [activeEditorId, saveTabById]);

  const onSaveAs = useCallback(async () => {
    await saveTabById(activeEditorId, true);
  }, [activeEditorId, saveTabById]);

  // ---- preview ---------------------------------------------------------------
  /** 'markdown' | 'html' | null for the active editor tab (preview gating). */
  const activePreviewKind = useMemo(
    () =>
      activeTab && isEditor(activeTab)
        ? previewKindOf(activeTab.model.title, activeTab.model.languageOverride)
        : null,
    [activeTab],
  );

  const onPreview = useCallback(() => {
    if (!activePreviewKind || !activeTab) return;
    setTabsState((prev) =>
      store.openPreview(prev, { sourceTabId: activeTab.model.id, theme: themeExt, prefs }),
    );
  }, [activePreviewKind, activeTab, prefs, themeExt]);

  // ---- closing -------------------------------------------------------------
  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = store.getTab(tabsRef.current, tabId);
      if (!tab) return;
      if (isEditor(tab) && tabDirty(tab)) setConfirmClose({ tabId });
      else {
        // Closing a clean tab: drop any stale recovery snapshot so content the
        // user undid (or emptied) can't resurrect on the next launch.
        if (isEditor(tab) && tab.model.docKey && tab.lastSnapshotContent != null) {
          snapshotRemove(tab.model.docKey).catch(() => {});
        }
        setTabsState((prev) => store.closeTab(prev, tabId));
      }
    },
    [],
  );

  const doDiscardAndClose = useCallback(async (ids: string[]) => {
    for (const id of ids) {
      const tab = store.getTab(tabsRef.current, id);
      if (tab && isEditor(tab)) {
        try {
          await snapshotRemove(tab.model.docKey);
        } catch {
          /* ignore */
        }
      }
    }
    setTabsState((prev) => ids.reduce((acc, id) => store.closeTab(acc, id), prev));
  }, []);

  /** Persists a fresh snapshot for every dirty editor tab and drops stale
   * snapshots of clean tabs (used when quitting without saving, so the next
   * launch restores exactly the current unsaved state - nothing more). */
  const syncSnapshotsForExit = useCallback(async () => {
    for (const tab of tabsRef.current.tabs) {
      if (!isEditor(tab)) continue;
      const docKey = tab.model.docKey;
      if (!docKey) continue;
      if (tabDirty(tab)) {
        const content = tabText(tab);
        try {
          await snapshotWrite(docKey, content, tab.model.title, tab.model.path);
        } catch {
          /* keep going; next launch may use an older snapshot */
        }
      } else if (tab.lastSnapshotContent != null) {
        try {
          await snapshotRemove(docKey);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const resolveClose = useCallback(
    async (saveFirst: boolean) => {
      const c = confirmClose;
      if (!c) return;
      setConfirmClose(null);
      // ---- closing one tab ----
      if (saveFirst) {
        const ok = await saveTabById(c.tabId, false);
        if (!ok) return;
        setTabsState((prev) => store.closeTab(prev, c.tabId));
      } else {
        // 不保存并关闭：删除该标签快照后关闭。
        await doDiscardAndClose([c.tabId]);
      }
    },
    [confirmClose, saveTabById, doDiscardAndClose],
  );

  // ---- doc change routing -----------------------------------------------------
  const onDocChange = useCallback((tabId: string, state: EditorState) => {
    setTabsState((prev) => store.replaceCmState(prev, tabId, state));
  }, []);

  const onCursorChange = useCallback((_tabId: string, cursor: CursorInfo) => {
    setCursorInfo(cursor);
  }, []);

  // ---- split-view scroll sync ---------------------------------------------
  /** Editor scrolled: mirror the top source line into the preview. */
  const onEditorViewportLine = useCallback((line: number) => {
    if (previewHandleRef.current) previewHandleRef.current.scrollToSourceLine(line);
  }, []);

  /** Preview scrolled: scroll the editor so the same source line is at top. */
  const onPreviewScrollLine = useCallback((line: number) => {
    const view = editorViewRef.current;
    if (!view) return;
    try {
      const pos = view.state.doc.line(line).from;
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    } catch {
      /* line out of range */
    }
  }, []);

  // ---- autosave -------------------------------------------------------------
  useEffect(() => {
    if (!settings?.autosave.enabled) return;
    const ms = Math.max(1000, settings.autosave.intervalSec * 1000);
    const timer = window.setInterval(async () => {
      const { snapshotted, errors } = await runAutosaveTick(tabsRef.current, (key, content, title, orig) =>
        snapshotWrite(key, content, title, orig),
      );
      if (errors.length) setAutosaveText(`自动保存出错：${errors[0]}`);
      if (snapshotted.length) {
        setTabsState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) => {
            const hit = snapshotted.find((s) => s.docKey === t.model.docKey);
            return hit ? { ...t, lastSnapshotContent: hit.content } : t;
          }),
        }));
        setAutosaveText(`已自动保存快照 ${snapshotted.length} 个 · ${new Date().toLocaleTimeString()}`);
      }
    }, ms);
    return () => window.clearInterval(timer);
  }, [settings?.autosave.enabled, settings?.autosave.intervalSec]);

  // ---- edit-menu helpers --------------------------------------------------------
  const runEditorCommand = useCallback((cmd: "undo" | "redo" | "selectAll" | "cut" | "copy" | "paste") => {
    const view = editorViewRef.current;
    if (!view) return;
    view.focus();
    if (cmd === "undo") undo(view);
    else if (cmd === "redo") redo(view);
    else if (cmd === "selectAll") selectAll(view);
    else {
      // Clipboard ops go through the native contenteditable path.
      try {
        document.execCommand(cmd === "cut" ? "cut" : cmd === "copy" ? "copy" : "paste");
      } catch {
        /* clipboard may be blocked; ignore */
      }
    }
  }, []);

  // ---- find / replace -------------------------------------------------------
  /** Opens the CodeMirror search panel and focuses the given field. */
  const focusSearchField = useCallback((which: "find" | "replace") => {
    const view = editorViewRef.current;
    if (!view) return;
    view.focus();
    openSearchPanel(view);
    requestAnimationFrame(() => {
      const input = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${which}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  const onFind = useCallback(() => focusSearchField("find"), [focusSearchField]);
  const onReplace = useCallback(() => focusSearchField("replace"), [focusSearchField]);

  /** 全部替换：先统计匹配数弹确认（替换会改动文档且不可轻易撤销），再执行。 */
  const requestReplaceAll = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.focus();
    openSearchPanel(view); // ensures the search extension/state is installed
    const query = getSearchQuery(view.state);
    if (!query || !query.search || !query.valid) {
      setNotice("请先在查找框中输入要替换的内容。");
      return;
    }
    const count = countQueryMatches(view.state, query);
    if (count === 0) {
      setNotice("没有找到匹配内容。");
      return;
    }
    setReplaceConfirmCount(count);
  }, []);

  const confirmReplaceAll = useCallback(() => {
    const n = replaceConfirmCount;
    setReplaceConfirmCount(null);
    const view = editorViewRef.current;
    if (!view) return;
    replaceAll(view);
    setNotice(`已全部替换 ${n} 处。`);
  }, [replaceConfirmCount]);

  // The CodeMirror panel's built-in "全部替换" button performs an immediate
  // replace-all; intercept it (capture phase, before CM's own handler) so it
  // goes through the same count + confirm flow as the menu item.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('button[name="replaceAll"]');
      const view = editorViewRef.current;
      if (btn && view && view.dom.contains(btn)) {
        e.preventDefault();
        e.stopPropagation();
        requestReplaceAll();
      }
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, [requestReplaceAll]);

  // ---- shortcuts ------------------------------------------------------------
  const cycleLayout = useCallback(() => {
    setSettings((prev) => {
      if (!prev) return prev;
      const order = ["edit", "split", "preview"] as const;
      const cur = order.indexOf(prev.layout as (typeof order)[number]);
      const layout = order[(cur + 1) % order.length];
      const next = { ...prev, layout };
      writeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const k = e.key.toLowerCase();
      // While a modal is open, editor/app shortcuts must not fire on the tab
      // underneath it (e.g. Ctrl+W closing a tab below the settings dialog).
      if (showSettings || infoDialog || confirmClose || replaceConfirmCount != null || bigFileAsk || printAsk || externalAsk) return;
      if (mod && k === "s") {
        e.preventDefault();
        if (e.shiftKey) void onSaveAs();
        else void onSave();
      } else if (mod && k === "o") {
        e.preventDefault();
        void onOpen();
      } else if (mod && k === "n" && !inField) {
        e.preventDefault();
        onNew();
      } else if (mod && k === "w") {
        e.preventDefault();
        if (tabsRef.current.activeId) requestCloseTab(tabsRef.current.activeId);
      } else if (mod && k === ",") {
        e.preventDefault();
        setShowSettings(true);
      } else if (mod && k === "p") {
        e.preventDefault();
        if (e.shiftKey) requestPrint();
        else if (activePreviewKind) onPreview();
      } else if (mod && k === "f") {
        // Ctrl+F: open the search panel. Inside the editor (or its panel) the
        // CodeMirror keymap already handles it - only route when focus is
        // elsewhere (menu/status bar) so the shortcut works app-wide.
        const view = editorViewRef.current;
        const active = tabsRef.current.activeId
          ? store.getTab(tabsRef.current, tabsRef.current.activeId)
          : undefined;
        const ae = document.activeElement as HTMLElement | null;
        const focusInsideCm = !!view && !!ae && (view.dom.contains(ae) || !!ae.closest(".cm-search"));
        if (view && active && isEditor(active) && !focusInsideCm) {
          e.preventDefault();
          onFind();
        }
      } else if (e.key === "F5") {
        e.preventDefault();
        cycleLayout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    requestCloseTab,
    cycleLayout,
    activePreviewKind,
    onPreview,
    requestPrint,
    onFind,
    showSettings,
    infoDialog,
    confirmClose,
    replaceConfirmCount,
    bigFileAsk,
    printAsk,
    externalAsk,
  ]);

  // ---- language override -------------------------------------------------------
  const onLanguageChange = useCallback(async (key: string) => {
    const tab = store.getTab(tabsRef.current, tabsRef.current.activeId);
    if (!tab || !isEditor(tab)) return;
    const override = key === "auto" ? null : key;
    const langExt = override
      ? await languageForOverride(override)
      : await languageForFile(tab.model.title);
    const id = tab.model.id;
    setTabsState((prev) => {
      let next = store.applyLanguage(prev, id, langExt);
      next = store.setLangOverride(next, id, override, langExt);
      return next;
    });
  }, []);

  // ---- system font picking (used by settings) ---------------------------------
  const pickFontFor = useCallback(
    async (current: AppSettings, which: "editor" | "preview") => {
      const cur = which === "editor" ? current.editor : current.preview;
      const pick = await pickSystemFont(firstFamilyOf(cur.fontFamily), (cur.fontSize * 3) / 4);
      if (!pick) return null;
      return { family: pick.family, sizePx: ptToPx(pick.sizePt) };
    },
    [],
  );

  // ---- save settings and close the settings dialog ----------------------------
  // "保存并退出" here means: persist settings, then leave the settings page.
  // It does NOT quit the application.
  const saveSettingsAndQuit = useCallback(
    (s: AppSettings) => {
      setSettings(s);
      setShowSettings(false);
      writeSettings(s).catch(() => {});
    },
    [],
  );

  // ---- VS Code theme import -------------------------------------------------
  const importVscodeTheme = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "VS Code 主题", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    const text = (await readTextFile(picked)).content;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("不是合法 JSON 文件");
    }
    const parsed = parseVscodeTheme(raw);
    if (!parsed) throw new Error("主题文件缺少 name / type / tokenColors 字段");
    const id = `vscode:${parsed.name.trim() || "imported"}`;
    setImportedThemes((prev) => {
      const next = { ...prev, [id]: raw };
      persistStoredThemes(next);
      return next;
    });
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, theme: { kind: "vscode" as const, id } };
      writeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  /** Removes an imported VS Code theme. If it was the active theme, falls
   * back to the built-in light theme and persists that switch. */
  const deleteVscodeTheme = useCallback((id: string) => {
    setImportedThemes((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      persistStoredThemes(next);
      return next;
    });
    setSettings((prev) => {
      if (!prev || !(prev.theme.kind === "vscode" && prev.theme.id === id)) return prev;
      const next = { ...prev, theme: { kind: "builtin" as const, id: "light" as const } };
      writeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  // ---- recovery handlers ------------------------------------------------------
  const restoreSnapshot = useCallback(
    async (key: string) => {
      try {
        const snap = await snapshotRead(key);
        const originalPath = snap.originalPath;
        if (originalPath) {
          const existing = store.findByPath(tabsRef.current, originalPath);
          if (existing) {
            // The file is already open (session reopen or a previous restore):
            // drop the snapshot so it stops being offered on every launch.
            try {
              await snapshotRemove(key);
            } catch {
              /* ignore */
            }
            setNotice(`“${existing.model.title}” 已打开，未恢复该快照`);
            return;
          }
        }

        let restoredPath: string | null = null;
        let diskContent = "";
        let diskBom = false;
        if (originalPath) {
          try {
            if (await pathExists(originalPath)) {
              const disk = await readTextFile(originalPath);
              restoredPath = originalPath;
              diskContent = disk.content;
              diskBom = disk.utf8Bom;
            }
          } catch {
            restoredPath = null;
          }
        }

        if (restoredPath) {
          const langExt = await languageForFile(restoredPath);
          setTabsState((prev) =>
            store.openFile(prev, {
              path: restoredPath,
              diskContent,
              utf8Ok: true,
              utf8Bom: diskBom,
              content: snap.content,
              langExt,
              theme: themeExt,
              prefs,
            }),
          );
        } else {
          const langExt = await languageForFile(snap.title);
          setTabsState((prev) => {
            const next = store.newUntitled(prev, { theme: themeExt, prefs, content: snap.content });
            const id = next.activeId!;
            return store.applyLanguage(next, id, langExt);
          });
        }
        await snapshotRemove(key);
      } catch (e) {
        setNotice(`恢复失败：${e}`);
      }
    },
    [prefs, themeExt],
  );

  // Startup: automatically restore snapshots left behind by an unsaved quit
  // or a crash. Each snapshot reopens as a tab whose content = snapshot and
  // whose disk anchor = the file's current on-disk content (manual save is
  // still required to write it back).
  // 启动恢复必须在 settings 加载完成之后执行（gate 在 `settings` 上）：恢复的
  // 标签要用真实的主题/字体，且 session 激活、默认新建标签等收尾逻辑不能因
  // settings 提交导致的 effect 清理（cancelled）而被跳过。
  const startupRestoreDone = useRef(false);
  /** Command-line / "open with" files are opened exactly once per launch. */
  const launchPathsHandledRef = useRef(false);
  useEffect(() => {
    if (!settings) return; // wait for the settings boot
    if (startupRestoreDone.current) return;
    startupRestoreDone.current = true;
    let cancelled = false;
    (async () => {
      // ---- internal performance benchmark (only when bench-targets.json exists)
      try {
        const bt = await benchTargets();
        if (bt && bt.files.length > 0) {
          const rows: Array<{
            count: number;
            openMs: number;
            readMs: number;
            memKb: number;
            chars: number;
          }> = [];
          const startedAt = performance.now();
          for (let i = 0; i < bt.files.length; i++) {
            const p = bt.files[i];
            const t0 = performance.now();
            try {
              // phase 1: read + decode over IPC
              const r = await readTextFile(p);
              const readMs = performance.now() - t0;
              // phase 2+3: real product open path (lang + state + L3 pre-unload)
              await openLoaded(p, r, true, { recent: false });
              // Give React + CodeMirror time to mount the new tab.
              await new Promise((res) => setTimeout(res, 400));
              const memKb = await processMemKb();
              rows.push({
                count: i + 1,
                openMs: Math.round(performance.now() - t0),
                readMs: Math.round(readMs),
                memKb,
                chars: r.content.length,
              });
            } catch (e) {
              rows.push({
                count: i + 1,
                openMs: Math.round(performance.now() - t0),
                readMs: 0,
                memKb: 0,
                chars: 0,
              });
            }
            try {
              await writeTextFile(bt.out, JSON.stringify({
                elapsedMs: Math.round(performance.now() - startedAt),
                rows,
              }, null, 2));
            } catch {
              /* ignore */
            }
          }
          setAutosaveText(`基准测试：已完成 ${rows.length} 个文件`);
          setNotice(`基准测试完成：依次打开 ${rows.length} 个约 100MB 的 markdown 文件`);
          return;
        }
      } catch {
        /* not in tauri / no targets: normal startup */
      }
      try {
        const items = await snapshotList();
        if (items.length) {
          for (const item of items) {
            try {
              await restoreSnapshot(item.key);
            } catch {
              /* skip broken snapshot */
            }
          }
          if (!cancelled) {
            showNotice(
              `已从上次会话自动恢复 ${items.length} 个未保存文档（仍为未保存状态）`,
              5000,
            );
          }
        }
      } catch {
        /* not in tauri */
      }
      // Re-open the files that were open at last exit (session). Existing
      // tabs from snapshot restore are kept (openFile dedupes by path).
      // L1: files above SESSION_SKIP_BYTES are skipped to keep startup fast.
      try {
        const session = await sessionLoad();
        let skippedBig = 0;
        if (session.paths.length) {
          for (const p of session.paths) {
            try {
              const rr = await readTextFile(p);
              if (rr.byteLen > SESSION_SKIP_BYTES) {
                skippedBig++;
                continue;
              }
              await openLoaded(p, rr, true);
            } catch {
              /* file gone / unreadable: skip */
            }
          }
        }
        if (session.activePath && !cancelled) {
          const t = store.findByPath(tabsRef.current, session.activePath);
          if (t) setTabsState((prev) => store.setActive(prev, t.model.id));
        }
        if (skippedBig > 0 && !cancelled) {
          showNotice(`已跳过 ${skippedBig} 个超大文件（≥${SESSION_SKIP_BYTES / 1048576}MB），可在菜单中手动打开`, 6000);
        }
      } catch {
        /* not in tauri */
      }
      // Files handed to this launch from outside (Explorer "打开方式", CLI arg).
      // Deliberately NOT gated on `cancelled`: restoring tabs pushes recent
      // files, which updates `settings` and therefore re-runs this effect's
      // cleanup (cancelling the in-flight body) before the command-line files
      // would be opened. A ref keeps it strictly once.
      if (!launchPathsHandledRef.current) {
        launchPathsHandledRef.current = true;
        try {
          const pending = await takeLaunchPaths();
          if (pending.length) await openLaunchPaths(pending);
        } catch {
          /* not in tauri */
        }
      }
      // 启动后若仍没有任何标签页（既无打开文件也无快照恢复），默认新建一个
      // 未命名标签并进入编辑模式。函数式更新保证只在标签列表为空时创建。
      if (!cancelled) {
        setTabsState((prev) =>
          prev.tabs.length === 0
            ? store.newUntitled(prev, { theme: themeExt, prefs })
            : prev,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, restoreSnapshot]);

  // ---- menu bar ---------------------------------------------------------------
  const layout = settings?.layout ?? "edit";
  const activeIsPreviewTab = activeTab ? isPreview(activeTab) : false;
  // The CodeMirror view is mounted when the active tab is an editor and the
  // layout keeps the editor visible (edit/split). Used to enable Edit-menu cmds.
  const hasMountedEditor = Boolean(activeTab && isEditor(activeTab) && layout !== "preview");

  const menuGroups: MenuGroupDef[] = useMemo(() => {
    const hasActiveEditor = Boolean(activeEditorId);
    return [
      {
        key: "file",
        label: "文件",
        items: [
          { type: "item", label: "新建标签", shortcut: "Ctrl+N", onAction: onNew },
          { type: "item", label: "打开…", shortcut: "Ctrl+O", onAction: () => void onOpen() },
          {
            type: "item",
            label: "最近打开",
            children: menuChildList(
              (settings?.recentFiles ?? []).map((f) => ({
                label: f,
                onClick: () => void openUserFile(f),
              })),
            ),
          },
          { type: "sep" },
          { type: "item", label: "保存", shortcut: "Ctrl+S", disabled: !hasActiveEditor, onAction: () => void onSave() },
          {
            type: "item",
            label: "另存为…",
            shortcut: "Ctrl+Shift+S",
            disabled: !hasActiveEditor,
            onAction: () => void onSaveAs(),
          },
          { type: "sep" },
          {
            type: "item",
            label: activePreviewKind === "html" ? "预览 HTML" : "预览 Markdown",
            shortcut: "Ctrl+P",
            disabled: !activePreviewKind,
            onAction: onPreview,
          },
          {
            type: "item",
            label: "打印…",
            shortcut: "Ctrl+Shift+P",
            disabled: !printSource,
            onAction: requestPrint,
          },
          { type: "sep" },
          {
            type: "item",
            label: "退出",
            danger: true,
            onAction: () => void requestQuit(),
          },
        ],
      },
      {
        key: "edit",
        label: "编辑",
        items: [
          { type: "item", label: "撤销", shortcut: "Ctrl+Z", disabled: !hasMountedEditor, onAction: () => runEditorCommand("undo") },
          { type: "item", label: "重做", shortcut: "Ctrl+Y", disabled: !hasMountedEditor, onAction: () => runEditorCommand("redo") },
          { type: "sep" },
          { type: "item", label: "剪切", shortcut: "Ctrl+X", disabled: !hasMountedEditor, onAction: () => runEditorCommand("cut") },
          { type: "item", label: "复制", shortcut: "Ctrl+C", disabled: !hasMountedEditor, onAction: () => runEditorCommand("copy") },
          { type: "item", label: "粘贴", shortcut: "Ctrl+V", disabled: !hasMountedEditor, onAction: () => runEditorCommand("paste") },
          { type: "item", label: "全选", shortcut: "Ctrl+A", disabled: !hasMountedEditor, onAction: () => runEditorCommand("selectAll") },
          { type: "sep" },
          { type: "item", label: "查找…", shortcut: "Ctrl+F", disabled: !hasMountedEditor, onAction: onFind },
          { type: "item", label: "替换…", disabled: !hasMountedEditor, onAction: onReplace },
          { type: "item", label: "全部替换…", disabled: !hasMountedEditor, onAction: requestReplaceAll },
          { type: "sep" },
          { type: "item", label: "设置…", shortcut: "Ctrl+,", onAction: () => setShowSettings(true) },
        ],
      },
      {
        key: "help",
        label: "帮助",
        items: [
          { type: "item", label: "使用说明", onAction: () => setInfoDialog("usage") },
          { type: "item", label: "版本说明", onAction: () => setInfoDialog("release") },
          { type: "item", label: "许可证…", onAction: () => setInfoDialog("license") },
          { type: "item", label: "关于", onAction: () => setInfoDialog("about") },
        ],
      },
    ];
  }, [
    activeEditorId,
    activePreviewKind,    hasMountedEditor,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onPreview,
    requestPrint,
    printSource,
    openUserFile,
    requestQuit,
    runEditorCommand,
    onFind,
    onReplace,
    requestReplaceAll,
    settings?.recentFiles,
  ]);

  // ---- derived views ----------------------------------------------------------
  const cssVars = {
    "--bg": palette.bg,
    "--fg": palette.fg,
    "--muted": palette.muted,
    "--border": palette.border,
    "--tab-bg": palette.tabBg,
    "--tab-active-bg": palette.tabActiveBg,
    "--accent": palette.accent,
    "--panel-bg": palette.panelBg,
    "--status-bg": palette.statusBg,
  } as CSSProperties;

  // A preview pane is only mounted when the active view is a preview tab, or
  // the active editor is shown in split/preview layout. Only then do we
  // materialize the source text - never in plain edit layout, and never as a
  // full copy when the document exceeds the preview limit (PreviewPane then
  // shows the "预览已禁用" notice via overLimitChars).
  const previewVisible =
    activeIsPreviewTab ||
    Boolean(activeTab && isEditor(activeTab) && layout !== "edit");
  const previewPayload = useMemo(() => {
    if (!previewVisible || !activeTab) return null;
    const source = isPreview(activeTab)
      ? activeTab.model.sourceTabId
        ? store.getTab(tabsState, activeTab.model.sourceTabId)
        : undefined
      : activeTab;
    if (!source || !isEditor(source)) return null;
    const kind = previewKindOf(source.model.title, source.model.languageOverride);
    if (!kind) return null;
    const len = source.cmState.doc.length;
    if (len > PREVIEW_MAX_CHARS) return { text: "", overLimitChars: len, kind };
    return { text: tabText(source), overLimitChars: 0, kind };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewVisible, activeTab, tabsState]);

  /** Path of the markdown document being previewed (for relative images). */
  const previewBasePath = useMemo(() => {
    if (!activeTab) return null;
    if (isPreview(activeTab)) {
      const source = activeTab.model.sourceTabId ? store.getTab(tabsState, activeTab.model.sourceTabId) : undefined;
      return source?.model.path ?? null;
    }
    return activeTab.model.path;
  }, [activeTab, tabsState]);

  const previewFontFamily = settings?.preview.fontFamily ?? DEFAULT_SETTINGS.preview.fontFamily;
  const previewFontSize = settings?.preview.fontSize ?? DEFAULT_SETTINGS.preview.fontSize;

  const activeLanguage = activeTab
    ? isPreview(activeTab)
      ? previewKindOf(activeTab.model.title, null) === "html" ||
        (activeTab.model.sourceTabId &&
          previewKindOf(
            store.getTab(tabsState, activeTab.model.sourceTabId)?.model.title ?? "",
            store.getTab(tabsState, activeTab.model.sourceTabId)?.model.languageOverride ?? null,
          ) === "html")
        ? "HTML 预览"
        : "Markdown 预览"
      : activeTab.model.languageOverride
        ? labelOfOverride(activeTab.model.languageOverride)
        : labelForName(activeTab.model.title)
    : "纯文本";

  let workbench: ReactNode;
  if (!activeTab) {
    workbench = (
      <div className="editor-pane">
        <div className="empty-hint">
          <div>欢迎使用 Lexora</div>
          <div className="empty-sub">Ctrl+O 打开文件 · Ctrl+N 新建 · 编辑 Markdown 可预览</div>
        </div>
      </div>
    );
  } else if (activeIsPreviewTab) {
    // A preview tab fills the workbench with the rendered document.
    workbench = (
      <div className="preview-full">
        <PreviewPane
          text={previewPayload?.text ?? ""}
          overLimitChars={previewPayload?.overLimitChars}
          kind={previewPayload?.kind ?? "markdown"}
          basePath={previewBasePath}
          fontFamily={previewFontFamily}
          fontSize={previewFontSize}
          vars={cssVars}
        />
      </div>
    );
  } else if (layout === "preview") {
    // Live-only preview of the current editor document.
    workbench = (
      <div className="preview-pane-wrap">
        <PreviewPane
          text={previewPayload?.text ?? ""}
          overLimitChars={previewPayload?.overLimitChars}
          kind={previewPayload?.kind ?? "markdown"}
          basePath={previewBasePath}
          fontFamily={previewFontFamily}
          fontSize={previewFontSize}
          vars={cssVars}
        />
      </div>
    );
  } else if (layout === "split") {
    workbench = (
      <>
        <div className="editor-pane split-left">
          <EditorHost
            tab={activeTab}
            onDocChange={onDocChange}
            onCursor={onCursorChange}
            onViewReady={(v) => (editorViewRef.current = v)}
            onViewportLineChange={onEditorViewportLine}
          />
        </div>
        <div className="preview-pane-wrap">
          <PreviewPane
            ref={previewHandleRef}
            text={previewPayload?.text ?? ""}
          overLimitChars={previewPayload?.overLimitChars}
          kind={previewPayload?.kind ?? "markdown"}
            basePath={previewBasePath}
            fontFamily={previewFontFamily}
            fontSize={previewFontSize}
            vars={cssVars}
            onPreviewScroll={onPreviewScrollLine}
          />
        </div>
      </>
    );
  } else {
    workbench = (
      <div className="editor-pane">
        <EditorHost tab={activeTab} onDocChange={onDocChange} onCursor={onCursorChange} onViewReady={(v) => (editorViewRef.current = v)} />
      </div>
    );
  }

  return (
    <div className="app-root" style={cssVars}>
      <div
        className="title-row"
        onMouseDown={(e) => {
          // Window drag from empty top-bar areas only; interactive elements
          // (tabs, arrows, menus, buttons, brand) never start a drag.
          const target = e.target as HTMLElement;
          if (target.closest(".title-brand, button, a, input, select, .menubar, .menu, .tab, .tab-arrow, .tab-close, .win-controls, .tab-new")) {
            return;
          }
          startWindowDrag(e);
        }}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest(".title-brand, button, .tab, .tab-arrow, .menu, a, input, select")) {
            return;
          }
          void onToggleMaximize();
        }}
      >
        <div className="brand-drop" ref={brandRef}>
          <button
            type="button"
            className={`title-brand ${brandMenuOpen ? "open" : ""}`}
            onClick={() => setBrandMenuOpen((o) => !o)}
            title="菜单（点击展开 文件/编辑/帮助）"
          >
            <img className="title-icon" src="icons/32x32.png" alt="" draggable={false} />
            <span className="title-name">Lexora</span>
          </button>
          {brandMenuOpen && (
            <div className="brand-pop">
              <MenuBar groups={menuGroups} onItemAction={closeBrandMenu} vertical />
            </div>
          )}
        </div>
        <TabBar
          tabs={viewTabs(tabsState, (t) =>
            t.model.languageOverride ? labelOfOverride(t.model.languageOverride) : labelForName(t.model.title),
          )}
          activeId={tabsState.activeId}
          onActivate={onActivate}
          onClose={requestCloseTab}
        />
        <div className="title-actions">
          {activePreviewKind != null && (
            <button
              className="title-actions-preview"
              onClick={onPreview}
              title="预览（文件 → 预览 / Ctrl+P）"
              aria-label="预览"
            >
              🔎
            </button>
          )}
          <button
            className="tab-new"
            onClick={onNew}
            title="新建标签 (Ctrl+N)"
            aria-label="新建标签"
          >
            ＋
          </button>
          <div className="win-controls">
            <button
              className="title-btn"
              aria-label="最小化"
              title="最小化"
              onClick={() => void minimizeWindow()}
            >
              <svg className="cap-icon" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              className="title-btn"
              aria-label={winMaximized ? "还原" : "最大化"}
              title={winMaximized ? "还原" : "最大化"}
              onClick={() => void onToggleMaximize()}
            >
              {winMaximized ? (
                <svg className="cap-icon" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="7" height="7" fill="var(--panel-bg)" stroke="currentColor" strokeWidth="1" />
                  <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              ) : (
                <svg className="cap-icon" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              )}
            </button>
            <button
              className="title-btn title-close"
              aria-label="关闭"
              title="关闭"
              onClick={() => void requestQuit()}
            >
              <svg className="cap-icon" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.8 0.8 9.2 9.2 M9.2 0.8 0.8 9.2" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="workbench">{workbench}</div>
      <StatusBar
        tabTitle={activeTab?.model.title ?? null}
        dirty={activeTab ? tabDirty(activeTab) : false}
        language={activeLanguage}
        languageOverride={activeTab && !isPreview(activeTab) ? activeTab.model.languageOverride : null}
        onLanguageChange={(k) => void onLanguageChange(k)}
        autosaveText={autosaveText}
        layout={layout}
        onCycleLayout={cycleLayout}
        vars={cssVars}
        readonly={activeIsPreviewTab}
        cursor={hasMountedEditor ? cursorInfo : null}
      />

      {dropPaths.length > 0 && (
        <div className="drop-overlay">
          <div className="drop-overlay-box">
            <div className="drop-overlay-title">{dropSummary(dropPaths)}</div>
            <div className="drop-overlay-sub">松开鼠标即可在 Lexora 中打开</div>
            <ul className="drop-overlay-list">
              {dropPaths.slice(0, 5).map((p) => (
                <li key={p}>{baseNameOf(p)}</li>
              ))}
            </ul>
            {dropPaths.length > 5 && (
              <div className="drop-overlay-sub">…共 {dropPaths.length} 项</div>
            )}
          </div>
        </div>
      )}

      {notice && (
        <div className="notice">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          themeChoices={[
            { id: "builtin:light", label: "浅色（内置）" },
            { id: "builtin:dark", label: "深色（内置）" },
            ...Object.keys(importedThemes).map((id) => ({
              id,
              label: id.replace(/^vscode:/, "VS Code："),
            })),
          ]}
          onSaveAndQuit={saveSettingsAndQuit}
          onCancel={() => setShowSettings(false)}
          onImportVscodeTheme={importVscodeTheme}
          onDeleteVscodeTheme={deleteVscodeTheme}
          onPickEditorFont={(s) => pickFontFor(s, "editor")}
          onPickPreviewFont={(s) => pickFontFor(s, "preview")}
          assoc={assoc}
          onAssocRegister={onAssocRegister}
          onAssocUnregister={onAssocUnregister}
          onOpenDefaultApps={onOpenDefaultApps}
        />
      )}

      {infoDialog && <InfoDialog kind={infoDialog} onClose={() => setInfoDialog(null)} />}

      {confirmClose && (
        <CloseConfirm
          title={store.getTab(tabsState, confirmClose.tabId)?.model.title ?? "当前文件"}
          onSave={() => void resolveClose(true)}
          onDiscard={() => void resolveClose(false)}
          onCancel={() => setConfirmClose(null)}
        />
      )}

      {replaceConfirmCount != null && (
        <Modal title="全部替换" width={420} onClose={() => setReplaceConfirmCount(null)}>
          <div className="info-body">
            <p>
              将替换文档中 <b>{replaceConfirmCount}</b> 处匹配内容（替换后可用
              Ctrl+Z 撤销），是否继续？
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => void confirmReplaceAll()}>
              全部替换
            </button>
            <button className="btn" onClick={() => setReplaceConfirmCount(null)}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {bigFileAsk && (
        <Modal title="打开大文件" width={460} onClose={shiftBigFileAsk}>
          <div className="info-body">
            <p>
              文件 <b>{(bigFileAsk.path.split(/[\\/]/).pop() ?? bigFileAsk.path)}</b>{" "}
              约 {Math.round(bigFileAsk.read.byteLen / 1048576)}MB（超过{" "}
              {Math.round(LARGE_FILE_WARN_BYTES / 1048576)}MB）。大文件会占用较多内存与
              打开时间，建议在<b>后台打开</b>：不切换当前标签，加载完成后用标签栏切换。
            </p>
            {bigAskQueueRef.current.length > 0 && (
              <p className="hint">还有 {bigAskQueueRef.current.length} 个大文件待确认。</p>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => void confirmOpenBig()}>
              后台打开
            </button>
            <button className="btn" onClick={shiftBigFileAsk}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {externalAsk && (
        <ExternalChangeDialog
          title={externalAsk.title}
          path={externalAsk.path}
          dirty={externalAsk.dirty}
          current={externalAsk.stat}
          remaining={externalQueueRef.current.length}
          onReload={() => void resolveExternalAsk(true)}
          onKeep={() => void resolveExternalAsk(false)}
        />
      )}

      {printAsk && (
        <PrintDialog
          title={printAsk.title}
          modes={printAsk.modes}
          onCancel={() => setPrintAsk(null)}
          onPick={(mode) => {
            const ask = printAsk;
            setPrintAsk(null);
            void runPrint(ask.tabId, ask.kind, mode);
          }}
        />
      )}
    </div>
  );
}
