import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo, selectAll } from "@codemirror/commands";
import {
  openSearchPanel,
  getSearchQuery,
  replaceAll,
  type SearchQuery,
} from "@codemirror/search";
import type { AppSettings } from "./ipc/commands";
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
} from "./ipc/commands";
import type { TabsState, Tab } from "./tabs/types";
import { tabDirty, tabText, isPreview, isEditor } from "./tabs/types";
import * as store from "./tabs/store";
import { runAutosaveTick } from "./tabs/autosave";
import {
  languageForFile,
  languageForOverride,
  labelOfOverride,
  isMarkdownFileName,
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

export function labelForName(name: string): string {
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

/** Escapes a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tabsState, setTabsState] = useState<TabsState>(() => store.emptyState());
  const [importedThemes, setImportedThemes] = useState<StoredThemeMap>(loadStoredThemes);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClose, setConfirmClose] = useState<{ tabId?: string; quit: boolean } | null>(null);
  const [infoDialog, setInfoDialog] = useState<InfoKind | null>(null);
  const [autosaveText, setAutosaveText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);
  /** Pending "全部替换" confirmation: number of matches that would change. */
  const [replaceConfirmCount, setReplaceConfirmCount] = useState<number | null>(null);

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
        // Running outside the Tauri runtime (e.g. plain vite): use defaults.
        setSettings({
          autosave: { enabled: false, intervalSec: 5 },
          editor: {
            fontFamily: "Consolas, 'Courier New', 'Sarasa Mono SC', monospace",
            fontSize: 15,
            lineHeight: 1.6,
            tabSize: 4,
            wordWrap: false,
            lineNumbers: true,
          },
          preview: { fontFamily: "system-ui, 'Microsoft YaHei', sans-serif", fontSize: 15 },
          theme: { kind: "builtin", id: "light" },
          layout: "edit",
          recentFiles: [],
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

  // Window close interception: ask when dirty editor tabs exist. Every close
  // request first persists the session, then either quits (clean) or prompts.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      try {
        const win = getCurrentWindow();
        const un = await win.onCloseRequested(async (event) => {
          if (allowCloseRef.current) return; // confirmed quit: let it close
          event.preventDefault(); // decide explicitly below
          await saveSessionNow();
          const dirty = tabsRef.current.tabs.some((t) => isEditor(t) && tabDirty(t));
          if (dirty) {
            setConfirmClose({ quit: true });
          } else {
            await forceQuit();
          }
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

  /** Actually closes the window / exits the app. Called only after the user
   * confirmed the quit dialog (or no dirty tab existed). Prefers the Rust
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

  /** 文件→退出 / 关窗入口：发起一次真实的关闭请求；拦截器自行判断是否需要
   * 先弹“保存/不保存退出/取消”确认（无脏标签则直接放行）。 */
  const requestQuit = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      /* browser preview: no-op */
    }
  }, []);

  // ---- derived config ---------------------------------------------------------
  const themeChoice: ResolvedTheme = useMemo(
    () => (settings ? resolveTheme(settings, importedThemes) : builtinTheme("light")),
    [settings, importedThemes],
  );
  const themeExt: Extension = themeChoice.cm;
  const palette = themeChoice.palette;

  const prefs: EditorPrefs = useMemo(
    () => ({
      fontFamily: settings?.editor.fontFamily || "Consolas, monospace",
      fontSize: settings?.editor.fontSize ?? 15,
      lineHeight: settings?.editor.lineHeight ?? 1.6,
      tabSize: settings?.editor.tabSize ?? 4,
      wordWrap: settings?.editor.wordWrap ?? false,
      lineNumbers: settings?.editor.lineNumbers ?? true,
    }),
    [settings],
  );

  // Apply theme / prefs changes to all open tab states.
  useEffect(() => {
    if (!settings) return;
    setTabsState((prev) => store.applyGlobalConfig(prev, themeExt, prefs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeChoice, prefs]);

  // ---- recent files -----------------------------------------------------------
  const pushRecent = useCallback((path: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, recentFiles: [path, ...prev.recentFiles.filter((f) => f !== path)].slice(0, 10) };
      writeSettings(next).catch(() => {});
      return next;
    });
  }, []);

  // ---- open ----------------------------------------------------------------
  const openPathAsTab = useCallback(
    async (path: string) => {
      try {
        const r = await readTextFile(path);
        const langExt = await languageForFile(path);
        setTabsState((prev) =>
          store.openFile(prev, {
            path,
            diskContent: r.content,
            utf8Ok: r.utf8Ok,
            utf8Bom: r.utf8Bom,
            content: r.content,
            langExt,
            theme: themeExt,
            prefs,
          }),
        );
        pushRecent(path);
      } catch (e) {
        setNotice(`打开失败：${e}`);
      }
    },
    [prefs, themeExt, pushRecent],
  );

  const onOpen = useCallback(async () => {
    const picked = await pickAndReadFile();
    if (!picked) return;
    if ("read" in picked) {
      await openPathAsTab(picked.path);
      return;
    }
    const reason = "error" in picked ? `：${picked.error}` : "";
    setNotice(`读取 ${picked.path} 失败${reason}`);
  }, [openPathAsTab]);

  const onNew = useCallback(() => {
    setTabsState((prev) => store.newUntitled(prev, { theme: themeExt, prefs }));
  }, [prefs, themeExt]);

  const onActivate = useCallback((id: string) => {
    setTabsState((prev) => store.setActive(prev, id));
  }, []);

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
  /** True when the active tab is an editor editing markdown. */
  const activeIsMarkdown = useMemo(() => {
    if (!activeTab || !isEditor(activeTab)) return false;
    return (
      isMarkdownFileName(activeTab.model.title) || activeTab.model.languageOverride === "markdown"
    );
  }, [activeTab]);

  const onPreview = useCallback(() => {
    if (!activeIsMarkdown || !activeTab) return;
    setTabsState((prev) =>
      store.openPreview(prev, { sourceTabId: activeTab.model.id, theme: themeExt, prefs }),
    );
  }, [activeIsMarkdown, activeTab, prefs, themeExt]);

  // ---- closing -------------------------------------------------------------
  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = store.getTab(tabsRef.current, tabId);
      if (!tab) return;
      if (isEditor(tab) && tabDirty(tab)) setConfirmClose({ tabId, quit: false });
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

      if (c.quit) {
        // ---- quitting the whole app ----
        if (saveFirst) {
          // 保存并退出：逐个写入原文件，全部成功后真正关闭。
          const dirty = tabsRef.current.tabs.filter((t) => isEditor(t) && tabDirty(t));
          for (const tab of dirty) {
            const ok = await saveTabById(tab.model.id, false);
            if (!ok) return; // 用户取消保存对话框或写入失败：中止退出
          }
        } else {
          // 不保存退出：快照保留，同步为当前未保存状态后退出。
          await syncSnapshotsForExit();
        }
        await forceQuit();
        return;
      }

      // ---- closing one tab ----
      const id = c.tabId;
      if (!id) return;
      if (saveFirst) {
        const ok = await saveTabById(id, false);
        if (!ok) return;
        setTabsState((prev) => store.closeTab(prev, id));
      } else {
        // 不保存并关闭：删除该标签快照后关闭。
        await doDiscardAndClose([id]);
      }
    },
    [confirmClose, saveTabById, doDiscardAndClose, syncSnapshotsForExit, forceQuit],
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
      if (showSettings || infoDialog || confirmClose || replaceConfirmCount != null) return;
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
        if (activeIsMarkdown) onPreview();
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
    activeIsMarkdown,
    onPreview,
    onFind,
    showSettings,
    infoDialog,
    confirmClose,
    replaceConfirmCount,
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
  useEffect(() => {
    if (!settings) return; // wait for the settings boot
    if (startupRestoreDone.current) return;
    startupRestoreDone.current = true;
    let cancelled = false;
    (async () => {
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
            setNotice(`已从上次会话自动恢复 ${items.length} 个未保存文档（仍为未保存状态）`);
          }
        }
      } catch {
        /* not in tauri */
      }
      // Re-open the files that were open at last exit (session). Existing
      // tabs from snapshot restore are kept (openFile dedupes by path).
      try {
        const session = await sessionLoad();
        if (session.paths.length) {
          for (const p of session.paths) {
            try {
              if (await pathExists(p)) await openPathAsTab(p);
            } catch {
              /* file gone: skip */
            }
          }
        }
        if (session.activePath && !cancelled) {
          const t = store.findByPath(tabsRef.current, session.activePath);
          if (t) setTabsState((prev) => store.setActive(prev, t.model.id));
        }
      } catch {
        /* not in tauri */
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
                onClick: () => void openPathAsTab(f),
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
            label: "预览 Markdown",
            shortcut: "Ctrl+P",
            disabled: !activeIsMarkdown,
            onAction: onPreview,
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
          { type: "item", label: "关于", onAction: () => setInfoDialog("about") },
        ],
      },
    ];
  }, [
    activeEditorId,
    activeIsMarkdown,
    hasMountedEditor,
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onPreview,
    openPathAsTab,
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

  // Content shown by a preview tab = its source editor text.
  const previewText = useMemo(() => {
    if (!activeTab) return "";
    if (isPreview(activeTab)) {
      const source = activeTab.model.sourceTabId ? store.getTab(tabsState, activeTab.model.sourceTabId) : undefined;
      return source && isEditor(source) ? tabText(source) : "";
    }
    return tabText(activeTab);
  }, [activeTab, tabsState]);

  /** Path of the markdown document being previewed (for relative images). */
  const previewBasePath = useMemo(() => {
    if (!activeTab) return null;
    if (isPreview(activeTab)) {
      const source = activeTab.model.sourceTabId ? store.getTab(tabsState, activeTab.model.sourceTabId) : undefined;
      return source?.model.path ?? null;
    }
    return activeTab.model.path;
  }, [activeTab, tabsState]);

  const previewFontFamily = settings?.preview.fontFamily ?? "system-ui, sans-serif";
  const previewFontSize = settings?.preview.fontSize ?? 15;

  const dirtyCount = tabsState.tabs.filter((t) => isEditor(t) && tabDirty(t)).length;
  const activeLanguage = activeTab
    ? isPreview(activeTab)
      ? "Markdown 预览"
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
          text={previewText}
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
          text={previewText}
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
            text={previewText}
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
      <MenuBar groups={menuGroups} />
      <TabBar
        tabs={viewTabs(tabsState, (t) =>
          t.model.languageOverride ? labelOfOverride(t.model.languageOverride) : labelForName(t.model.title),
        )}
        activeId={tabsState.activeId}
        canPreview={activeIsMarkdown}
        onActivate={onActivate}
        onClose={requestCloseTab}
        onPreview={onPreview}
      />
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
        />
      )}

      {infoDialog && <InfoDialog kind={infoDialog} onClose={() => setInfoDialog(null)} />}

      {confirmClose && (
        <CloseConfirm
          kind={confirmClose.quit ? "quit" : "close-tab"}
          count={dirtyCount}
          titles={
            confirmClose.quit
              ? tabsState.tabs.filter((t) => isEditor(t) && tabDirty(t)).map((t) => t.model.title)
              : [store.getTab(tabsState, confirmClose.tabId!)?.model.title ?? "当前文件"]
          }
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
    </div>
  );
}
