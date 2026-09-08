import { useEffect, useRef } from "react";
import type { TabView } from "./appState";

export interface TabBarProps {
  tabs: TabView[];
  activeId: string | null;
  /** True when the active editor tab is markdown (preview button available). */
  canPreview: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPreview: () => void;
  /** Opens a new untitled editor tab (Ctrl+N). */
  onNewTab: () => void;
}

export function TabBar(p: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab visible when it is activated through the arrows, the
  // +/open flows, or session restore. Native scrollbar is hidden; this is the
  // only way to move along a long tab strip.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !p.activeId) return;
    const target = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(p.activeId)}"]`);
    target?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [p.activeId, p.tabs.length]);

  const n = p.tabs.length;
  const idx = p.activeId ? p.tabs.findIndex((t) => t.id === p.activeId) : -1;
  // 上一个 / 下一个（两端循环；无活动标签时上箭头到最后、下箭头到第一个）。
  const prevTarget = idx > 0 ? p.tabs[idx - 1].id : n > 0 ? p.tabs[n - 1].id : null;
  const nextTarget = idx >= 0 && idx < n - 1 ? p.tabs[idx + 1].id : n > 0 ? p.tabs[0].id : null;

  return (
    <div className="tabbar">
      <div className="tabbar-nav">
        <button
          className="tab-arrow"
          disabled={n === 0}
          onClick={() => prevTarget && p.onActivate(prevTarget)}
          title="上一个标签"
          aria-label="上一个标签"
        >
          ‹
        </button>
        <button
          className="tab-arrow"
          disabled={n === 0}
          onClick={() => nextTarget && p.onActivate(nextTarget)}
          title="下一个标签"
          aria-label="下一个标签"
        >
          ›
        </button>
      </div>

      <div className="tabbar-scroll" ref={scrollRef}>
        {p.tabs.map((t) => (
          <div
            key={t.id}
            data-tab-id={t.id}
            className={`tab ${t.active ? "active" : ""} ${t.kind === "preview" ? "preview-tab" : ""}`}
            title={t.path ?? t.title}
            onClick={() => p.onActivate(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) p.onClose(t.id);
            }}
          >
            {t.kind === "preview" && <span className="tab-preview-badge">◉</span>}
            <span className="tab-title">{t.title}</span>
            {t.kind === "editor" && t.dirty && <span className="dirty-dot" aria-label="未保存" />}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                p.onClose(t.id);
              }}
              aria-label="关闭标签"
            >
              ×
            </button>
          </div>
        ))}
        {p.tabs.length === 0 && <span className="tabbar-empty">Lexora</span>}
      </div>

      <div className="tabbar-actions">
        <button
          className="tab-new"
          onClick={p.onNewTab}
          title="新建标签 (Ctrl+N)"
          aria-label="新建标签"
        >
          ＋
        </button>
        {p.canPreview && (
          <button className="btn preview-btn" onClick={p.onPreview} title="在标签页中预览 Markdown">
            ▶ 预览
          </button>
        )}
      </div>
    </div>
  );
}
