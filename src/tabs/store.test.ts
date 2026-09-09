import { describe, expect, it } from "vitest";
import type { TabsState, Tab } from "./types";
import {
  emptyState,
  openFile,
  newUntitled,
  setActive,
  closeTab,
  markSaved,
  isDirty,
  getActive,
  findByPath,
  patchModel,
  openPreview,
  findPreviewFor,
  stem,
  unloadBigTab,
  reloadBigTab,
} from "./store";
import { tabDirty, isPreview, isEditor } from "./types";
import type { EditorPrefs } from "../editor/cmCore";
import type { Extension } from "@codemirror/state";

const prefs: EditorPrefs = {
  fontFamily: "monospace",
  fontSize: 14,
  lineHeight: 1.5,
  tabSize: 4,
  wordWrap: false,
  lineNumbers: true,
};
const theme: Extension = [];

const FILE_A = "D:\\docs\\a.md";
const FILE_B = "D:\\docs\\b.txt";

function withFile(state: TabsState, path: string, content: string): TabsState {
  return openFile(state, {
    path,
    diskContent: content,
    utf8Ok: true,
    content,
    langExt: null,
    theme,
    prefs,
  });
}

function edit(tab: Tab, text: string): Tab {
  const cmState = tab.cmState.update({ changes: { from: 0, to: tab.cmState.doc.length, insert: text } }).state;
  return { ...tab, cmState };
}

describe("标签状态机", () => {
  it("empty state has no active tab", () => {
    const s = emptyState();
    expect(s.activeId).toBeNull();
    expect(s.tabs).toHaveLength(0);
  });

  it("openFile activates and dedupes by path", () => {
    let s = withFile(emptyState(), FILE_A, "# Hi");
    expect(s.tabs).toHaveLength(1);
    expect(getActive(s)?.model.path).toBe(FILE_A);

    // Second open of same path just activates the existing tab.
    const before = s.tabs.length;
    s = withFile(s, FILE_A, "# Hi");
    expect(s.tabs.length).toBe(before);
    expect(s.tabs.filter((t) => t.model.path === FILE_A)).toHaveLength(1);
  });

  it("untitled tabs get sequential names and no disk anchor", () => {
    let s = newUntitled(emptyState(), { theme, prefs });
    s = newUntitled(s, { theme, prefs });
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0].model.title).toBe("未命名-1");
    expect(s.tabs[1].model.title).toBe("未命名-2");
    expect(s.tabs[0].model.diskContent).toBe("");
    expect(s.tabs[0].model.manualSaved).toBe(false);
  });

  it("dirty flips with content changes and clears after manual save", () => {
    let s = withFile(emptyState(), FILE_A, "hello");
    const tab = getActive(s)!;
    expect(tabDirty(tab)).toBe(false);

    s = { ...s, tabs: s.tabs.map((t) => (t.model.id === tab.model.id ? edit(t, "hello world") : t)) };
    expect(isDirty(s, tab.model.id)).toBe(true);

    s = markSaved(s, tab.model.id, FILE_A, "hello world");
    expect(isDirty(s, tab.model.id)).toBe(false);
    expect(getActive(s)!.model.diskContent).toBe("hello world");
    expect(getActive(s)!.model.manualSaved).toBe(true);
  });

  it("edits on an opened file keep diskContent untouched until a manual save", () => {
    let s = withFile(emptyState(), FILE_A, "original");
    const tab = getActive(s)!;
    expect(tab.model.diskContent).toBe("original");
    s = { ...s, tabs: s.tabs.map((t) => (t.model.id === tab.model.id ? edit(t, "edited") : t)) };
    // Even though dirty, the anchor (what is on disk) must stay "original" -
    // nothing here wrote to the real file.
    expect(getActive(s)!.model.diskContent).toBe("original");
    expect(isDirty(s, tab.model.id)).toBe(true);
  });

  it("markSaved via Save-As changes path/docKey/title", () => {
    let s = newUntitled(emptyState(), { theme, prefs });
    const id = s.activeId!;
    s = { ...s, tabs: s.tabs.map((t) => (t.model.id === id ? edit(t, "content") : t)) };
    s = markSaved(s, id, FILE_B, "content");
    const t = getActive(s)!;
    expect(t.model.path).toBe(FILE_B);
    expect(t.model.docKey).toBe(FILE_B);
    expect(t.model.title).toBe("b.txt");
    expect(isDirty(s, id)).toBe(false);
  });

  it("closeTab removes and picks a sensible new active", () => {
    let s = withFile(emptyState(), FILE_A, "a");
    const idA = s.activeId!;
    s = withFile(s, FILE_B, "b");
    const idB = s.activeId!;
    expect(s.tabs).toHaveLength(2);
    s = closeTab(s, idA);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(idB);
    expect(findByPath(s, FILE_A)).toBeUndefined();
  });

  it("setActive no-ops for unknown ids", () => {
    const s = withFile(emptyState(), FILE_A, "x");
    const same = setActive(s, "nope");
    expect(same).toBe(s);
  });

  it("patchModel only updates the target tab", () => {
    let s = withFile(emptyState(), FILE_A, "x");
    s = newUntitled(s, { theme, prefs });
    const idA = s.tabs[0].model.id;
    s = patchModel(s, idA, { title: "renamed" });
    expect(s.tabs[0].model.title).toBe("renamed");
    expect(s.tabs[1].model.title).toBe("未命名-1");
  });
});

describe("预览标签页", () => {
  it("stem strips a file extension", () => {
    expect(stem("report.md")).toBe("report");
    expect(stem("a.b.md")).toBe("a.b");
    expect(stem("noext")).toBe("noext");
    expect(stem("D:\\x\\y.md")).toBe("y");
  });

  it("openPreview creates a preview tab named xxx-预览 linked to its source", () => {
    let s = withFile(emptyState(), FILE_A, "# Hi");
    const sourceId = s.activeId!;
    s = openPreview(s, { sourceTabId: sourceId, theme, prefs });
    expect(s.tabs).toHaveLength(2);
    const pv = findPreviewFor(s, sourceId)!;
    expect(pv).toBeDefined();
    expect(isPreview(pv)).toBe(true);
    expect(pv.model.title).toBe("a-预览");
    expect(pv.model.sourceTabId).toBe(sourceId);
    expect(s.activeId).toBe(pv.model.id);
    // Preview tabs are never dirty, and don't shadow the editor's disk anchor.
    expect(tabDirty(pv)).toBe(false);
  });

  it("openPreview reuses the existing preview for the same source", () => {
    let s = withFile(emptyState(), FILE_A, "# Hi");
    const sourceId = s.activeId!;
    s = openPreview(s, { sourceTabId: sourceId, theme, prefs });
    const before = s.tabs.length;
    s = openPreview(s, { sourceTabId: sourceId, theme, prefs });
    expect(s.tabs.length).toBe(before);
    expect(s.activeId).toBe(findPreviewFor(s, sourceId)!.model.id);
  });

  it("closing the source editor tab also closes its preview tabs", () => {
    let s = withFile(emptyState(), FILE_A, "# Hi");
    const sourceId = s.activeId!;
    s = openPreview(s, { sourceTabId: sourceId, theme, prefs });
    const pvId = s.activeId!;
    s = closeTab(s, sourceId);
    expect(s.tabs.some((t) => t.model.id === pvId)).toBe(false);
    expect(s.tabs.some((t) => t.model.id === sourceId)).toBe(false);
    expect(getActive(s)).toBeUndefined();
  });

  it("preview tabs don't count as dirty or editable", () => {
    let s = withFile(emptyState(), FILE_A, "content");
    const sourceId = s.activeId!;
    s = openPreview(s, { sourceTabId: sourceId, theme, prefs });
    const pv = findPreviewFor(s, sourceId)!;
    expect(isEditor(pv)).toBe(false);
    expect(tabDirty(pv)).toBe(false);
    expect(isDirty(s, pv.model.id)).toBe(false);
    // Manual-save semantics only apply to editors: markSaved on a preview id
    // must leave the preview tab (model incl.) completely untouched.
    const pvModelBefore = { ...pv.model };
    s = markSaved(s, pv.model.id, FILE_B, "whatever");
    const pvAfter = findPreviewFor(s, sourceId)!;
    expect(pvAfter).toBeDefined();
    expect(pvAfter.model).toEqual(pvModelBefore);
    expect(pvAfter.model.path).toBeNull();
    expect(pvAfter.model.docKey).toBe(pv.model.docKey);
  });
});

describe("large-file open options (L2/L3)", () => {
  it("openFile with focus:false keeps the current active tab", () => {
    let s = withFile(emptyState(), FILE_A, "# A");
    const activeA = s.activeId;
    s = openFile(s, {
      path: FILE_B,
      diskContent: "b",
      utf8Ok: true,
      content: "b",
      langExt: null,
      theme,
      prefs,
      focus: false,
    });
    expect(s.activeId).toBe(activeA);
    expect(findByPath(s, FILE_B)).toBeDefined();
    // default focus=true activates the new tab
    s = openFile(s, {
      path: FILE_B,
      diskContent: "b",
      utf8Ok: true,
      content: "b",
      langExt: null,
      theme,
      prefs,
    });
    expect(s.activeId).toBe(findByPath(s, FILE_B)!.model.id);
  });

  it("unloadBigTab swaps in an empty placeholder that is not dirty", () => {
    let s = withFile(emptyState(), FILE_A, "some large content");
    const id = s.activeId!;
    s = unloadBigTab(s, id, { theme, prefs });
    const t = getActive(s)!;
    expect(t.unloaded).toBe(true);
    expect(t.cmState.doc.length).toBe(0);
    expect(t.model.path).toBe(FILE_A);
    expect(tabDirty(t)).toBe(false);
  });

  it("reloadBigTab restores content in place keeping id and order", () => {
    let s = withFile(emptyState(), FILE_A, "large A");
    const idA = s.activeId!;
    s = openFile(s, {
      path: FILE_B,
      diskContent: "b",
      utf8Ok: true,
      content: "b",
      langExt: null,
      theme,
      prefs,
    });
    const idB = s.activeId!;
    s = unloadBigTab(s, idA, { theme, prefs });
    // reload A in place (fresh content == disk anchor => clean)
    s = reloadBigTab(s, idA, {
      path: FILE_A,
      diskContent: "large A (fresh)",
      utf8Ok: true,
      utf8Bom: false,
      content: "large A (fresh)",
      langExt: null,
      theme,
      prefs,
    });
    expect(s.tabs.map((t) => t.model.id)).toEqual([idA, idB]);
    const a = findByPath(s, FILE_A)!;
    expect(a.unloaded).toBe(false);
    expect(a.cmState.doc.toString()).toBe("large A (fresh)");
    expect(tabDirty(a)).toBe(false); // content == diskContent anchor
    // and editing after reload makes it dirty again
    const edited = { ...a, cmState: a.cmState.update({ changes: { from: 0, to: a.cmState.doc.length, insert: "changed" } }).state };
    expect(tabDirty(edited)).toBe(true);
  });
});
