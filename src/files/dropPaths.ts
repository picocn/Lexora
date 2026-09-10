// Pure helpers for the file drag & drop path (TODO requirement 1: drop a file
// onto the window to open it). The Tauri window event gives raw OS paths; the
// logic here keeps only openable, de-duplicated entries and produces the
// Chinese drop-overlay label.

/** Text/markdown/code/config extensions that are worth opening in the editor. */
const TEXT_EXTENSIONS = new Set([
  // markdown & plain text
  "md", "markdown", "mdown", "mkd", "mdx", "txt", "text", "rst", "adoc", "asciidoc",
  "org", "log", "nfo", "srt", "vtt",
  // data / config
  "csv", "tsv", "json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "properties", "env", "editorconfig", "gitignore",
  "gitattributes", "dockerignore", "npmrc", "htaccess", "lock", "patch", "diff",
  // markup / web
  "html", "htm", "xhtml", "xml", "css", "scss", "sass", "less", "styl",
  "vue", "svelte", "astro", "jsx", "tsx",
  // code
  "js", "mjs", "cjs", "ts", "mts", "cts", "py", "pyi", "rb", "go", "rs",
  "java", "kt", "kts", "scala", "groovy", "gradle", "c", "h", "cc", "cpp", "cxx",
  "hpp", "hh", "hxx", "cs", "fs", "fsx", "vb", "php", "pl", "pm", "lua", "r",
  "jl", "dart", "swift", "m", "mm", "sql", "sh", "bash", "zsh", "fish", "ps1",
  "psm1", "bat", "cmd", "tex", "bib", "sty", "cls", "asm", "s", "v", "vhd", "sv",
  "proto", "graphql", "gql", "tf", "tfvars", "hcl", "nix",
  "clj", "cljs", "edn", "ex", "exs", "erl", "hrl", "hs", "lhs", "ml", "mli",
  "pas", "f", "f90", "d", "zig", "nim", "cr", "sol", "tcl", "awk", "sed",
]);

/** Known extensionless file names that are still text/config files. */
const TEXT_NAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "containerfile", "cmakelists.txt",
  "readme", "license", "licence", "changelog", "authors", "notice", "copying",
  "todo", "rakefile", "gemfile", "procfile", "vagrantfile", "jenkinsfile",
  ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".env",
  ".npmrc", ".babelrc", ".eslintrc", ".prettierrc", ".dockerignore",
]);

/** Separator-normalized, case-folded de-duplication key (Windows paths are
 * case-insensitive and accept both "\" and "/"). */
function dedupeKey(path: string): string {
  return path.replace(/[\\/]+/g, "\\").toLowerCase();
}

/**
 * Cleans a raw drop path list: trims each entry, drops blanks, and removes
 * duplicates case-insensitively (and across "/" vs "\"). The first occurrence
 * wins, so the original order is preserved.
 */
export function normalizePathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = dedupeKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Chinese label for the drop overlay ("松开以打开 3 个文件"). */
export function dropSummary(paths: string[]): string {
  const count = normalizePathList(paths).length;
  if (count === 0) return "未识别到可打开的文件";
  return `松开以打开 ${count} 个文件`;
}

/** Extension of a file name or path, lowercased ("" when there is none). */
function extensionOf(name: string): string {
  const base = name.trim().replace(/[\\/]+$/, "");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  const file = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = file.lastIndexOf(".");
  // ".gitignore"-style dotfiles keep their whole name (handled by TEXT_NAMES).
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

/** Last path segment, lowercased (used to match known extensionless names). */
function baseNameOf(name: string): string {
  const base = name.trim().replace(/[\\/]+$/, "");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return (slash >= 0 ? base.slice(slash + 1) : base).toLowerCase();
}

/**
 * True when the dropped name looks like a text file the editor can open
 * (markdown, plain text, source code, config). Images, media, archives and
 * binaries return false, as does an unknown extension.
 */
export function isLikelyTextFile(name: string): boolean {
  if (typeof name !== "string" || !name.trim()) return false;
  const base = baseNameOf(name);
  if (TEXT_NAMES.has(base)) return true;
  const ext = extensionOf(name);
  return ext.length > 0 && TEXT_EXTENSIONS.has(ext);
}

/** Extensions that must never be opened as text (reading them would produce a
 * huge lossy-decoded buffer). Unknown extensions are deliberately NOT listed:
 * the editor is happy to try any other text-ish file. */
const BINARY_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "ico", "tif", "tiff", "psd", "heic",
  // audio / video
  "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "mp4", "mkv", "avi", "mov", "wmv",
  "webm", "flv", "m4v", "mpg", "mpeg", "rmvb",
  // archives / disk images / installers
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz4", "cab", "iso", "img",
  "msi", "msix", "appx", "dmg", "jar", "war", "apk", "deb", "rpm",
  // executables / libraries / objects
  "exe", "dll", "sys", "so", "dylib", "bin", "o", "obj", "lib", "a", "pdb", "class",
  "pyc", "pyo", "wasm", "node",
  // documents / data blobs / fonts
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "ttf", "otf", "woff", "woff2", "eot", "db", "sqlite", "sqlite3", "mdb", "dat",
  "pak", "cache", "lnk", "swf",
]);

/**
 * True when a dropped file is a known binary format that Lexora must not open
 * as text. Everything else (including unknown or missing extensions) is
 * considered openable, so files like `notes.conf` or `Makefile.local` still
 * work; a genuinely unreadable file is reported by the normal open-failure
 * notice.
 */
export function isProbablyBinaryFile(name: string): boolean {
  if (typeof name !== "string" || !name.trim()) return false;
  const ext = extensionOf(name);
  return ext.length > 0 && BINARY_EXTENSIONS.has(ext);
}
