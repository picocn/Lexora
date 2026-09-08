import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo, selectAll } from "@codemirror/commands";
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
    if (picked.read) await openPathAsTab(picked.path);
    else setNotice(`读取 ${picked.path} 失败`);
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
      if (!tab.model.utf8Ok) setNotice("原文件非 UTF-8 编码，保存将写为 UTF-8。");
      const content = tabText(tab);
      let target = forcePick ? null : tab.model.path;
      if (!target) {
        target = await pickSavePath(tab.model.path ?? `${tab.model.title}.md`);
        if (!target) return false;
      }
      try {
        await writeTextFile(target, content);
      } catch (e) {
        setNotice(`保存失败：${e}`);
        return false;
      }
      const oldKey = tab.model.docKey;
      setTabsState((prev) => store.markSaved(prev, tab.model.id, target, content));
      snapshotRemove(oldKey).catch(() => {});
      if (target !== oldKey) pushRecent(target);
      setNotice((n) => (n && n.includes("UTF-8") ? n : null));
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
      else setTabsState((prev) => store.closeTab(prev, tabId));
    },
    [],
  );

  const doDiscardAndClose = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        const tab = store.getTab(tabsRef.current, id);
        if (tab && isEditor(tab)) snapshotRemove(tab.model.docKey).catch(() => {});
      }
      setTabsState((prev) => ids.reduce((acc, id) => store.closeTab(acc, id), prev));
    },
    [],
  );

  /** Persists a fresh snapshot for every dirty editor tab (used when quitting
   * without saving, so nothing is lost and snapshots are kept). */
  const refreshSnapshotsForDirty = useCallback(async () => {
    const dirty = tabsRef.current.tabs.filter((t) => isEditor(t) && tabDirty(t));
    for (const tab of dirty) {
      const content = tabText(tab);
      try {
        await snapshotWrite(tab.model.docKey, content, tab.model.title, tab.model.path);
      } catch {
        /* keep going; next launch may use an older snapshot */
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
          // 不保存退出：保留快照（绝不删除），补写最新内容后退出。
          await refreshSnapshotsForDirty();
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
        doDiscardAndClose([id]);
      }
    },
    [confirmClose, saveTabById, doDiscardAndClose, refreshSnapshotsForDirty, forceQuit],
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
      } else if (e.key === "F5") {
        e.preventDefault();
        cycleLayout();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNew, onOpen, onSave, onSaveAs, requestCloseTab, cycleLayout, activeIsMarkdown, onPreview]);

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

  // ---- recovery handlers ------------------------------------------------------
  const restoreSnapshot = useCallback(
    async (key: string) => {
      try {
        const snap = await snapshotRead(key);
        const originalPath = snap.originalPath;
        if (originalPath) {
          const existing = store.findByPath(tabsRef.current, originalPath);
          if (existing) {
            setNotice(`“${existing.model.title}” 已打开，未恢复该快照`);
            return;
          }
        }

        let restoredPath: string | null = null;
        let diskContent = "";
        if (originalPath) {
          try {
            if (await pathExists(originalPath)) {
              restoredPath = originalPath;
              diskContent = (await readTextFile(originalPath)).content;
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
  // 保证启动恢复只执行一次（restoreSnapshot 依赖 prefs/themeExt，settings
  // 异步加载后其引用会变化并触发本 effect 重跑；用 ref 忽略后续执行）。
  const startupRestoreDone = useRef(false);
  useEffect(() => {
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
  }, [restoreSnapshot]);

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
    </div>
  );
}
