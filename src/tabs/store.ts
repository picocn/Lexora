import { EditorState, type Extension } from "@codemirror/state";
import type { TabsState, Tab, TabModel } from "./types";
import { tabDirty, isPreview, isEditor } from "./types";
import { createEditorState, prefsExtension, type EditorPrefs } from "../editor/cmCore";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** File stem: basename without its last extension. */
export function stem(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function emptyState(): TabsState {
  return { tabs: [], activeId: null, nextUntitled: 1 };
}

export function findByPath(state: TabsState, path: string): Tab | undefined {
  return state.tabs.find((t) => t.model.path === path && !isPreview(t));
}

export function getTab(state: TabsState, id: string | null): Tab | undefined {
  return state.tabs.find((t) => t.model.id === id);
}

export function getActive(state: TabsState): Tab | undefined {
  return getTab(state, state.activeId);
}

export function findPreviewFor(state: TabsState, sourceTabId: string): Tab | undefined {
  return state.tabs.find((t) => isPreview(t) && t.model.sourceTabId === sourceTabId);
}

function nextId(state: TabsState, path: string | null): string {
  if (path) return `file:${path}`;
  return `untitled:${state.nextUntitled}`;
}

function freshTab(opts: {
  model: TabModel;
  content: string;
  langExt: Extension | null;
  theme: Extension;
  prefs: EditorPrefs;
  noHistory?: boolean;
}): Tab {
  const { state, comps } = createEditorState({
    tabId: opts.model.id,
    doc: opts.content,
    language: opts.langExt,
    theme: opts.theme,
    prefs: opts.prefs,
    noHistory: opts.noHistory,
  });
  return {
    model: opts.model,
    cmState: state,
    comps,
    langExt: opts.langExt,
    lastSnapshotContent: null,
    unloaded: false,
  };
}

/**
 * Replaces a very large *clean* tab's heavy editor state with a lightweight
 * placeholder (same tab id/model, empty doc). The tab stays visible; it is
 * reloaded from disk when activated. `unloaded` keeps tabDirty() == false.
 */
export function unloadBigTab(
  state: TabsState,
  id: string,
  opts: { theme: Extension; prefs: EditorPrefs },
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      if (t.model.id !== id || !isEditor(t) || t.unloaded) return t;
      const { state: cmState, comps } = createEditorState({
        tabId: t.model.id,
        doc: "",
        theme: opts.theme,
        prefs: opts.prefs,
      });
      return {
        ...t,
        model: { ...t.model, diskContent: "" },
        cmState,
        comps,
        langExt: null,
        lastSnapshotContent: null,
        unloaded: true,
      };
    }),
  };
}

/**
 * Reloads an unloaded tab in place from freshly read file content, keeping
 * the same tab id/order. Marks it loaded (unloaded = false).
 */
export function reloadBigTab(
  state: TabsState,
  id: string,
  opts: {
    path: string;
    diskContent: string;
    utf8Ok: boolean;
    utf8Bom: boolean;
    content: string;
    langExt: Extension | null;
    theme: Extension;
    prefs: EditorPrefs;
    noHistory?: boolean;
  },
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      if (t.model.id !== id) return t;
      const fresh = freshTab({
        model: {
          ...t.model,
          diskContent: opts.diskContent,
          utf8Ok: opts.utf8Ok,
          utf8Bom: opts.utf8Bom,
        },
        content: opts.content,
        langExt: opts.langExt,
        theme: opts.theme,
        prefs: opts.prefs,
        noHistory: opts.noHistory,
      });
      return { ...fresh, model: { ...fresh.model, id: t.model.id } };
    }),
  };
}

/**
 * Opens a file-backed tab, or activates the existing tab for that path.
 * When a real file was opened, manualSaved = true and the disk anchor equals
 * the initial content (fresh files have nothing unsaved).
 */
export function openFile(state: TabsState, opts: {
  path: string;
  diskContent: string;
  utf8Ok: boolean;
  utf8Bom?: boolean;
  content: string;
  langExt: Extension | null;
  theme: Extension;
  prefs: EditorPrefs;
  /** focus the new tab (default true); false opens it in the background. */
  focus?: boolean;
  /** skip undo/redo history (very large documents). */
  noHistory?: boolean;
}): TabsState {
  const existing = findByPath(state, opts.path);
  if (existing) {
    return { ...state, activeId: existing.model.id };
  }
  const id = nextId(state, opts.path);
  const model: TabModel = {
    id,
    kind: "editor",
    title: basename(opts.path),
    path: opts.path,
    docKey: opts.path,
    sourceTabId: null,
    manualSaved: true, // file already exists on disk
    diskContent: opts.diskContent,
    utf8Ok: opts.utf8Ok,
    utf8Bom: opts.utf8Bom ?? false,
    languageOverride: null,
  };
  const tab = freshTab({
    model,
    content: opts.content,
    langExt: opts.langExt,
    theme: opts.theme,
    prefs: opts.prefs,
    noHistory: opts.noHistory,
  });
  const activeId = opts.focus === false && state.activeId ? state.activeId : id;
  return { tabs: [...state.tabs, tab], activeId, nextUntitled: state.nextUntitled };
}

/** Creates a new empty untitled tab (nothing on disk yet). */
export function newUntitled(state: TabsState, opts: {
  theme: Extension;
  prefs: EditorPrefs;
  content?: string;
}): TabsState {
  const id = nextId(state, null);
  const model: TabModel = {
    id,
    kind: "editor",
    title: `未命名-${state.nextUntitled}`,
    path: null,
    docKey: id,
    sourceTabId: null,
    manualSaved: false,
    diskContent: "",
    utf8Ok: true,
    utf8Bom: false,
    languageOverride: null,
  };
  const tab = freshTab({ model, content: opts.content ?? "", langExt: null, theme: opts.theme, prefs: opts.prefs });
  return {
    tabs: [...state.tabs, tab],
    activeId: id,
    nextUntitled: state.nextUntitled + 1,
  };
}

/**
 * Opens (or focuses) the live preview tab for an editor tab. The preview is a
 * read-only rendered view of the source's current document content.
 */
export function openPreview(state: TabsState, opts: {
  sourceTabId: string;
  theme: Extension;
  prefs: EditorPrefs;
}): TabsState {
  const existing = findPreviewFor(state, opts.sourceTabId);
  if (existing) {
    return { ...state, activeId: existing.model.id };
  }
  const source = getTab(state, opts.sourceTabId);
  const title = `${stem(source?.model.title ?? "文档")}-预览`;
  const id = `preview:${opts.sourceTabId}`;
  const model: TabModel = {
    id,
    kind: "preview",
    title,
    path: null,
    docKey: id,
    sourceTabId: opts.sourceTabId,
    manualSaved: false,
    diskContent: "",
    utf8Ok: true,
    utf8Bom: false,
    languageOverride: null,
  };
  const tab = freshTab({ model, content: "", langExt: null, theme: opts.theme, prefs: opts.prefs });
  return { tabs: [...state.tabs, tab], activeId: id, nextUntitled: state.nextUntitled };
}

export function setActive(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.model.id === id)) return state;
  return { ...state, activeId: id };
}

export function replaceCmState(state: TabsState, id: string, cmState: EditorState): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.model.id === id ? { ...t, cmState } : t)),
  };
}

export function patchModel(state: TabsState, id: string, patch: Partial<TabModel>): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.model.id === id ? { ...t, model: { ...t.model, ...patch } } : t,
    ),
  };
}

/** Records that the current content was persisted to a real file by a manual
 * save. Clears the snapshot anchor so a future autosave can snapshot again
 * after the next edit. Manual-save semantics only apply to editor tabs:
 * preview tabs are never touched. */
export function markSaved(
  state: TabsState,
  id: string,
  path: string,
  content: string,
  utf8Bom = false,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      if (t.model.id !== id || !isEditor(t)) return t;
      return {
        ...t,
        lastSnapshotContent: null,
        model: {
          ...t.model,
          path,
          docKey: path,
          title: basename(path),
          manualSaved: true,
          utf8Ok: true, // the file on disk is now UTF-8
          utf8Bom, // reflects the BOM that was actually written
          diskContent: content,
        },
      };
    }),
  };
}

export function setLangOverride(
  state: TabsState,
  id: string,
  key: string | null,
  langExt: Extension | null,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.model.id === id ? { ...t, model: { ...t.model, languageOverride: key }, langExt } : t,
    ),
  };
}

/** Reconfigures every tab's theme & editor-prefs compartments (settings change). */
export function applyGlobalConfig(
  state: TabsState,
  theme: Extension,
  prefs: EditorPrefs,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      const withTheme = t.cmState.update({
        effects: t.comps.theme.reconfigure(theme),
      }).state;
      const withPrefs = withTheme.update({
        effects: t.comps.prefs.reconfigure(prefsExtension(prefs)),
      }).state;
      return { ...t, cmState: withPrefs };
    }),
  };
}

/** Reconfigures a single tab's language compartment (auto-detect or override). */
export function applyLanguage(state: TabsState, id: string, langExt: Extension | null): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => {
      if (t.model.id !== id) return t;
      const cmState = t.cmState.update({
        effects: t.comps.lang.reconfigure(langExt ?? []),
      }).state;
      return { ...t, cmState, langExt };
    }),
  };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.model.id === id);
  if (idx < 0) return state;
  // Closing an editor tab also closes its dependent preview tabs.
  const doomed = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of state.tabs) {
      if (t.model.sourceTabId && doomed.has(t.model.sourceTabId) && !doomed.has(t.model.id)) {
        doomed.add(t.model.id);
        changed = true;
      }
    }
  }
  const tabs = state.tabs.filter((t) => !doomed.has(t.model.id));
  let activeId = state.activeId;
  if (activeId && doomed.has(activeId)) {
    activeId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].model.id : null;
  }
  return { tabs, activeId, nextUntitled: state.nextUntitled };
}

export function isDirty(state: TabsState, id: string): boolean {
  const t = getTab(state, id);
  return t ? tabDirty(t) : false;
}
