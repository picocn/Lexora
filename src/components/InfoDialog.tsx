import { Modal } from "./Modal";

export type InfoKind = "usage" | "release" | "about" | "license";

const WIDTH: Record<InfoKind, number> = {
  usage: 560,
  release: 560,
  about: 560,
  license: 680,
};

/** MIT License text (mirrors the repository LICENSE file). */
const MIT_TEXT = `MIT License

Copyright (c) 2026 pico

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Main direct dependencies and their licenses (compliance summary). */
const THIRD_PARTY: Array<{ name: string; license: string; url: string }> = [
  { name: "CodeMirror 6 / @lezer", license: "MIT", url: "https://codemirror.net/" },
  { name: "React", license: "MIT", url: "https://reactjs.org/" },
  { name: "Vite", license: "MIT", url: "https://vitejs.dev/" },
  { name: "TypeScript", license: "Apache-2.0", url: "https://www.typescriptlang.org/" },
  { name: "KaTeX", license: "MIT", url: "https://katex.org/" },
  { name: "mermaid", license: "MIT", url: "https://mermaid.js.org/" },
  { name: "markdown-it", license: "MIT", url: "https://github.com/markdown-it/markdown-it" },
  { name: "highlight.js", license: "BSD-3-Clause", url: "https://highlightjs.org/" },
  { name: "Tauri / @tauri-apps", license: "Apache-2.0 / MIT", url: "https://tauri.app/" },
];

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
          <li><b>查找 / 替换</b> Ctrl+F 打开面板（含替换栏）；Enter 下一个、Shift+Enter 上一个；“全部替换”前会确认数量</li>
          <li><b>打开设置</b> Ctrl+,</li>
        </ul>
        <h3>自动保存（快照模式）</h3>
        <p>
          编辑中的改动会定时写入恢复快照（默认存于程序目录的 <b>autosave</b> 文件夹；
          程序目录不可写时自动回退到系统应用数据目录），<b>绝不覆盖原文件</b>。
          只有手动保存 / 另存为才会写原文件。
        </p>
        <p>
          <b>退出不弹保存询问</b>：退出时自动为每个未保存标签补写一次快照后直接退出；
          下次启动自动恢复为编辑标签（仍为未保存状态，手动保存才写盘），恢复提示约 5 秒后自动消失。
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
          <li>CodeMirror 6 多标签编辑，按扩展名自动语法高亮（md/yml/toml/html/css/js/ts/json/rust/python 等），支持手动指定语言；标签栏 ‹ › 切换 + 「＋」新建。</li>
          <li>定时自动保存仅写入恢复快照，原文件只由手动保存覆盖；启动自动恢复；退出不弹保存询问，自动为未保存标签补写快照后退出。</li>
          <li>Markdown 实时预览（xxx-预览 / 分屏 / 仅预览），GFM 表格 / 任务列表、LaTeX（KaTeX）、Mermaid、本地图片；超 800 万字符自动禁用预览防 OOM。</li>
          <li>查找/替换（Ctrl+F 面板，全部替换前确认数量）；大文件护栏：&gt;20MB 打开确认、后台打开、超大标签驻留上限与自动重载。</li>
          <li>内置浅/深主题，支持导入/删除 VS Code 主题 JSON；状态栏配色跟随主题（不再强制蓝）。</li>
          <li>字体 / 字号 / 行高 / 布局等设置持久化；编码：UTF-8 读写（含 BOM），UTF-16/32 提示转存，非 UTF-8 禁止原地覆盖。</li>
          <li>安全加固：生产 CSP、外部链接交给系统浏览器、导入主题颜色白名单、文件读取常规文件与大小预检。</li>
        </ul>
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
        <p>本项目遵循 <b>MIT License</b>（© 2026 pico），详见“帮助 → 许可证…”。</p>
      </div>
    ),
  },
  license: {
    title: "许可证",
    body: (
      <div className="info-body">
        <h3>本项目：Lexora</h3>
        <p>
          本项目遵循 <b>MIT License</b>（Copyright © 2026 pico）。完整文本如下，
          亦见仓库根目录 <code>LICENSE</code> 文件。
        </p>
        <pre className="license-text">{MIT_TEXT}</pre>

        <h3>第三方组件（合规说明）</h3>
        <p>
          本程序使用的下列主要开源组件按各自许可证分发，本项目不修改任何第三方
          源码，全部按其原始许可证使用：
        </p>
        <table className="license-table">
          <thead>
            <tr>
              <th>组件</th>
              <th>许可证</th>
              <th>官方链接</th>
            </tr>
          </thead>
          <tbody>
            {THIRD_PARTY.map((t) => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td>{t.license}</td>
                <td>
                  <a href={t.url} target="_blank" rel="noreferrer">
                    {t.url.replace(/^https?:\/\//, "")}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="license-note">
          上表为<b>主要直接依赖</b>汇总；其余依赖及各组件的<b>完整许可证全文</b>
          请见各包内 <code>LICENSE</code> 文件（npm 依赖位于
          <code> node_modules/&lt;包&gt;/LICENSE</code>；Rust crate 位于本机构建缓存的
          对应 crate 目录内）。界面基于系统 <b>Microsoft Edge WebView2 运行时</b>，
          按微软相关使用条款使用。
        </p>
      </div>
    ),
  },
};

export function InfoDialog({ kind, onClose }: { kind: InfoKind; onClose: () => void }) {
  const c = CONTENT[kind];
  return (
    <Modal title={c.title} onClose={onClose} width={WIDTH[kind]}>
      {c.body}
      <div className="modal-foot">
        <button className="btn primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
