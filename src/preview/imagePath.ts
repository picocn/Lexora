// Resolving local images referenced from markdown documents.
// In Tauri the webview cannot read arbitrary local files directly, so local
// image paths are resolved here and then read through the Rust command
// (read_image_base64) into base64 data: URLs - the asset protocol is not used
// because percent-encoded / CJK / space-heavy paths break on it.

const SEP = /[\\/]/;

/** True when the string is an absolute local file path. */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
}

/** Directory portion of a file path ("D:\docs\a.md" -> "D:\docs"). */
export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : "";
}

/**
 * Normalizes a path: collapses "." segments and resolves ".." up to the
 * filesystem root / drive letter. Preserves the original separator style.
 */
export function normalizePath(p: string): string {
  const driveMatch = /^([a-zA-Z]:)([\\/]?)/.exec(p);
  const drive = driveMatch ? driveMatch[1] : "";
  const sep = p.includes("\\") ? "\\" : "/";
  const rest = drive ? p.slice(drive.length) : p;
  const rooted = rest.startsWith("/") || rest.startsWith("\\");
  const parts = rest.split(SEP).filter((s) => s.length > 0 && s !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
      else if (!rooted) stack.push("..");
      // rooted: ".." above root is ignored
    } else {
      stack.push(part);
    }
  }
  const body = stack.join(sep);
  if (drive) return drive + (body ? sep + body : sep);
  if (rooted) return sep + body;
  return body;
}

/** Joins a directory and a (possibly relative) child path, normalized. */
export function joinPath(dir: string, child: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = child.replace(/^[\\/]+/, "");
  return normalizePath(`${dir.replace(/[\\/]+$/, "")}${sep}${trimmed}`);
}

/**
 * Resolves an image src found in a markdown document into an absolute local
 * path, or returns null when it is not a local file reference (http(s), data,
 * asset, file, fragment, protocol-relative).
 */
export function resolveLocalImageSrc(src: string, baseDir: string | null): string | null {
  let trimmed = src.trim();
  if (!trimmed) return null;
  // markdown-it (CommonMark normalizeLink) percent-encodes URI destinations,
  // so CJK names become %E7%99%BD... and backslashes become %5C. Decode back
  // to the raw filesystem reference before resolving (only %XX escapes are
  // touched; raw unicode/spaces pass through untouched).
  try {
    trimmed = decodeURIComponent(trimmed);
  } catch {
    // malformed escape sequence (e.g. stray "%"): keep as-is
  }
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return null; // protocol-relative (e.g. //cdn/x)
  if (isAbsolutePath(trimmed)) return normalizePath(trimmed);
  if (!baseDir) return null;
  // A scheme like "https:" has ≥2 chars before ":". A lone drive letter
  // ("D:") is a path, not a scheme - isAbsolutePath already handled it.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // http:, https:, data:, file:, asset:, mailto:, ...
    return null; // handled natively / not a local relative reference
  }
  return joinPath(baseDir, trimmed);
}

