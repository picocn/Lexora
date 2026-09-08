import { describe, expect, it, vi } from "vitest";
import type { TabsState, Tab } from "./types";
import { markSaved } from "./store";
import { planAutosave, runAutosaveTick } from "./autosave";
import { Compartment, EditorState } from "@codemirror/state";

function tabWith(content: string, diskContent: string, path: string | null = "D:\\x.md", key = path): Tab {
  const model = {
    id: `t:${key ?? content.length}`,
    kind: "editor" as const,
    title: path ? path.split(/[\\/]/).pop()! : "未命名",
    path,
    docKey: key ?? `untitled:${content.length}`,
    sourceTabId: null as string | null,
    manualSaved: path != null,
    diskContent,
    utf8Ok: true,
    languageOverride: null as string | null,
  };
  const state: EditorState = EditorState.create({ doc: content });
  return {
    model,
    cmState: state,
    comps: {
      lang: new Compartment(),
      theme: new Compartment(),
      prefs: new Compartment(),
    },
    langExt: null,
    lastSnapshotContent: null,
  };
}

function setContent(tab: Tab, content: string): Tab {
  const cmState = tab.cmState.update({
    changes: { from: 0, to: tab.cmState.doc.length, insert: content },
  }).state;
  return { ...tab, cmState };
}

describe("自动保存决策表（纯快照，绝不写原文件）", () => {
  it("clean tab -> none", () => {
    const s: TabsState = {
      tabs: [tabWith("same", "same")],
      activeId: "t:0",
      nextUntitled: 1,
    };
    const actions = planAutosave(s);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ kind: "none" });
  });

  it("dirty & changed since last snapshot -> snapshot with originalPath", () => {
    const tab = setContent(tabWith("orig", "orig", "D:\\a.md", "D:\\a.md"), "edited");
    const s: TabsState = { tabs: [tab], activeId: tab.model.id, nextUntitled: 1 };
    const actions = planAutosave(s);
    expect(actions[0]).toMatchObject({
      kind: "snapshot",
      docKey: "D:\\a.md",
      content: "edited",
      originalPath: "D:\\a.md",
    });
  });

  it("dirty but same as last snapshot -> skip", () => {
    let tab = tabWith("orig", "orig", "D:\\a.md", "D:\\a.md");
    tab = setContent(tab, "edited");
    tab = { ...tab, lastSnapshotContent: "edited" };
    const s: TabsState = { tabs: [tab], activeId: tab.model.id, nextUntitled: 1 };
    const actions = planAutosave(s);
    expect(actions[0]).toEqual({ kind: "skip" });
  });

  it("markSaved resets the anchor so a later edit snapshots again", () => {
    const tab0 = tabWith("orig", "orig", "D:\\a.md", "D:\\a.md");
    let s: TabsState = {
      tabs: [setContent(tab0, "edited")],
      activeId: tab0.model.id,
      nextUntitled: 1,
    };
    s = markSaved(s, s.activeId!, "D:\\a.md", "edited");
    const tab = s.tabs[0];
    expect(tab.model.diskContent).toBe("edited");
    const edited2 = setContent(tab, "edited again");
    const s2: TabsState = { ...s, tabs: [edited2] };
    const actions = planAutosave(s2);
    expect(actions[0]).toMatchObject({ kind: "snapshot", content: "edited again" });
  });
});

describe("runAutosaveTick", () => {
  it("only calls the snapshot writer, never a file writer", async () => {
    const snapshotWriter = vi.fn(async (_k: string, _c: string, _t: string, _o: string | null) => {});
    const fileWriter = vi.fn(async (_p: string, _c: string) => {});
    const s: TabsState = {
      tabs: [setContent(tabWith("orig", "orig", "D:\\a.md", "D:\\a.md"), "v2")],
      activeId: "t:0",
      nextUntitled: 1,
    };
    const { snapshotted, errors } = await runAutosaveTick(s, snapshotWriter);
    expect(snapshotted).toHaveLength(1);
    expect(snapshotted[0]).toMatchObject({ docKey: "D:\\a.md", content: "v2" });
    expect(errors).toHaveLength(0);
    expect(snapshotWriter).toHaveBeenCalledTimes(1);
    expect(fileWriter).not.toHaveBeenCalled();
  });

  it("reports writer failures without throwing", async () => {
    const writer = vi.fn(async (_k: string, _c: string, _t: string, _o: string | null) => {
      throw new Error("disk full");
    });
    const s: TabsState = {
      tabs: [setContent(tabWith("orig", "orig", "D:\\a.md", "D:\\a.md"), "v2")],
      activeId: "t:0",
      nextUntitled: 1,
    };
    const { snapshotted, errors } = await runAutosaveTick(s, writer);
    expect(snapshotted).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("disk full");
  });

  it("mixed tabs: only dirty-and-changed snapshotted", async () => {
    const clean = tabWith("clean", "clean", "D:\\c.md", "D:\\c.md");
    const dirty1 = setContent(tabWith("a", "a", "D:\\1.md", "D:\\1.md"), "a1");
    let dirty2 = setContent(tabWith("b", "b", "D:\\2.md", "D:\\2.md"), "b1");
    dirty2 = { ...dirty2, lastSnapshotContent: "b1" };
    const s: TabsState = {
      tabs: [clean, dirty1, dirty2],
      activeId: dirty1.model.id,
      nextUntitled: 1,
    };
    const writer = vi.fn(async (_k: string, _c: string, _t: string, _o: string | null) => {});
    const { snapshotted } = await runAutosaveTick(s, writer);
    expect(snapshotted).toHaveLength(1);
    expect(writer.mock.calls[0][0]).toBe("D:\\1.md");
  });
});
