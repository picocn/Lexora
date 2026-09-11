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
  /** Memoised LF-normalised disk anchor for the dirty check (see tabDirty). */
  diskLfAnchor?: string;
  /** The exact model.diskContent `diskLfAnchor` was derived from. */
  diskLfSource?: string;
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
  return (t.model.kind === "preview");
}

/** Line-ending-insensitive comparison for the dirty check.
 *
 * CodeMirror normalises CRLF/CR to LF when a document is created from a string,
 * while `diskContent` holds the file bytes verbatim. Without this, every CRLF
 * file (the Windows default) looked dirty the moment it was opened: the ● mark
 * showed up and autosave wrote recovery snapshots on every tick even though the
 * user had not typed anything.
 *
 * Back-ported from the Go + Wails migration (`lexora-go`), where the same bug
 * was found; the two projects share this frontend. */
function normalizeEol(s: string): string {
  return s.indexOf("\r") === -1 ? s : s.replace(/\r\n?/g, "\n");
}

/** True when the current editor content differs from the disk anchor.
 * Preview tabs are never dirty; unloaded (placeholder) tabs are clean by
 * definition - they were only unloaded while content == disk.
 *
 * `diskContent` holds the file bytes verbatim while the CodeMirror doc holds
 * LF-normalised text, so the comparison runs against a memoised LF anchor
 * (derived once per open/save, keyed by the exact `diskContent` string so a new
 * open/save invalidates it automatically). Lengths are compared first, so the
 * common "just typed" case never materializes the document. */
export function tabDirty(tab: Tab): boolean {
  if (!isEditor(tab) || tab.unloaded) return false;
  const doc = tab.cmState.doc;
  const disk = tab.model.diskContent;
  let anchor = tab.diskLfAnchor;
  if (anchor === undefined || tab.diskLfSource !== disk) {
    anchor = normalizeEol(disk);
    tab.diskLfAnchor = anchor;
    tab.diskLfSource = disk;
  }
  // Different length => different content, no allocation needed.
  if (doc.length !== anchor.length) return true;
  // Equal length: one string compare decides (fast when lengths already match
  // but the bytes do not, which is the typical per-keystroke case).
  return doc.toString() !== anchor;
}

/** Current editor text of a tab ("" for preview tabs). */
export function tabText(tab: Tab): string {
  if (!isEditor(tab)) return "";
  return tab.cmState.doc.toString();
}
