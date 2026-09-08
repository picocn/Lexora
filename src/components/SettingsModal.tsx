import { useState } from "react";
import type { AppSettings } from "../ipc/commands";
import { DEFAULT_SETTINGS } from "../ipc/commands";
import { Modal } from "./Modal";

export interface ThemeChoice {
  id: string;
  label: string;
}

export interface FontPickResult {
  family: string;
  sizePx: number;
}

export interface SettingsModalProps {
  settings: AppSettings;
  themeChoices: ThemeChoice[];
  /** Persist settings then quit the app. */
  onSaveAndQuit: (s: AppSettings) => void;
  /** Discard changes and close the settings dialog. */
  onCancel: () => void;
  onImportVscodeTheme: () => Promise<void>;
  /** Opens the OS font dialog for the editor font. */
  onPickEditorFont: (current: AppSettings) => Promise<FontPickResult | null>;
  /** Opens the OS font dialog for the preview font. */
  onPickPreviewFont: (current: AppSettings) => Promise<FontPickResult | null>;
}

/** The leading family of a CSS font stack (for the OS dialog seed). */
export function firstFamilyOf(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "");
}

/** Render a CSS font-family stack from a single family name. */
export function stackOf(family: string): string {
  return `${family}, sans-serif`;
}

export function SettingsModal(p: SettingsModalProps) {
  const [draft, setDraft] = useState<AppSettings>(() =>
    structuredClone(p.settings) ?? structuredClone(DEFAULT_SETTINGS),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof AppSettings>(key: K, val: AppSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: val }));

  const pick = async (which: "editor" | "preview") => {
    setErr(null);
    setBusy(true);
    try {
      const res =
        which === "editor"
          ? await p.onPickEditorFont(draft)
          : await p.onPickPreviewFont(draft);
      if (!res) return; // cancelled
      if (which === "editor") {
        setDraft((d) => ({
          ...d,
          editor: { ...d.editor, fontFamily: stackOf(res.family), fontSize: res.sizePx },
        }));
      } else {
        setDraft((d) => ({
          ...d,
          preview: { ...d.preview, fontFamily: stackOf(res.family), fontSize: res.sizePx },
        }));
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="设置" onClose={p.onCancel} width={640}>
      <div className="settings-grid">
        <fieldset>
          <legend>自动保存（仅快照，不覆盖原文件）</legend>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.autosave.enabled}
              onChange={(e) => set("autosave", { ...draft.autosave, enabled: e.target.checked })}
            />
            启用自动保存快照
          </label>
          <label className="row">
            间隔（秒）
            <input
              type="number"
              min={1}
              max={3600}
              value={draft.autosave.intervalSec}
              disabled={!draft.autosave.enabled}
              onChange={(e) =>
                set("autosave", { ...draft.autosave, intervalSec: Math.max(1, +e.target.value) })
              }
            />
          </label>
          <p className="hint">未保存的改动会定时写入应用数据目录，只有手动保存才会写入原文件。</p>
        </fieldset>

        <fieldset>
          <legend>编辑器</legend>
          <div className="row">
            <span>字体</span>
            <div className="font-pick">
              <button className="btn" disabled={busy} onClick={() => void pick("editor")}>
                选择字体…
              </button>
              <span className="font-current">
                {firstFamilyOf(draft.editor.fontFamily)} · {draft.editor.fontSize}px
              </span>
            </div>
          </div>
          <label className="row">
            字号
            <input
              type="number"
              min={8}
              max={96}
              value={draft.editor.fontSize}
              onChange={(e) =>
                set("editor", { ...draft.editor, fontSize: Math.max(8, +e.target.value) })
              }
            />
            px
          </label>
          <label className="row">
            行高
            <input
              type="number"
              min={1}
              max={3}
              step={0.1}
              value={draft.editor.lineHeight}
              onChange={(e) =>
                set("editor", { ...draft.editor, lineHeight: Math.max(1, +e.target.value) })
              }
            />
          </label>
          <label className="row">
            制表符宽度
            <input
              type="number"
              min={1}
              max={16}
              value={draft.editor.tabSize}
              onChange={(e) =>
                set("editor", { ...draft.editor, tabSize: Math.min(16, Math.max(1, +e.target.value)) })
              }
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.editor.wordWrap}
              onChange={(e) => set("editor", { ...draft.editor, wordWrap: e.target.checked })}
            />
            自动换行
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.editor.lineNumbers}
              onChange={(e) => set("editor", { ...draft.editor, lineNumbers: e.target.checked })}
            />
            显示行号
          </label>
        </fieldset>

        <fieldset>
          <legend>预览</legend>
          <div className="row">
            <span>字体</span>
            <div className="font-pick">
              <button className="btn" disabled={busy} onClick={() => void pick("preview")}>
                选择字体…
              </button>
              <span className="font-current">
                {firstFamilyOf(draft.preview.fontFamily)} · {draft.preview.fontSize}px
              </span>
            </div>
          </div>
          <label className="row">
            字号
            <input
              type="number"
              min={8}
              max={96}
              value={draft.preview.fontSize}
              onChange={(e) =>
                set("preview", { ...draft.preview, fontSize: Math.max(8, +e.target.value) })
              }
            />
            px
          </label>
        </fieldset>

        <fieldset>
          <legend>主题与布局</legend>
          <label className="row">
            主题
            <select
              value={draft.theme.kind === "builtin" ? `builtin:${draft.theme.id}` : draft.theme.id}
              onChange={(e) => {
                const val = e.target.value;
                const kind = val.startsWith("builtin:") ? "builtin" : "vscode";
                const id = kind === "builtin" ? val.slice("builtin:".length) : val;
                set("theme", { kind, id });
              }}
            >
              {p.themeChoices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            onClick={async () => {
              setErr(null);
              try {
                await p.onImportVscodeTheme();
              } catch (e) {
                setErr(String(e));
              }
            }}
          >
            导入 VS Code 主题 JSON…
          </button>
          <label className="row">
            布局
            <select
              value={draft.layout}
              onChange={(e) => set("layout", e.target.value as AppSettings["layout"])}
            >
              <option value="split">分屏（编辑 + 预览）</option>
              <option value="edit">仅编辑</option>
              <option value="preview">仅预览</option>
            </select>
          </label>
        </fieldset>
        {err && <div className="form-error">{err}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={() => p.onSaveAndQuit(draft)}>
          保存并退出
        </button>
        <button className="btn" onClick={p.onCancel}>
          取消
        </button>
      </div>
      <p className="modal-note">“保存并退出”将保存设置并关闭设置页，不会退出应用。</p>
    </Modal>
  );
}
