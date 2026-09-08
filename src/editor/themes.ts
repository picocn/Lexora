import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { ParsedVscodeTheme } from "./vscodeTheme";

/** CSS variables applied to the app chrome and the markdown preview. */
export interface ThemePalette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  tabActiveBg: string;
  tabBg: string;
  accent: string;
  panelBg: string;
  statusBg: string;
  dark: boolean;
}

export interface ResolvedTheme {
  id: string;
  name: string;
  dark: boolean;
  /** Editor + syntax highlighting CodeMirror extension. */
  cm: Extension;
  /** Chrome / preview CSS variables. */
  palette: ThemePalette;
}

export function hexOr(c: string | undefined, fallback: string): string {
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback;
}

function toRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h.padEnd(6, "0").slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const LIGHT_SYNTAX = HighlightStyle.define([
  { tag: t.comment, color: "#6e7781", fontStyle: "italic" },
  { tag: t.string, color: "#0a3069" },
  { tag: t.regexp, color: "#8250df" },
  { tag: t.number, color: "#0550ae" },
  { tag: t.bool, color: "#0550ae" },
  { tag: t.keyword, color: "#cf222e" },
  { tag: t.operator, color: "#cf222e" },
  { tag: t.function(t.variableName), color: "#8250df" },
  { tag: t.typeName, color: "#953800" },
  { tag: t.tagName, color: "#116329" },
  { tag: t.attributeName, color: "#953800" },
  { tag: t.propertyName, color: "#0550ae" },
  { tag: t.heading, color: "#0550ae", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#0969da", textDecoration: "underline" },
  { tag: t.monospace, color: "#24292f" },
  { tag: t.quote, color: "#116329" },
  { tag: t.invalid, color: "#cf222e" },
  { tag: t.meta, color: "#57606a" },
  { tag: t.escape, color: "#116329" },
  { tag: t.url, color: "#0969da" },
]);

const DARK_SYNTAX = HighlightStyle.define([
  { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
  { tag: t.string, color: "#a5d6ff" },
  { tag: t.regexp, color: "#d2a8ff" },
  { tag: t.number, color: "#79c0ff" },
  { tag: t.bool, color: "#79c0ff" },
  { tag: t.keyword, color: "#ff7b72" },
  { tag: t.operator, color: "#ff7b72" },
  { tag: t.function(t.variableName), color: "#d2a8ff" },
  { tag: t.typeName, color: "#ffa657" },
  { tag: t.tagName, color: "#7ee787" },
  { tag: t.attributeName, color: "#ffa657" },
  { tag: t.propertyName, color: "#79c0ff" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#58a6ff", textDecoration: "underline" },
  { tag: t.monospace, color: "#e6edf3" },
  { tag: t.quote, color: "#7ee787" },
  { tag: t.invalid, color: "#ff7b72" },
  { tag: t.meta, color: "#8b949e" },
  { tag: t.escape, color: "#7ee787" },
  { tag: t.url, color: "#58a6ff" },
]);

const lightPalette: ThemePalette = {
  bg: "#ffffff",
  fg: "#1f2328",
  muted: "#656d76",
  border: "#d0d7de",
  tabActiveBg: "#f6f8fa",
  tabBg: "#eaeef2",
  accent: "#0969da",
  panelBg: "#f6f8fa",
  statusBg: "#eaeef2",
  dark: false,
};

const darkPalette: ThemePalette = {
  bg: "#0d1117",
  fg: "#e6edf3",
  muted: "#8b949e",
  border: "#30363d",
  tabActiveBg: "#161b22",
  tabBg: "#010409",
  accent: "#58a6ff",
  panelBg: "#161b22",
  statusBg: "#161b22",
  dark: true,
};

function editorChrome(bg: string, fg: string, dark: boolean, extras: Record<string, string> = {}) {
  return EditorView.theme(
    {
      "&": { backgroundColor: bg, color: fg },
      ".cm-content": { caretColor: fg },
      ".cm-gutters": {
        backgroundColor: extras.gutterBg ?? bg,
        color: extras.gutterFg ?? (dark ? "#6e7681" : "#8c959f"),
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: extras.activeGutterBg ?? "transparent" },
      ".cm-activeLine": { backgroundColor: extras.activeLineBg ?? "transparent" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: extras.selectionBg ?? toRgba(dark ? "#58a6ff" : "#0969da", 0.25),
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: extras.cursorColor ?? fg,
      },
      ".cm-matchingBracket": {
        backgroundColor: extras.matchBg ?? toRgba(dark ? "#58a6ff" : "#0969da", 0.2),
        outline: `1px solid ${extras.matchBorder ?? toRgba(dark ? "#58a6ff" : "#0969da", 0.6)}`,
      },
      "&.cm-focused": { outline: "none" },
    },
    { dark },
  );
}

const BUILTIN: Record<string, ResolvedTheme> = {
  light: {
    id: "light",
    name: "浅色",
    dark: false,
    cm: [editorChrome(lightPalette.bg, lightPalette.fg, false), syntaxHighlighting(LIGHT_SYNTAX)],
    palette: lightPalette,
  },
  dark: {
    id: "dark",
    name: "深色",
    dark: true,
    cm: [editorChrome(darkPalette.bg, darkPalette.fg, true), syntaxHighlighting(DARK_SYNTAX)],
    palette: darkPalette,
  },
};

export function builtinTheme(id: string): ResolvedTheme {
  return BUILTIN[id] ?? BUILTIN.light;
}

/** Converts a parsed VS Code theme into a ResolvedTheme (best effort). */
export function themeFromVscode(parsed: ParsedVscodeTheme): ResolvedTheme {
  const colors = parsed.colors;
  const bg = hexOr(colors["editor.background"], parsed.dark ? "#1e1e1e" : "#ffffff");
  const fg = hexOr(colors["editor.foreground"], parsed.dark ? "#d4d4d4" : "#1f1f1f");
  const selBg =
    colors["editor.selectionBackground"] ??
    (parsed.dark ? toRgba("#264f78", 0.5) : toRgba("#add6ff", 0.6));
  const lineBg = hexOr(colors["editor.lineHighlightBackground"], "transparent");
  const gutterBg = hexOr(colors["editorGutter.background"], "transparent");
  const gutterFg = hexOr(colors["editorLineNumber.foreground"], parsed.dark ? "#858585" : "#237893");
  const cursor = hexOr(colors["editorCursor.foreground"], fg);

  const base = editorChrome(bg, fg, parsed.dark, {
    selectionBg: selBg,
    activeLineBg: lineBg,
    gutterBg,
    gutterFg,
    cursorColor: cursor,
  });

  const rules = parsed.rules.map((r) => ({ tag: r.tag, color: r.color }));
  const style = HighlightStyle.define(rules, { themeType: parsed.dark ? "dark" : "light" });

  // Chrome palette derived from editor colors (best effort).
  const palette: ThemePalette = {
    bg,
    fg,
    muted: fg,
    border: parsed.dark ? "#333333" : "#d4d4d4",
    tabActiveBg: parsed.dark ? "#2d2d2d" : "#f3f3f3",
    tabBg: parsed.dark ? "#1e1e1e" : "#e7e7e7",
    accent: parsed.dark ? "#4fc1ff" : "#0066bf",
    panelBg: parsed.dark ? "#252526" : "#f3f3f3",
    statusBg: parsed.dark ? "#007acc" : "#007acc",
    dark: parsed.dark,
  };

  return {
    id: `vscode:${parsed.name}`,
    name: parsed.name,
    dark: parsed.dark,
    cm: [base, syntaxHighlighting(style)],
    palette,
  };
}

export { toRgba };
