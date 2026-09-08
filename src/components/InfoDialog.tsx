import { Modal } from "./Modal";

export type InfoKind = "usage" | "release" | "about";

const CONTENT: Record<InfoKind, { title: string; body: React.ReactNode }> = {
  usage: {
    title: "使用说明",
    body: (
      <div className="info-body">
        <h3>快速上手</h3>
        <ul>
          <li><b>新建标签</b> Ctrl+N　·　<b>打开文件</b> Ctrl+O</li>
          <li><b>保存</b> Ctrl+S　·　<b>另存为</b> Ctrl+Shift+S</li>
          <li><b>关闭标签</b> Ctrl+W　·　<b>切换布局</b> F5</li>
          <li><b>打开设置</b> Ctrl+,</li>
        </ul>
        <h3>自动保存（快照模式）</h3>
        <p>
          编辑中的改动会定时写入恢复快照（默认存于程序目录的 <b>autosave</b> 文件夹；
          程序目录不可写时自动回退到系统应用数据目录），<b>绝不覆盖原文件</b>。
          只有手动保存 / 另存为才会写原文件。启动时检测到快照会<b>自动恢复</b>为编辑标签。
        </p>
        <h3>Markdown 预览</h3>
        <p>
          正在编辑 Markdown 文档时，标签栏会显示 <b>▶ 预览</b> 按钮（也可用“文件 → 预览”）。
          点击后在新的 <b>xxx-预览</b> 标签页中实时渲染当前内容。
        </p>
        <h3>主题</h3>
        <p>设置中可导入 VS Code 主题 JSON（colors + tokenColors，尽力映射），或切换内置浅色/深色主题。</p>
      </div>
    ),
  },
  release: {
    title: "版本说明",
    body: (
      <div className="info-body">
        <h3>v{__APP_VERSION__}</h3>
        <ul>
          <li>CodeMirror 6 多标签编辑，按扩展名自动语法高亮（md/yml/toml/html/css/js/ts/json/rust/python 等），支持手动指定语言。</li>
          <li>定时自动保存仅写入恢复快照，原文件只由手动保存覆盖；启动提供快照恢复。</li>
          <li>Markdown 实时预览标签页（xxx-预览），GFM 表格 / 删除线 / 任务列表，内嵌 HTML 不渲染（安全）。</li>
          <li>内置浅色/深色主题，支持导入 VS Code 主题 JSON。</li>
          <li>字体 / 字号 / 行高 / 布局等设置持久化。</li>
        </ul>
        <p>编码：UTF-8（含 BOM）正常读写；UTF-16/32 文件会提示先转存 UTF-8；其他非 UTF-8 编码尽力解码显示，但不允许原地覆盖（请用“另存为”转存）。预览不执行脚本。</p>
      </div>
    ),
  },
  about: {
    title: "关于 Lexora",
    body: (
      <div className="info-body">
        <p><b>Lexora</b> v{__APP_VERSION__}</p>
        <p>轻量级 Markdown 多标签编辑器。</p>
        <p>技术栈：Rust · Tauri 2 · React · CodeMirror 6</p>
      </div>
    ),
  },
};

export function InfoDialog({ kind, onClose }: { kind: InfoKind; onClose: () => void }) {
  const c = CONTENT[kind];
  return (
    <Modal title={c.title} onClose={onClose} width={560}>
      {c.body}
      <div className="modal-foot">
        <button className="btn primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
