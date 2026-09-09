import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { renderMarkdown } from "../preview/render";
import { renderMermaidIn } from "../preview/mermaid";
import { dirnameOf, resolveLocalImageSrc } from "../preview/imagePath";
import { readImageBase64, openExternal } from "../ipc/commands";
import { PREVIEW_MAX_CHARS } from "../tabs/thresholds";

/** Cache of resolved local image data URLs (path -> data URL). Images do not
 * change within a session; without this the 300ms-debounced re-render would
 * IPC-read + base64-encode every local image on every keystroke. */
const imageDataUrlCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 128;
function cachedImageDataUrl(path: string, mime: string): Promise<string> {
  const hit = imageDataUrlCache.get(path);
  if (hit) return Promise.resolve(hit);
  return readImageBase64(path)
    .then((b64) => {
      const url = `data:${mime};base64,${b64}`;
      if (imageDataUrlCache.size >= IMAGE_CACHE_MAX) {
        const oldest = imageDataUrlCache.keys().next().value;
        if (oldest !== undefined) imageDataUrlCache.delete(oldest);
      }
      imageDataUrlCache.set(path, url);
      return url;
    })
    .catch((e) => {
      throw e;
    });
}

export interface PreviewPaneHandle {
  /** Scroll the preview so the markdown source line appears near the top. */
  scrollToSourceLine(line: number): void;
}

export interface PreviewPaneProps {
  text: string;
  /** When the doc exceeds the preview limit the caller passes "" as text and
   * reports the real character count here; we show the disabled notice. */
  overLimitChars?: number;
  fontFamily: string;
  fontSize: number;
  /** Chroma variables (bg/fg/...). */
  vars: CSSProperties;
  debounceMs?: number;
  /** Path of the document being previewed (used to resolve relative images). */
  basePath?: string | null;
  /** Called with the markdown line at the preview viewport top while scrolling. */
  onPreviewScroll?: (line: number) => void;
}

/** Renders the edited markdown (html:false enforced by render.ts).
 * Block-level elements carry data-line anchors from the renderer, used by
 * split-view scroll sync. */
export const PreviewPane = forwardRef<PreviewPaneHandle, PreviewPaneProps>(
  function PreviewPane(
    { text, overLimitChars, fontFamily, fontSize, vars, debounceMs = 300, basePath, onPreviewScroll },
    ref,
  ) {
    // Whole-document markdown rendering of extremely large docs OOMs the
    // webview; above the limit we show a notice instead of rendering.
    const limitChars =
      overLimitChars && overLimitChars > 0
        ? overLimitChars
        : text.length > PREVIEW_MAX_CHARS
          ? text.length
          : 0;
    const overLimit = limitChars > 0;
    const [html, setHtml] = useState(() =>
      overLimit ? "" : renderMarkdown(text),
    );
    const timer = useRef<number | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const onPreviewScrollRef = useRef(onPreviewScroll);
    onPreviewScrollRef.current = onPreviewScroll;
    const suppressRef = useRef(false);

    useEffect(() => {
      if (limitChars > 0) {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = null;
        setHtml("");
        return;
      }
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setHtml(renderMarkdown(text));
      }, debounceMs);
      return () => {
        if (timer.current) window.clearTimeout(timer.current);
      };
    }, [text, debounceMs, limitChars]);

    // After every HTML refresh: render mermaid diagrams and fix up local image
    // srcs (relative paths resolve against the document's folder; absolute
    // paths work even for unsaved docs). Local files are read via the Rust
    // command into base64 data URLs.
    const postProcessTimer = useRef<number | null>(null);
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (postProcessTimer.current) window.clearTimeout(postProcessTimer.current);
      postProcessTimer.current = window.setTimeout(() => {
        void renderMermaidIn(el);
        void fixupImages(el, basePath ?? null);
      }, 0);
      return () => {
        if (postProcessTimer.current) window.clearTimeout(postProcessTimer.current);
      };
    }, [html, basePath]);

    // Click interception: external http(s) links must never navigate the app
    // webview (window hijack / session loss) - route them to the OS browser.
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const onPreviewClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        const anchor = target?.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          void openExternal(href).catch(() => {});
        }
      };
      el.addEventListener("click", onPreviewClick, true);
      return () => el.removeEventListener("click", onPreviewClick, true);
    }, []);

    // Report the source line near the top of the preview viewport while
    // the user scrolls (throttled via rAF).
    const rafRef = useRef<number | null>(null);    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const report = () => {
        rafRef.current = null;
        if (suppressRef.current || !onPreviewScrollRef.current) return;
        const line = sourceLineAtTop(el);
        if (line > 0) onPreviewScrollRef.current(line);
      };
      const onScroll = () => {
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(report);
        }
      };
      el.addEventListener("scroll", onScroll);
      return () => {
        el.removeEventListener("scroll", onScroll);
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      };
    }, [html]);

    useImperativeHandle(ref, () => ({
      scrollToSourceLine(line: number) {
        const el = scrollRef.current;
        if (!el) return;
        suppressRef.current = true;
        el.scrollTop = offsetTopOfLine(el, line);
        requestAnimationFrame(() => {
          // Give the browser a frame to settle, then stop suppressing so user
          // scrolling is reported again.
          setTimeout(() => {
            suppressRef.current = false;
          }, 60);
        });
      },
    }));

    if (overLimit) {
      const wan = Math.ceil(limitChars / 10000);
      return (
        <div className="preview-scroll" ref={scrollRef}>
          <div
            className="preview-pane preview-disabled"
            style={{
              ...vars,
              fontFamily,
              fontSize: `${fontSize}px`,
            }}
          >
            <div className="preview-disabled-box">
              <div className="preview-disabled-title">预览已禁用</div>
              <p>
                当前文档约 <b>{wan}</b> 万字符，超过预览上限
                （{Math.round(PREVIEW_MAX_CHARS / 10000)} 万字符）。整篇渲染会占用
                大量内存并可能导致内存溢出（OOM）。
              </p>
              <p>请在编辑区查看与编辑内容；如需预览，请将文档拆分为更小的文件。</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="preview-scroll" ref={scrollRef}>
        <div
          className="preview-pane"
          style={{
            ...vars,
            fontFamily,
            fontSize: `${fontSize}px`,
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  },
);

/** Returns the nearest 1-based source line at the given scroll offset. */
function sourceLineAtTop(el: HTMLDivElement): number {
  const anchors = el.querySelectorAll<HTMLElement>("[data-line]");
  const scrollTop = el.scrollTop + 20;
  let best = 0;
  for (const a of anchors) {
    const top = offsetTopIn(el, a);
    if (top <= scrollTop) {
      best = Number(a.dataset.line ?? 0);
    } else {
      break;
    }
  }
  return best;
}

/** Scroll offset that brings a source line near the top of the preview. */
function offsetTopOfLine(el: HTMLDivElement, line: number): number {
  const anchors = el.querySelectorAll<HTMLElement>("[data-line]");
  let target: HTMLElement | null = null;
  for (const a of anchors) {
    const l = Number(a.dataset.line ?? 0);
    if (l >= line) {
      target = a;
      break;
    }
  }
  if (!target && anchors.length) {
    target = anchors[anchors.length - 1];
  }
  if (!target) return 0;
  return Math.max(0, offsetTopIn(el, target) - 12);
}

/** Element top relative to the scroll container's content origin. */
function offsetTopIn(container: HTMLElement, child: HTMLElement): number {
  const cRect = container.getBoundingClientRect();
  const eRect = child.getBoundingClientRect();
  return eRect.top - cRect.top + container.scrollTop;
}

/**
 * Rewrites <img src> of local files so the webview can load them.
 * - http(s)/data URLs are left untouched (resolveLocalImageSrc rejects them).
 * - Relative paths are resolved against the document directory (basePath).
 * - Absolute local paths are resolved even when the doc is unsaved
 *   (basePath == null).
 * - Local files are read through the Rust command into a base64 data URL
 *   (robust for CJK / space / any-character paths - the asset protocol and
 *   percent-encoding are deliberately not used here).
 */
async function fixupImages(container: HTMLElement, basePath: string | null): Promise<void> {
  // Relative srcs need a document dir; absolute srcs don't (resolveLocalImageSrc
  // handles those without baseDir). So baseDir may legitimately be null here.
  const baseDir = basePath ? dirnameOf(basePath) : null;
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  if (!imgs.length) return;

  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const local = resolveLocalImageSrc(src, baseDir);
    if (!local) continue; // remote/data URLs render natively
    try {
      const mime = mimeOfPath(local);
      img.src = await cachedImageDataUrl(local, mime);
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

function mimeOfPath(p: string): string {
  const i = p.lastIndexOf(".");
  const ext = i >= 0 ? p.slice(i + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
