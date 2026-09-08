import type { TabsState, Tab } from "./types";
import { tabDirty, tabText } from "./types";

/** Pure decision for one tab on an autosave tick. */
export type AutosaveAction =
  | { kind: "none" } // not dirty: nothing to do
  | { kind: "skip" } // dirty but unchanged since the last snapshot
  | {
      kind: "snapshot";
      docKey: string;
      content: string;
      title: string;
      originalPath: string | null;
    };

function decide(tab: Tab): AutosaveAction {
  if (!tabDirty(tab)) return { kind: "none" };
  const content = tabText(tab);
  if (content === tab.lastSnapshotContent) return { kind: "skip" };
  return {
    kind: "snapshot",
    docKey: tab.model.docKey,
    content,
    title: tab.model.title,
    originalPath: tab.model.path,
  };
}

/**
 * Decides the autosave actions for every tab on one tick.
 *
 * Invariant (unit-tested): the autosave plan NEVER produces a "write original
 * file" action - only snapshots. Original files are written exclusively by the
 * manual save flow (`markSaved`), never here.
 */
export function planAutosave(state: TabsState): AutosaveAction[] {
  return state.tabs.map(decide);
}

/** A writer that only persists recovery snapshots (wraps the Tauri command). */
export interface SnapshotWriter {
  (
    docKey: string,
    content: string,
    title: string,
    originalPath: string | null,
  ): Promise<void>;
}

/**
 * Runs an autosave tick against the given tabs.
 * Returns the snapshots actually written (for folding anchors back) plus
 * errors. Never touches real files.
 */
export async function runAutosaveTick(
  state: TabsState,
  writer: SnapshotWriter,
): Promise<{
  snapshotted: Array<{ docKey: string; content: string }>;
  errors: string[];
}> {
  const actions = planAutosave(state);
  const snapshotted: Array<{ docKey: string; content: string }> = [];
  const errors: string[] = [];
  for (const action of actions) {
    if (action.kind !== "snapshot") continue;
    try {
      await writer(action.docKey, action.content, action.title, action.originalPath);
      snapshotted.push({ docKey: action.docKey, content: action.content });
    } catch (e) {
      errors.push(`${action.title}: ${String(e)}`);
    }
  }
  return { snapshotted, errors };
}
