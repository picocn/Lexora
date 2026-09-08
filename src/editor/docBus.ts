import type { EditorState } from "@codemirror/state";

export interface DocChangeHandler {
  (tabId: string, state: EditorState): void;
}

export interface CursorInfo {
  line: number;
  col: number;
  /** Selected character span (anchor→head), 0 when no selection. */
  selChars: number;
  /** Lines spanned by the selection (≥1 when selChars > 0). */
  selLines: number;
  hasSel: boolean;
}

export type CursorHandler = (tabId: string, cursor: CursorInfo) => void;

/** Module-level doc-change bus. Each tab's EditorState embeds an
 * updateListener that calls `report` with its own tab id whenever its
 * document changes / selection moves; the mounted EditorHost registers the
 * current handlers. Only one EditorHost exists per window. */
let docHandler: DocChangeHandler | null = null;
let cursorHandler: CursorHandler | null = null;

export function setDocListener(h: DocChangeHandler | null): void {
  docHandler = h;
}

export function setCursorListener(h: CursorHandler | null): void {
  cursorHandler = h;
}

export function reportDocChange(tabId: string, state: EditorState): void {
  if (docHandler) docHandler(tabId, state);
}

export function reportCursor(tabId: string, state: EditorState): void {
  if (!cursorHandler) return;
  cursorHandler(tabId, computeCursor(state));
}

/** Computes cursor line/col + selection stats from a CodeMirror state. */
export function computeCursor(state: EditorState): CursorInfo {
  const main = state.selection.main;
  const headLine = state.doc.lineAt(main.head);
  const line = headLine.number;
  const col = main.head - headLine.from + 1;

  if (main.empty) {
    return { line, col, selChars: 0, selLines: 0, hasSel: false };
  }

  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  const selChars = to - from;
  const fromLine = state.doc.lineAt(from).number;
  const toLine = state.doc.lineAt(to).number;
  const selLines = Math.max(1, toLine - fromLine + 1);
  return { line, col, selChars, selLines, hasSel: true };
}
