// Local-image fix-up for rendered HTML: the webview cannot read arbitrary local
// files, so every local <img src> is resolved against the document's folder and
// read through the Rust command into a base64 data: URL.
//
// Extracted from PreviewPane so the preview pane and the print pipeline share
// one implementation (and one module-wide cache).

import { dirnameOf, resolveLocalImageSrc } from "./imagePath";
import { readImageBase64 } from "../ipc/commands";

/** Module-wide cache of resolved local image data URLs (path -> data URL).
 * Images do not change within a session; without this the debounced preview
 * re-render would IPC-read + base64-encode every local image on every keystroke. */
const imageDataUrlCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 128;

/** Reader backing the cache (injectable so the pure logic stays testable). */
export type ImageReader = (path: string) => Promise<string>;

/** MIME type guessed from the file extension (images only). */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** MIME type of a path by extension, defaulting to application/octet-stream. */
export function mimeOfPath(p: string): string {
  const i = p.lastIndexOf(".");
  const ext = i >= 0 ? p.slice(i + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Cache key of a resolved local path: separator style is unified so
 * "D:\docs\a.png" and "D:/docs/a.png" share one cache entry (Windows accepts
 * both spellings for the same file).
 */
export function imageCacheKey(localPath: string): string {
  return localPath.trim().replace(/[\\/]+/g, "\\");
}

/** A local image reference resolved from a document src. */
export interface ResolvedLocalImage {
  path: string;
  mime: string;
}

/**
 * Resolves an <img src> of a document into an absolute local path + MIME type,
 * or null when the src is not a local file (http(s), data:, asset:, file:,
 * protocol-relative, fragment). Relative srcs need the document path; absolute
 * local paths also resolve for unsaved documents.
 */
export function resolveLocalImage(src: string, docPath: string | null): ResolvedLocalImage | null {
  const baseDir = docPath ? dirnameOf(docPath) : null;
  const local = resolveLocalImageSrc(src, baseDir);
  return local ? { path: local, mime: mimeOfPath(local) } : null;
}

/**
 * Reads a local image into a `data:` URL, caching successful reads. The reader
 * is injectable for tests; by default it uses the Rust read_image_base64
 * command. Failed reads are never cached.
 */
export async function loadImageDataUrl(
  localPath: string,
  mime: string,
  read: ImageReader = readImageBase64,
): Promise<string> {
  const key = imageCacheKey(localPath);
  const hit = imageDataUrlCache.get(key);
  if (hit) return hit;
  const b64 = await read(localPath);
  const url = `data:${mime};base64,${b64}`;
  if (imageDataUrlCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageDataUrlCache.keys().next().value;
    if (oldest !== undefined) imageDataUrlCache.delete(oldest);
  }
  imageDataUrlCache.set(key, url);
  return url;
}

/** Drops every cached data URL (test helper / explicit refresh). */
export function clearImageCache(): void {
  imageDataUrlCache.clear();
}

/** Number of cached images (test helper). */
export function imageCacheSize(): number {
  return imageDataUrlCache.size;
}

/**
 * Rewrites every `<img>` inside `root` whose src points at a local file:
 * - http(s)/data URLs are left untouched (`resolveLocalImage` rejects them);
 * - relative paths resolve against the document folder (docPath);
 * - absolute local paths resolve even for unsaved documents (docPath === null);
 * - unreadable images get a Chinese title/alt instead of a broken icon.
 */
export async function materializeImages(root: ParentNode, docPath: string | null): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  if (!imgs.length) return;

  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const local = resolveLocalImage(src, docPath);
    if (!local) continue; // remote/data URLs render natively
    try {
      img.src = await loadImageDataUrl(local.path, local.mime);
      img.onerror = () => {
        img.onerror = null;
        img.setAttribute("title", `无法加载图片：${src}`);
      };
    } catch {
      img.setAttribute("title", `无法加载图片：${src}`);
      img.setAttribute("alt", `[无法加载图片：${src}]`);
    }
  }
}
