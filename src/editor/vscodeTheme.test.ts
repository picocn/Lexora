import { describe, expect, it } from "vitest";
import { parseVscodeTheme } from "./vscodeTheme";
import { tags as t } from "@lezer/highlight";

const DARK_PLUS = {
  name: "Dark+",
  type: "dark",
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editor.selectionBackground": "#264f78",
    "editor.lineHighlightBackground": "#2b2b2b",
    "editorCursor.foreground": "#aeafad",
    "editorLineNumber.foreground": "#858585",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6a9955" } },
    { scope: "string", settings: { foreground: "#ce9178" } },
    { scope: "constant.numeric", settings: { foreground: "#b5cea8" } },
    { scope: ["keyword", "keyword.control"], settings: { foreground: "#c586c0" } },
    {
      scope: ["entity.name.function", "meta.function-call"],
      settings: { foreground: "#dcdcaa" },
    },
    { scope: "entity.name.type", settings: { foreground: "#4ec9b0" } },
    { scope: "invalid", settings: { foreground: "#f44747" } },
    { scope: "no.such.scope", settings: { foreground: "#ffffff" } },
  ],
};

describe("parseVscodeTheme", () => {
  it("parses palette, dark flag and name", () => {
    const parsed = parseVscodeTheme(DARK_PLUS)!;
    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe("Dark+");
    expect(parsed.dark).toBe(true);
    expect(parsed.colors["editor.background"]).toBe("#1e1e1e");
  });

  it("maps scope groups to CodeMirror tags, first match wins, unknown ignored", () => {
    const parsed = parseVscodeTheme(DARK_PLUS)!;
    const byScope = new Map(parsed.rules.map((r) => [r.scopes[0], r.tag]));
    expect(byScope.get("comment")).toBe(t.comment);
    expect(byScope.get("string")).toBe(t.string);
    expect(byScope.get("constant.numeric")).toBe(t.number);
    expect(byScope.get("keyword")).toBe(t.keyword);
    expect(byScope.get("entity.name.function")).toBe(t.function(t.variableName));
    expect(byScope.get("entity.name.type")).toBe(t.typeName);
    expect(byScope.get("invalid")).toBe(t.invalid);
    expect(parsed.rules.some((r) => r.scopes[0] === "no.such.scope")).toBe(false);
  });

  it("treats scope selectors with commas/children correctly", () => {
    const parsed = parseVscodeTheme({
      name: "x",
      type: "light",
      colors: {},
      tokenColors: [{ scope: "keyword.control.rust, keyword.operator", settings: { foreground: "#0af" } }],
    })!;
    // "keyword.control.rust" matches keyword prefix group; the entry is kept.
    expect(parsed.rules.length).toBe(1);
    expect(parsed.rules[0].tag).toBe(t.keyword);
  });

  it("returns null for garbage input", () => {
    expect(parseVscodeTheme(null)).toBeNull();
    expect(parseVscodeTheme("nope")).toBeNull();
    expect(parseVscodeTheme([1, 2])).toBeNull();
  });

  it("drops tokenColors entries without a foreground", () => {
    const parsed = parseVscodeTheme({
      name: "x",
      type: "light",
      colors: {},
      tokenColors: [
        { scope: "comment", settings: {} },
        { scope: "string", settings: { foreground: "#111" } },
      ],
    })!;
    expect(parsed.rules).toHaveLength(1);
  });
});
