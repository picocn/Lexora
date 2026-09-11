import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { tabDirty, type Tab, type TabModel } from "./types";

/** Minimal editor tab with a real CodeMirror state (created from `doc`). */
function editorTab(doc: string, diskContent: string): Tab {
  const model: TabModel = {
    id: "file:C:\\x\\a.md",
    kind: "editor",
    title: "a.md",
    path: "C:\\x\\a.md",
    docKey: "C:\\x\\a.md",
    sourceTabId: null,
    manualSaved: true,
    diskContent,
    utf8Ok: true,
    utf8Bom: false,
    languageOverride: null,
  };
  return {
    model,
    cmState: EditorState.create({ doc }),
    comps: null as never,
    langExt: null,
    lastSnapshotContent: null,
    unloaded: false,
  };
}

describe("tabDirty", () => {
  it("is clean for identical content", () => {
    expect(tabDirty(editorTab("hello\n", "hello\n"))).toBe(false);
  });

  it("is dirty after a real edit", () => {
    expect(tabDirty(editorTab("hello world\n", "hello\n"))).toBe(true);
  });

  it("stays clean for a CRLF file (CodeMirror normalises CRLF to LF)", () => {
    // The document comes from CodeMirror (LF), diskContent from the file (CRLF).
    expect(tabDirty(editorTab("line1\nline2\n", "line1\r\nline2\r\n"))).toBe(false);
  });

  it("stays clean for lone-CR line endings", () => {
    expect(tabDirty(editorTab("a\nb\n", "a\rb\r"))).toBe(false);
  });

  it("still detects a change in a CRLF file", () => {
    expect(tabDirty(editorTab("line1\nline2 edited\n", "line1\r\nline2\r\n"))).toBe(true);
  });

  it("treats an unloaded placeholder as clean", () => {
    const tab = editorTab("", "");
    tab.unloaded = true;
    expect(tabDirty(tab)).toBe(false);
  });

  it("never reports preview tabs as dirty", () => {
    const tab = editorTab("x", "y");
    tab.model = { ...tab.model, kind: "preview" };
    expect(tabDirty(tab)).toBe(false);
  });

  it("memoises the LF disk anchor and reuses it across calls", () => {
    const tab = editorTab("line1\nline2\n", "line1\r\nline2\r\n");
    expect(tab.diskLfAnchor).toBeUndefined();
    expect(tabDirty(tab)).toBe(false);
    expect(tab.diskLfAnchor).toBe("line1\nline2\n");
    expect(tab.diskLfSource).toBe("line1\r\nline2\r\n");
    // Second call uses the memo (same object identity, no re-normalisation).
    const memo = tab.diskLfAnchor;
    expect(tabDirty(tab)).toBe(false);
    expect(tab.diskLfAnchor).toBe(memo);
  });

  it("invalidates the memo when the disk anchor changes (open/save)", () => {
    const tab = editorTab("hello\n", "hello\r\n");
    expect(tabDirty(tab)).toBe(false);
    // A manual save rewrites model.diskContent: the tab must still read clean.
    tab.model.diskContent = "hello\n";
    expect(tabDirty(tab)).toBe(false);
    expect(tab.diskLfSource).toBe("hello\n");
    // ...and a different anchor must not be masked by the stale memo.
    tab.model.diskContent = "hello";
    expect(tabDirty(tab)).toBe(true);
  });

  it("stays O(1)-ish for a large CRLF document (memo, length gate)", () => {
    const line = "0123456789abcdef\r\n";
    const disk = line.repeat(20_000); // ~360 KB
    const lf = disk.replace(/\r\n/g, "\n");
    const tab = editorTab(lf, disk);
    expect(tabDirty(tab)).toBe(false);
    // An edit changes the length: detected without materialising the anchor.
    const edited = editorTab(lf + "x", disk);
    expect(tabDirty(edited)).toBe(true);
  });
});
