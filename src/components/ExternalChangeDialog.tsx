import { Modal } from "./Modal";
import { describeExternalChange, formatStat, type FileStat } from "../files/externalChange";

/** Raised when a file that is open in a tab changed on disk (outside
 * Lexora). Offers to reload from disk or to keep the current buffer. */
export function ExternalChangeDialog(props: {
  title: string;
  path: string;
  dirty: boolean;
  current: FileStat;
  /** How many further files are waiting behind this prompt. */
  remaining: number;
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <Modal title="文件已在外部被修改" width={520} onClose={props.onKeep}>
      <div className="info-body">
        <p>{describeExternalChange(props.path, props.dirty)}</p>
        <p className="hint">
          <b>{props.title}</b> · 磁盘上当前：{formatStat(props.current)}
        </p>
        {props.remaining > 0 && (
          <p className="hint">还有 {props.remaining} 个文件待确认。</p>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={props.onReload}>
          重新加载
        </button>
        <button className="btn" onClick={props.onKeep}>
          {props.dirty ? "保留当前编辑" : "忽略"}
        </button>
      </div>
    </Modal>
  );
}
