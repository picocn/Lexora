import type { EditorState, Compartment, Extension } from "@codemirror/state";

export type TabKind = "editor" | "preview";

/** Serializable description of a tab. */
export interface TabModel {
  id: string;
  kind: TabKind;
  /** Display title, e.g. file basename / 未命名-N / xxx-预览. */
  title: string;
  /** Absolute path when backed by a real file (null = untitled / preview). */
  path: string | null;
  /** Autosave snapshot key (path or untitled id). Preview tabs never snapshot. */
  docKey: string;
  /** For kind=preview: the editor tab whose rendered markdown this shows. */
  sourceTabId: string | null;
  /** True once the user performed a successful manual Save / Save As. */
  manualSaved: boolean;
  /** Content of the last manual save / file-open (disk anchor). */
  diskContent: string;
  /** UTF-8 clean? Non-utf8 files warn before manual save. */
  utf8Ok: boolean;
  /** File originally started with a UTF-8 BOM; same-file saves re-add it. */
  utf8Bom: boolean;
  /** Language override key from the status bar menu (null = auto). */
  languageOverride: string | null;
}

export interface Tab {
  model: TabModel;
  /** Live CodeMirror state. Preview tabs carry a placeholder empty state and
   * are never mounted into an EditorView. */
  cmState: EditorState;
  /** Compartments of this tab's state (language / theme / prefs). */
  comps: {
    lang: Compartment;
    theme: Compartment;
    prefs: Compartment;
  };
  /** Cached language extension (resolved from filename or override). */
  langExt: Extension | null;
  /** Content at the last autosave snapshot (change detection). */
  lastSnapshotContent: string | null;
  /** True when a very large clean tab was unloaded to a lightweight
   * placeholder (cmState holds an empty doc; reloaded on activation). */
  unloaded?: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  nextUntitled: number;
}

export function isEditor(t: Tab): boolean {
  return (t.model.kind ?? "editor") === "editor";
}

export function isPreview(t: Tab): boolean {
  return t.model.kind === "preview";
}

/** True when the current editor content differs from the disk anchor.
 * Preview tabs are never dirty; unloaded (placeholder) tabs are clean by
 * definition - they were only unloaded while content == disk. */
export function tabDirty(tab: Tab): boolean {
  if (!isEditor(tab) || tab.unloaded) return false;
  return tab.cmState.doc.toString() !== tab.model.diskContent;
}

/** Current editor text of a tab ("" for preview tabs). */
export function tabText(tab: Tab): string {
  if (!isEditor(tab)) return "";
  return tab.cmState.doc.toString();
}
