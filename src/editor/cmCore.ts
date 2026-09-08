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

export const baseExtensions: Extension[] = [
  history(),
  drawSelection(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  indentOnInput(),
  bracketMatching(),
  foldGutter(),
  highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
];

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
}): CreatedState {
  const lang = new Compartment();
  const theme = new Compartment();
  const prefs = new Compartment();
  const tabId = opts.tabId;
  const state = EditorState.create({
    doc: opts.doc,
    extensions: [
      ...baseExtensions,
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
