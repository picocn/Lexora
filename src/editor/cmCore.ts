import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { reportDocChange, reportCursor } from "./docBus";

export interface EditorPrefs {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
}

export interface TabCompartments {
  lang: Compartment;
  theme: Compartment;
  prefs: Compartment;
}

export interface CreatedState {
  state: EditorState;
  comps: TabCompartments;
}

/** Chinese translations for CodeMirror's built-in panel UI (search/replace
 * panel, a11y announcements). Keys are the exact English source strings. */
export const CM_PHRASES: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "整词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "位于行",
  "Go to line": "跳转到行",
  max: "最大",
  go: "跳转",
};

export const baseExtensions: Extension[] = [
  drawSelection(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  indentOnInput(),
  bracketMatching(),
  foldGutter(),
  highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
];

/** Optional per-tab: undo/redo history (skipped for very large documents). */
export function historyExtension(noHistory: boolean): Extension[] {
  return noHistory ? [] : [history(), keymap.of(historyKeymap)];
}

export function prefsExtension(prefs: EditorPrefs): Extension {
  return [
    EditorView.theme({
      "&": {
        fontFamily: prefs.fontFamily,
        fontSize: `${prefs.fontSize}px`,
        lineHeight: `${prefs.lineHeight}`,
      },
      ".cm-content": { caretColor: "currentColor" },
    }),
    EditorState.tabSize.of(prefs.tabSize),
    prefs.wordWrap ? EditorView.lineWrapping : [],
    prefs.lineNumbers ? lineNumbers() : [],
  ];
}

/** Creates a per-tab CodeMirror state with isolated compartments. Each tab
 * state embeds a doc-change listener reporting into the doc bus so the host
 * view can notify the app store with this tab's id. */
export function createEditorState(opts: {
  tabId: string;
  doc: string;
  language?: Extension | null;
  theme: Extension;
  prefs: EditorPrefs;
  /** Skip undo/redo history (very large documents). Defaults to false. */
  noHistory?: boolean;
}): CreatedState {
  const lang = new Compartment();
  const theme = new Compartment();
  const prefs = new Compartment();
  const tabId = opts.tabId;
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      ...baseExtensions,
      ...historyExtension(!!opts.noHistory),
      EditorState.phrases.of(CM_PHRASES),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          reportDocChange(tabId, update.state);
          reportCursor(tabId, update.state);
        } else if (update.selectionSet) {
          // Cursor moved without editing: update status bar only.
          reportCursor(tabId, update.state);
        }
      }),
      lang.of(opts.language ?? []),
      theme.of(opts.theme),
      prefs.of(prefsExtension(opts.prefs)),
    ],
  });
  return { state, comps: { lang, theme, prefs } };
}
