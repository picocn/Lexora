import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { renderMarkdown } from "../preview/render";

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
  /** Called with the markdown line at the preview viewport top while scrolling. */
  onPreviewScroll?: (line: number) => void;
}

/** Renders the edited markdown (html:false enforced by render.ts).
 * Block-level elements carry data-line anchors from the renderer, used by
 * split-view scroll sync. */
export const PreviewPane = forwardRef<PreviewPaneHandle, PreviewPaneProps>(
  function PreviewPane(
    { text, fontFamily, fontSize, vars, debounceMs = 300, onPreviewScroll },
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
