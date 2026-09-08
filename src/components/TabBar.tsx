import type { TabView } from "./appState";

export interface TabBarProps {
  tabs: TabView[];
  activeId: string | null;
  /** True when the active editor tab is markdown (preview button available). */
  canPreview: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPreview: () => void;
}

export function TabBar(p: TabBarProps) {
  return (
    <div className="tabbar">
      <div className="tabbar-scroll">
        {p.tabs.map((t) => (
          <div
            key={t.id}
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
        {p.tabs.length === 0 && <span className="tabbar-empty">mdpad</span>}
      </div>
      <div className="tabbar-actions">
        {p.canPreview && (
          <button className="btn preview-btn" onClick={p.onPreview} title="在标签页中预览 Markdown">
            ▶ 预览
          </button>
        )}
      </div>
    </div>
  );
}
