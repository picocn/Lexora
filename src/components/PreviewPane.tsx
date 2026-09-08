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
import { dirnameOf, inTauri, resolveLocalImageSrc } from "../preview/imagePath";

export interface PreviewPaneHandle {
  /** Scroll the preview so the markdown source line appears near the top. */
  scrollToSourceLine(line: number): void;
}

export interface PreviewPaneProps {
  text: string;
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
    { text, fontFamily, fontSize, vars, debounceMs = 300, basePath, onPreviewScroll },
    ref,
  ) {
    const [html, setHtml] = useState(() => renderMarkdown(text));
    const timer = useRef<number | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const onPreviewScrollRef = useRef(onPreviewScroll);
    onPreviewScrollRef.current = onPreviewScroll;
    const suppressRef = useRef(false);

    useEffect(() => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setHtml(renderMarkdown(text));
      }, debounceMs);
      return () => {
        if (timer.current) window.clearTimeout(timer.current);
      };
    }, [text, debounceMs]);

    // After every HTML refresh: render mermaid diagrams and fix up local image
    // srcs (relative paths are resolved against the document's folder, then
    // converted to the Tauri asset protocol URL).
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

    // Report the source line near the top of the preview viewport while
    // the user scrolls (throttled via rAF).
    const rafRef = useRef<number | null>(null);
    useEffect(() => {
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
 * - http(s)/data URLs are left untouched.
 * - Relative paths are resolved against the document directory.
 * - Under Tauri the absolute local path is converted to the asset protocol.
 */
async function fixupImages(container: HTMLElement, basePath: string | null): Promise<void> {
  if (!basePath) return; // nothing to resolve without a document path
  const baseDir = dirnameOf(basePath);
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  if (!imgs.length) return;

  const { convertFileSrc } = await import("@tauri-apps/api/core").catch(() => ({ convertFileSrc: null as null }));
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const local = resolveLocalImageSrc(src, baseDir);
    if (!local) continue; // remote/data/asset URLs render natively
    if (inTauri() && convertFileSrc) {
      img.src = convertFileSrc(local);
      img.onerror = () => {
        img.onerror = null;
        img.setAttribute("title", `无法加载图片：${src}`);
      };
    } else {
      // Browser preview: point at the plain local path.
      img.src = local.replace(/\\/g, "/");
    }
  }
}
