import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type { Tab } from "../tabs/types";
import { setCursorListener, setDocListener, type CursorInfo } from "../editor/docBus";

export interface EditorHostProps {
  /** Active editor tab to display; undefined = empty editor. */
  tab: Tab | undefined;
  /** Fired with the fresh EditorState whenever the doc changes. */
  onDocChange: (tabId: string, state: EditorState) => void;
  /** Fired whenever cursor/selection changes (for the status bar). */
  onCursor?: (tabId: string, cursor: CursorInfo) => void;
  /** Registers the mounted EditorView so menu commands (undo/redo/…) can run. */
  onViewReady?: (view: EditorView | null) => void;
  /** Reports the 1-based source line at the top of the editor viewport
   * (used by split-view preview scroll sync). */
  onViewportLineChange?: (line: number) => void;
}

const emptyDoc = EditorState.create({ doc: "" });

// Kept module-level so scroll offsets survive an EditorHost unmount/remount
// (e.g. switching to a preview tab and back).
const scrollMap = new Map<string, number>();

/**
 * Hosts a single CodeMirror EditorView. Each tab owns an immutable
 * EditorState (with its own undo history & compartments); switching tabs swaps
 * states through view.setState and restores the per-tab scroll offset.
 * Document changes inside the view are routed back through the doc bus
 * (each tab state embeds an updateListener wired to `docBus.report`).
 */
export function EditorHost({
  tab,
  onDocChange,
  onCursor,
  onViewReady,
  onViewportLineChange,
}: EditorHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const onViewportLineRef = useRef(onViewportLineChange);
  onViewportLineRef.current = onViewportLineChange;
  const activeIdRef = useRef<string | null>(null);

  // Mount once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: emptyDoc, parent: host });
    viewRef.current = view;
    onViewReady?.(view);

    let raf = 0;
    const reportTopLine = () => {
      raf = 0;
      if (!onViewportLineRef.current) return;
      const sd = view.scrollDOM;
      const max = sd.scrollHeight - sd.clientHeight;
      if (max <= 0) return;
      // Prefer a measured block; fall back to a proportional estimate.
      let line = 0;
      try {
        const block = view.elementAtHeight(sd.scrollTop);
        if (block && block.from != null) {
          line = view.state.doc.lineAt(block.from).number;
        }
      } catch {
        /* ignore */
      }
      if (!line) {
        line = Math.max(1, Math.round((sd.scrollTop / max) * view.state.doc.lines));
      }
      onViewportLineRef.current(line);
    };
    const onScroll = () => {
      const id = activeIdRef.current;
      if (id) scrollMap.set(id, view.scrollDOM.scrollTop);
      if (onViewportLineRef.current && !raf) {
        raf = requestAnimationFrame(reportTopLine);
      }
    };
    view.scrollDOM.addEventListener("scroll", onScroll);

    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      onViewReady?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the bus pointing at this host's handlers.
  useEffect(() => {
    setDocListener((id, state) => onDocChangeRef.current(id, state));
    setCursorListener((id, cursor) => onCursorRef.current?.(id, cursor));
    return () => {
      setDocListener(null);
      setCursorListener(null);
    };
  }, []);

  // Swap state when the tab (or its state) changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!tab) {
      activeIdRef.current = null;
      if (view.state !== emptyDoc) view.setState(emptyDoc);
      return;
    }

    const prevId = activeIdRef.current;
    if (prevId && prevId !== tab.model.id) {
      scrollMap.set(prevId, view.scrollDOM.scrollTop);
    }
    if (view.state !== tab.cmState) {
      view.setState(tab.cmState);
    }
    activeIdRef.current = tab.model.id;

    const top = scrollMap.get(tab.model.id) ?? 0;
    requestAnimationFrame(() => {
      if (viewRef.current) viewRef.current.scrollDOM.scrollTop = top;
    });
  }, [tab]);

  // Focus the editor whenever the mounted tab changes (first open or tab
  // switch) so the user lands directly in edit mode.
  useEffect(() => {
    if (tab) viewRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.model.id]);

  return <div className="cm-host" ref={hostRef} />;
}
