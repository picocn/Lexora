import { Modal } from "./Modal";

export type CloseKind = "close-tab" | "quit";

export interface CloseConfirmProps {
  kind: CloseKind;
  count: number;
  titles: string[];
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function CloseConfirm(p: CloseConfirmProps) {
  const quitting = p.kind === "quit";
  const head = quitting
    ? `有 ${p.count} 个标签页含未保存的更改`
    : `“${p.titles[0] ?? ""}” 含未保存的更改`;
  return (
    <Modal title={head} onClose={p.onCancel} width={520}>
      {quitting ? (
        <p className="hint">
          <b>保存并退出</b>：写入原文件后退出（手动保存是唯一写原文件的途径）。<br />
          <b>不保存退出</b>：保留自动保存快照并退出，下次启动会恢复这些内容。<br />
          <b>取消</b>：不退出，继续编辑。
        </p>
      ) : (
        <p className="hint">
          保存将写入原文件；若选择不保存，该标签的更改与对应自动保存快照都会被清除。
        </p>
      )}
      {p.titles.length > 1 && (
        <ul className="small-list">
          {p.titles.slice(0, 8).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <div className="modal-foot">
        {quitting ? (
          <>
            <button className="btn primary" onClick={p.onSave}>
              保存并退出
            </button>
            <button className="btn" onClick={p.onDiscard}>
              不保存退出
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={p.onSave}>
              保存
            </button>
            <button className="btn danger" onClick={p.onDiscard}>
              不保存并关闭
            </button>
          </>
        )}
        <button className="btn" onClick={p.onCancel}>
          取消
        </button>
      </div>
    </Modal>
  );
}
