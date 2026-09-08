import { Tag, tags as t } from "@lezer/highlight";

/** Canonical VS Code scope group -> CodeMirror tag mapping. */
export interface ScopeRule {
  /** Selectors this rule applies to (verbatim from tokenColors). */
  scopes: string[];
  tag: Tag;
  /** The rule's text color (settings.foreground). */
  color: string;
}

export interface ParsedVscodeTheme {
  name: string;
  dark: boolean;
  /** Base editor palette (raw color keys from `colors`). */
  colors: Record<string, string>;
  /** Ordered rules (first match wins). */
  rules: ScopeRule[];
}

const TAG_BY_PREFIX: Array<{ prefixes: string[]; tag: Tag }> = [
  { prefixes: ["invalid", "illegal"], tag: t.invalid },
  { prefixes: ["comment"], tag: t.comment },
  { prefixes: ["string.regexp", "string.regex"], tag: t.regexp },
  { prefixes: ["string"], tag: t.string },
  { prefixes: ["constant.language.boolean"], tag: t.bool },
  { prefixes: ["constant.numeric"], tag: t.number },
  { prefixes: ["constant.character.escape"], tag: t.escape },
  { prefixes: ["constant"], tag: t.constant(t.variableName) },
  {
    prefixes: ["entity.name.function", "meta.function-call", "support.function"],
    tag: t.function(t.variableName),
  },
  {
    prefixes: ["entity.name.type", "entity.other.inherited-class", "support.type"],
    tag: t.typeName,
  },
  { prefixes: ["entity.name.tag"], tag: t.tagName },
  { prefixes: ["entity.other.attribute-name"], tag: t.attributeName },
  {
    prefixes: ["variable.other.property", "support.type.property-name", "meta.property-name"],
    tag: t.propertyName,
  },
  { prefixes: ["variable.language"], tag: t.keyword },
  { prefixes: ["variable"], tag: t.variableName },
  { prefixes: ["storage.type", "storage.modifier"], tag: t.typeName },
  { prefixes: ["keyword.operator", "keyword"], tag: t.keyword },
  { prefixes: ["meta.tag"], tag: t.meta },
  { prefixes: ["markup.heading"], tag: t.heading },
  { prefixes: ["markup.bold"], tag: t.strong },
  { prefixes: ["markup.italic"], tag: t.emphasis },
  { prefixes: ["markup.underline.link", "markup.link"], tag: t.link },
  { prefixes: ["markup.quote", "markup.raw"], tag: t.quote },
  { prefixes: ["markup"], tag: t.meta },
  { prefixes: ["punctuation"], tag: t.punctuation },
  { prefixes: ["source"], tag: t.meta },
];

function pickTag(scopeChain: string[]): Tag | null {
  for (const { prefixes, tag } of TAG_BY_PREFIX) {
    for (const scope of scopeChain) {
      if (prefixes.some((p) => scope === p || scope.startsWith(p + "."))) {
        return tag;
      }
    }
  }
  return null;
}

/**
 * Parses a raw VS Code theme JSON object into a palette plus ordered scope
 * rules. Best-effort: only first-level scope groups are mapped.
 */
export function parseVscodeTheme(raw: unknown): ParsedVscodeTheme | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const colors = (obj.colors ?? {}) as Record<string, string>;
  const tokenColors = Array.isArray(obj.tokenColors) ? (obj.tokenColors as unknown[]) : [];

  const rules: ScopeRule[] = [];
  for (const entry of tokenColors) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const settings = (e.settings ?? {}) as Record<string, unknown>;
    const fg = typeof settings.foreground === "string" ? settings.foreground : null;
    if (!fg) continue;
    const scopeList = Array.isArray(e.scope)
      ? (e.scope as unknown[]).filter((s): s is string => typeof s === "string")
      : typeof e.scope === "string"
        ? [e.scope]
        : [];
    for (const scopeRaw of scopeList) {
      // A rule may list comma-separated selectors; treat each selector as its
      // own scope chain item but keep file order for first-match-wins.
      const tag = pickTag(scopeRaw.split(",").map((s) => s.trim()).filter(Boolean));
      if (tag) rules.push({ scopes: [scopeRaw], tag, color: fg });
    }
  }

  return {
    name: typeof obj.name === "string" ? obj.name : "未命名主题",
    dark: obj.type === "dark",
    colors,
    rules,
  };
}
