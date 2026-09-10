import { Modal } from "./Modal";
import { printModeLabel, type PrintMode } from "../print/build";

/** Mode picker shown when printing a Markdown document: rendered preview or
 * the raw Markdown source. Non-Markdown documents print their raw text and
 * never reach this dialog. */
export function PrintDialog(props: {
  title: string;
  modes: PrintMode[];
  onPick: (mode: PrintMode) => void;
  onCancel: () => void;
}) {
  const ordered: PrintMode[] = props.modes.includes("preview")
    ? ["preview", ...props.modes.filter((m) => m !== "preview")]
    : [...props.modes];
  return (
    <Modal title="打印" width={460} onClose={props.onCancel}>
      <div className="info-body">
        <p>
          打印 <b>{props.title}</b>，请选择打印内容：
        </p>
        <p className="hint">
          “打印预览版”会先渲染 Markdown（表格、代码块、公式、图片按页面排版）；
          “打印原始文本”直接打印 Markdown 源文件。
        </p>
      </div>
      <div className="modal-foot">
        {ordered.map((m) => (
          <button
            key={m}
            className={m === "preview" ? "btn primary" : "btn"}
            onClick={() => props.onPick(m)}
          >
            {printModeLabel(m)}
          </button>
        ))}
        <button className="btn" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </Modal>
  );
}
