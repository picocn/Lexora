import type { TabsState, Tab } from "../tabs/types";
import { tabDirty } from "../tabs/types";
import { isPreview } from "../tabs/types";

/** UI-facing projection of a tab (pure, cheap to render). */
export interface TabView {
  id: string;
  kind: "editor" | "preview";
  title: string;
  path: string | null;
  dirty: boolean;
  active: boolean;
  languageLabel: string;
}

/** Projects every tab into a render-friendly TabView list. */
export function viewTabs(
  state: TabsState,
  languageLabelOf: (t: Tab) => string,
): TabView[] {
  return state.tabs.map((t) => ({
    id: t.model.id,
    kind: t.model.kind,
    title: t.model.title,
    path: t.model.path,
    dirty: isPreview(t) ? false : tabDirty(t),
    active: t.model.id === state.activeId,
    languageLabel: isPreview(t) ? "预览" : languageLabelOf(t),
  }));
}
