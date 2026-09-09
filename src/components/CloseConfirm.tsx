import { Modal } from "./Modal";

export function CloseConfirm(props: {
  /** Document title of the tab being closed. */
  title: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={`“${props.title}” 含未保存的更改`} onClose={props.onCancel} width={520}>
      <p className="hint">
        保存将写入原文件；若选择不保存，该标签的更改与对应自动保存快照都会被清除。
      </p>
      <div className="modal-foot">
        <button className="btn primary" onClick={props.onSave}>
          保存
        </button>
        <button className="btn danger" onClick={props.onDiscard}>
          不保存并关闭
        </button>
        <button className="btn" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </Modal>
  );
}
