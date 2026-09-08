import type { ReactNode } from "react";

export function Modal(props: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal"
        style={{ width: props.width ?? 560 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <span>{props.title}</span>
          <button className="modal-x" onClick={props.onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
