import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { LanguageDescription } from "@codemirror/language";
import { languages as dataLanguages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/** Exact-match registrations that need bespoke setup (markdown embeds fenced
 * code highlighting via language-data; html/css/js/json have dedicated
 * packages that behave better than their legacy data counterparts). */
const EXTENSION_OVERRIDES: Record<string, () => Extension> = {
  md: () => markdown({ base: markdownLanguage, codeLanguages: dataLanguages }),
  markdown: () => markdown({ base: markdownLanguage, codeLanguages: dataLanguages }),
  mdown: () => markdown({ base: markdownLanguage, codeLanguages: dataLanguages }),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Resolves a CodeMirror language extension for a file name.
 * Returns null (plain text) when nothing matches or the language fails to load.
 */
export async function languageForFile(name: string): Promise<Extension | null> {
  const ext = extensionOf(name);
  const override = EXTENSION_OVERRIDES[ext];
  if (override) return override();
  const desc = LanguageDescription.matchFilename(dataLanguages, name);
  if (desc) {
    try {
      return await desc.load();
    } catch {
      return null;
    }
  }
  return null;
}

/** A user-facing language choice for the status bar override menu. */
export interface LanguageChoice {
  label: string;
  /** Stable key used by the override UI ('' = auto/plain). */
  key: string;
  /** Sample file names used to resolve the language through the registry. */
  samples: string[];
}

export const LANGUAGE_CHOICES: LanguageChoice[] = [
  { label: "Markdown", key: "markdown", samples: ["a.md"] },
  { label: "HTML", key: "html", samples: ["a.html"] },
  { label: "CSS", key: "css", samples: ["a.css"] },
  { label: "JavaScript", key: "javascript", samples: ["a.js"] },
  { label: "TypeScript", key: "typescript", samples: ["a.ts"] },
  { label: "JSON", key: "json", samples: ["a.json"] },
  { label: "YAML", key: "yaml", samples: ["a.yaml"] },
  { label: "TOML", key: "toml", samples: ["a.toml"] },
  { label: "XML", key: "xml", samples: ["a.xml"] },
  { label: "Rust", key: "rust", samples: ["a.rs"] },
  { label: "Python", key: "python", samples: ["a.py"] },
  { label: "Java", key: "java", samples: ["a.java"] },
  { label: "C", key: "c", samples: ["a.c"] },
  { label: "C++", key: "cpp", samples: ["a.cpp"] },
  { label: "C#", key: "csharp", samples: ["a.cs"] },
  { label: "Go", key: "go", samples: ["a.go"] },
  { label: "SQL", key: "sql", samples: ["a.sql"] },
  { label: "Shell", key: "shell", samples: ["a.sh"] },
  { label: "PowerShell", key: "powershell", samples: ["a.ps1"] },
  { label: "PHP", key: "php", samples: ["a.php"] },
  { label: "Ruby", key: "ruby", samples: ["a.rb"] },
  { label: "纯文本", key: "plain", samples: ["a.txt"] },
];

const choiceByKey = new Map(LANGUAGE_CHOICES.map((c) => [c.key, c]));

/** Applies an override by stable key; resolves to null for plain text. */
export async function languageForOverride(key: string | null): Promise<Extension | null> {
  if (!key || key === "plain") return null;
  const choice = choiceByKey.get(key);
  if (!choice) return null;
  return languageForFile(choice.samples[0]);
}

/** Human label of the override key for the status bar ("自动" when auto). */
export function labelOfOverride(key: string | null): string {
  if (!key) return "自动";
  const c = choiceByKey.get(key);
  return c ? c.label : key;
}

/** True when a file name (with extension) denotes Markdown. */
export function isMarkdownFileName(name: string): boolean {
  return /\.(md|markdown|mdown)$/i.test(name);
}
