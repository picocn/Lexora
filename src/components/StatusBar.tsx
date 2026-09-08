import type { CSSProperties } from "react";
import { LANGUAGE_CHOICES } from "../editor/languages";
import type { CursorInfo } from "../editor/docBus";

export interface StatusBarProps {
  tabTitle: string | null;
  dirty: boolean;
  language: string;
  languageOverride: string | null;
  onLanguageChange: (key: string) => void;
  autosaveText: string;
  layout: string;
  onCycleLayout: () => void;
  vars: CSSProperties;
  /** Preview tabs are read-only views - hide the language picker. */
  readonly?: boolean;
  /** Cursor position + selection info for the active editor tab. */
  cursor?: CursorInfo | null;
}

function formatSelection(c: CursorInfo): string {
  const len = Intl.NumberFormat("zh-CN").format(c.selChars);
  const lines = Intl.NumberFormat("zh-CN").format(c.selLines);
  return `已选 ${lines} 行 · ${len} 字`;
}

export function StatusBar(p: StatusBarProps) {
  const cur = p.readonly ? null : p.cursor;
  return (
    <div className="statusbar" style={p.vars}>
      <span className="status-left">
        {p.tabTitle ? (
          <>
            {p.readonly ? (
              <span className="st-clean">◉ 预览</span>
            ) : p.dirty ? (
              <span className="st-dirty">● 未保存</span>
            ) : (
              <span className="st-clean">已保存</span>
            )}
            <span className="st-sep">|</span>
            <span>{p.tabTitle}</span>
          </>
        ) : (
          <span>就绪</span>
        )}
      </span>
      <span className="status-cursor">
        {cur ? (
          cur.hasSel ? (
            <>
              <span className="cursor-pos">
                行 {cur.line}, 列 {cur.col}
              </span>
              <span className="st-sep">|</span>
              <span className="cursor-sel">{formatSelection(cur)}</span>
            </>
          ) : (
            <span className="cursor-pos">
              行 {cur.line}, 列 {cur.col}
            </span>
          )
        ) : (
          ""
        )}
      </span>
      <span className="status-right">
        <span className="autosave-status">{p.autosaveText}</span>
        {!p.readonly && (
          <label className="lang-picker">
            语言
            <select
              value={p.languageOverride ?? "auto"}
              onChange={(e) => p.onLanguageChange(e.target.value)}
            >
              <option value="auto">自动 ({p.language})</option>
              {LANGUAGE_CHOICES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="layout-toggle" onClick={p.onCycleLayout} title="切换布局 (F5)">
          {p.layout === "split" ? "分屏" : p.layout === "edit" ? "仅编辑" : "仅预览"}
        </button>
      </span>
    </div>
  );
}
