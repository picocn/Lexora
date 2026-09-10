# Lexora

轻量级 Markdown 多标签编辑器 —— Rust (Tauri 2) + React + CodeMirror 6。

## 界面与交互

> **绿色便携目录约定**：配置（`settings.json`、`window.json`、`session.json`）保存在可执行文件同目录的
> **`settings\`** 下；自动保存恢复快照保存在可执行文件同目录的 **`autosave\`** 下。
> 若可执行文件所在目录不可写（例如安装在 `C:\Program Files`），会自动回退到系统
> 应用数据目录并保持原有行为。

- **单行顶栏（VSCode 风格）**：菜单不常驻——点击 **图标 + Lexora** 弹出纵向 文件/编辑/帮助，一级悬停展开**右侧二级面板**（面板与一级条目顶部对齐、斜向移动 180ms 内不消失、选择命令后下拉自动收起）；标签条内嵌同一行中段；右侧 `🔎` 预览 / ＋ 新建 / 最小化·最大化-还原·关闭（Edge 风格宽按钮，最大化图标跟随真实窗口状态）。顶栏空白区可拖动窗口、双击最大化，按钮上按下不会误触发拖拽。
  - **文件**：新建标签(Ctrl+N)、打开…(Ctrl+O)、最近打开（上限 20）、保存(Ctrl+S)、另存为…(Ctrl+Shift+S)、预览 Markdown(Ctrl+P)、打印…(Ctrl+Shift+P)、**退出**。
  - **编辑**：撤销(Ctrl+Z)、重做(Ctrl+Y)、剪切/复制/粘贴/全选、查找…(Ctrl+F)、替换…、全部替换…(执行前确认)、设置…(Ctrl+,)。（作用于当前编辑器。）
  - **帮助**：使用说明、版本说明、许可证…（本项目 MIT License 全文 + 主要第三方组件许可证合规说明）、关于。
- **会话恢复**：退出时把当前打开的文件列表保存到 `session.json`；下次启动自动重新打开这些文件（含激活标签），并优先恢复未保存的快照内容。
- **退出行为**：菜单“退出”或窗口关闭按钮都走同一条关闭请求 → 先保存会话，再为所有带未保存改动的标签**自动补写一次恢复快照**（不写原文件、不弹保存询问），然后直接退出；下次启动自动恢复这些内容为未保存的编辑标签。启动恢复提示 5 秒后自动消失。
- **关闭单个未保存标签**：弹窗 **保存 / 不保存并关闭 / 取消**；“不保存并关闭”会**删除该标签的快照**。
- **标签与布局**：默认窗口只显示**编辑框**（布局=仅编辑）；通过状态栏布局按钮或 F5 可切换 仅编辑 ⇄ 分屏 ⇄ 仅预览，该布局功能保留（标签条见顶栏说明）。
- **状态栏**：编辑时显示当前光标 **行/列**；选中正文时额外显示**选中的行数与字数**。
- **Markdown / HTML 预览**：正在编辑可预览文档（Markdown 或 .html/.htm）时，顶栏 `🔎` 与“文件”菜单会出现 **预览** 入口；
  点击会在新标签页打开 **`文件名-预览`**，实时渲染当前源文档内容（只读）。关闭源编辑标签会连带关闭其预览标签。
  - Markdown：GFM 表格/任务列表、LaTeX、Mermaid、本地图片。
  - **锚点与目录**：标题自动生成锚点（重复标题自动去重 `-2/-3`）；支持 GitLab 风格 `## 标题 {#custom-id}` 自定义锚点（含中英文/全角字符）；独立成段的 `[TOC]` 渲染为可点击目录；点击目录/锚点在预览区内即时准确定位，外链交给系统浏览器。
  - HTML：**沙箱化静态预览**（iframe `sandbox`，脚本/表单/对象/顶层导航全部禁用，内联/远程 CSS 允许），本地图片以内联 data URL 显示；点击外链交给系统浏览器。
  - 超过 800 万字符的文档**自动禁用预览**（整篇渲染会 OOM），显示提示而非渲染。
- **语法高亮**：打开文件后按扩展名自动确定语言并高亮（md/yml/toml/html/css/js/ts/json/rust/python/java/c/c++/c#/go/sql/sh/ps1/php/rb/xml 等），未知类型为纯文本；状态栏可手动指定语言（含 Markdown 覆盖，使未命名标签也能预览）。
- **设置**：编辑器与预览的字体、字号通过 **Windows 系统字体对话框**选择（也可用字号框微调）；主题内置浅/深或导入 VS Code JSON（导入的 VS Code 主题可在设置中删除）；**顶栏、标签条、菜单弹层、最近打开列表与各对话框统一跟随所选主题配色**；布局选项保留。“保存并退出”= 保存设置并**关闭设置页**（不会退出应用）。
- **拖放打开**：把文件从资源管理器拖到窗口任意位置即可打开（文件夹与图片/压缩包等非文本文件会被忽略并提示）。
- **从外部打开文件**：资源管理器右键“打开方式 → Lexora”或 `lexora.exe 文档.md` 会直接打开该文件；应用已在运行时再次打开会把文件送到现有窗口（单实例转发），不会新开一份进程。
- **文件关联**：设置 → 文件 → “注册为默认 .md 打开方式”可把 `.md` 关联到 Lexora（写入当前用户注册表 `HKCU`，无需管理员）；可随时“取消注册”。若 Windows 已存在 `.md` 的用户选择（UserChoice），系统会优先使用它，可点“Windows 默认应用设置…”手动改为 Lexora。
- **外部修改检测**：已打开文件在磁盘上被其它程序修改（修改时间或大小变化）时弹窗询问 **重新加载 / 保留当前编辑**；“重新加载”会用磁盘内容替换该标签并清理过期快照，“保留”则忽略本次变化（再次变化仍会提示）。可在设置中关闭。
- **打印**：文件 → 打印…（Ctrl+Shift+P）。Markdown 可选择**打印预览版**（渲染后的排版：标题/表格/代码块/公式/图片）或**打印原始文本**（Markdown 源码）；其它文本文件直接打印原始文本。打印在独立窗口中完成，不包含应用界面与标签栏。

## 核心安全语义：自动保存 = 纯快照

- 定时（默认 5 秒，可配/可关）把每个有未保存改动的**编辑**标签写入应用数据目录恢复快照；
- **自动保存从不覆盖原文件**；原文件唯一写入路径是用户手动保存/另存为；
- **启动时自动恢复**上次退出时未保存（或崩溃遗留）的快照为编辑标签，内容=快照、磁盘锚点=当前文件内容，仍需手动保存才会写盘；
- “退出”为所有仍带未保存改动的标签补写最新快照后退出（下次启动自动恢复），**不再弹保存确认**；已撤销回到磁盘内容（不再有未保存改动）的标签会删除其过期快照；“关闭单个标签 → 不保存并关闭”删除该标签的快照。

后端仅 `commands/files.rs::write_text_file` 能写真实文件；前端自动保存路径（`tabs/autosave.ts` 决策表）从不调用它——该不变式由 `src/tabs/autosave.test.ts` 覆盖。

## VS Code 主题导入（尽力映射）

读取主题 JSON 的 `colors` 与 `tokenColors`：`editor.background/foreground/selectionBackground/lineHighlightBackground`、`editorGutter.background`、`editorLineNumber.foreground`、`editorCursor.foreground` → CodeMirror 基础主题；`tokenColors` 按文件顺序把 TextMate **一级 scope 组**映射到 CodeMirror 高亮标签（comment/string/keyword/constant.numeric/entity.name.function/entity.name.type/variable/punctuation/operator/markup.*/invalid 等，先到先得）。细粒度子作用域会折叠到一级组；`fontStyle` 不映射；效果为“接近”，非逐像素。

## 开发

```bash
npm install            # 依赖
npm run tauri dev      # 开发窗口
npm test               # vitest（前端纯逻辑）
cargo test             # 后端（在 src-tauri 内）
npm run build          # tsc + vite build
npm run tauri:build    # 正式发布构建：版本号 +1（0.1.9→0.2.0 规则）后产出 Windows 安装包
npx tauri build        # 仅构建、不升版本号（通常调试用）
```

> 本机网络受限时：schannel 不可用则 cargo 需经本地 Node 稀疏代理
> （`scripts/crates-proxy.mjs` + `CARGO_HOME` 下 config.toml）拉取 crates.io。

## 目录结构

- `src/` React 前端（`components/`、`editor/`、`tabs/`、`preview/`、`ipc/`、`styles/`）
- `src-tauri/` Rust 后端（`commands/{files,snapshots,settings}.rs`）
- `docs/` 项目文档：`requirements.zh.md`（需求）、`design.zh.md`（设计）、`acceptance.zh.md`（验收清单）、`release-notes.md`（发布说明）、`large-file-strategy.zh.md`（性能/大文件方案）
- `scripts/crates-proxy.mjs`、`scripts/gen-icon.mjs`
