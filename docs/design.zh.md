# Lexora 设计文档（Design）

- 适用版本：0.4.1
- 配套：`requirements.zh.md`、`acceptance.zh.md`、`large-file-strategy.zh.md`、`release-notes.md`、`migration-go-wails3.zh.md`（Go + Wails 3 迁移规划设计）

## 1. 总体架构
```
┌────────────────────────────────────────────────────────────┐
│ React 18 渲染层（WebView2，生产 CSP 由 tauri 注入）          │
│  App.tsx 状态编排  ·  components/* UI  ·  tabs/ 状态机      │
│  editor/ CodeMirror6  ·  preview/ 渲染  ·  files/ 文件输入   │
│  print/ 打印文档  ·  ipc/ 命令封装                          │
│  PrintView（label=print 的窗口渲染打印内容，非工作台）        │
├────────────────────────────────────────────────────────────┤
│ Tauri 2 IPC（invoke + 能力授权 capabilities/default.json）   │
│  单实例插件：第二次启动把 argv 转发给现有实例（open-paths）    │
├────────────────────────────────────────────────────────────┤
│ Rust 后端（src-tauri）                                      │
│  commands/{files,snapshots,settings,session,font,bench,    │
│            launch,assoc,print_doc}                         │
│  paths.rs（可移植目录）  window_state.rs（几何持久化）       │
│  本地文件系统（原文件 / settings\ / autosave\）· HKCU 关联   │
└────────────────────────────────────────────────────────────┘
```
- 单进程多 WebView 子进程（WebView2 实际内存都落在 msedgewebview2.exe 侧，主进程约 27MB）。
- 前端纯逻辑放在 `tabs/store.ts`、`tabs/thresholds.ts`、`preview/render.ts` 等可单测模块；组件不直接持有业务数据（`App` 唯一真相持有者，`tabsRef` 镜像）。
- 多组件异步写回并发（tabCompsCache）：Compartment 只用于语言/主题/偏好重配置，不参与文档真值。

## 2. 关键数据结构
### Tab / TabsState（src/tabs/types.ts）
- `TabModel`：id(kind 前缀 file:/untitled:/preview:)、title、path、docKey(=path 或未命名 id)、sourceTabId、manualSaved、diskContent、utf8Ok/utf8Bom、languageOverride
- `Tab`：model + `cmState`(EditorState) + `comps`(lang/theme/prefs Compartment) + langExt + lastSnapshotContent + `unloaded?`
  - `unloaded=true`：L3 退化为占位（保留 id/顺序/languageOverride，`diskContent` 清空以免脏判定误判），激活时原地重载
- `TabsState`：tabs[] + activeId + nextUntitled
- 脏判定 `tabDirty(tab)`：**先比 `doc.length` 再比 `toString()`**，避免每次 tick 对超大文档做全量字符串化（性能不变量）

### 阈值集中定义（src/tabs/thresholds.ts）
| 常量 | 值 | 用途 |
|---|---|---|
| `LARGE_FILE_WARN_BYTES` | 20 MB | 手动打开前的确认阈值（L1） |
| `UNLOAD_BIG_CHARS` | 40,000,000 | 超大文档（L2/L3）判定 |
| `KEEP_LOADED_BIG` | 4 | 超大干净标签常驻上限（L3） |
| `SESSION_SKIP_BYTES` | 64 MB | 会话恢复跳过阈值 |
| `PREVIEW_MAX_CHARS` | 8,000,000 | 预览 OOM 护栏 |

### AppSettings（settings.json）
autosave{enabled,intervalSec}、editor{fontFamily,fontSize,lineHeight,tabSize,wordWrap,lineNumbers}、preview{fontFamily,fontSize}、theme{kind:'builtin'|'vscode',id}、layout:'split'|'edit'|'preview'、recentFiles(≤20)、files{watchExternal}
- 读取为“默认值对象 + 覆盖合并”（serde 缺字段默认；前端 settings 会话恢复跳过超大）。
- 数字字段容错：u64 字段经浮点取整 deserializer 接受小数输入。
- 最近文件两侧裁剪：前端 `pushRecent` 与 Rust `read_settings` 均 `take(20)`。

### 快照（autosave/<stem>.md + <stem>.meta.json）
- stem = 可读前缀(≤80) + `-hash`（对 docKey 哈希）；写入 sanitize，读取 resolve_stem 双重约定（列表 stem / 原始 docKey），**拒绝路径分隔符/驱动符/`..`**（防穿越）
- meta：{originalPath,title,modifiedAtMs}
- 读取时校验 `meta.originalPath` 哈希回落到当前 stem，不一致即丢弃（防止伪造/错配快照把内容写到别的文件）
- `snapshot_list` 只读每个快照头部 2KB 生成 snippet，不为列表整篇读盘

## 3. 目录与持久化（paths.rs）
```
<exe>\settings\settings.json · window.json · session.json
<exe>\autosave\<stem>.md(+.meta.json)
```
- exe 目录可写探测（一次性缓存，`.probe-<pid>` 创建/删除），不可写回退：
  settings→app_config_dir；autosave→app_data_dir/autosave
- 所有写盘：临时文件 + rename（原子，`paths::atomic_write_text`），避免崩溃截断；BOM 容忍读取。

## 4. IPC 命令表（前端 ipc/commands.ts ↔ lib.rs）
| 命令 | 入参 | 返回 |
|---|---|---|
| read_text_file | path | {content,utf8Ok,utf8Bom,byteLen}（UTF-16/32 报错；文本 ≤512MB） |
| write_text_file | path,content | ()（原子写；手动保存唯一写原文件入口） |
| path_exists | path | bool |
| read_image_base64 | path | base64 字符串（≤40MB，且必须 `is_file()`） |
| open_external | url | ()（仅 http/https，经 rundll32 FileProtocolHandler） |
| file_stat | path | {exists,byteLen,modifiedMs}（外部修改检测基线/比对） |
| classify_paths | paths | [{path,kind:"file"\|"dir"\|"missing"}]（拖放过滤） |
| take_launch_paths | - | []（启动参数中待打开的文件，取走即清空） |
| assoc_status / register_md_association / unregister_md_association | - | AssocStatus{exePath,progId,registered,mdDefault,mdPointsToUs,userChoice,supported} |
| open_default_apps_settings | - | ()（`ms-settings:defaultapps`） |
| stage_print_doc / take_print_doc | title,html / - | () / {title,html}\|null（打印槽，取走即清空；>32MB 拒绝） |
| open_print_window / close_print_window | - | ()（创建/聚焦/关闭 `print` 窗口） |
| snapshot_write / list / read / remove | docKey,… / - / key / key | - / Info[] / Content / - |
| read_settings / write_settings | - / settings | AppSettings / () |
| session_save / load | paths,activePath / - | () / Session |
| exit_app | - | 退出进程（先存窗口几何） |
| pick_system_font | currentFamily,currentSizePt | {family,sizePt}\|null（异步，不阻塞 UI 线程） |
| bench_targets / process_mem_kb（内部，仅当 `settings/bench-targets.json` 存在时生效） | - | BenchTargets\|err / KiB |

- 文件与快照类命令均为 **async 包装 + `*_impl` 同步实现**：命令体只 `spawn_blocking` 调用 impl，单元测试直接调 impl，避免测试期依赖 Tauri 运行时。
- 能力（capabilities/default.json）：core:default + window allow-close/destroy/minimize/toggle-maximize/**is-maximized**/start-dragging + dialog:default；`windows: ["main", "print"]`（打印窗口需要 `allow-close` 自我关闭）。
- 应用命令（invoke_handler 注册的自定义命令）不受能力表约束；能力表只影响 core/插件命令。

## 5. 核心流程

### 5.1 启动
1. `visible:false` 建窗 → window_state::init 读 window.json（尺寸/最大化，过滤 <320×240）→ show
2. 前端读 settings（不可用回退默认）
3. 单次启动恢复（settings 就绪后）：
   快照自动恢复（逐条 openFile，删除快照）→ 会话重开（**跳过 ≥64MB** 并计数提示）→ 若无标签 newUntitled
4. “已恢复 N 个”提示 5s 自动隐藏（仅当仍是同文时清除）

### 5.2 自动保存与退出
- 定时 tick（默认 5s）：决策表只产生快照动作（绝不写原文件）；干净↔脏由 doc vs diskContent 判断；撤销回磁盘后清理过期快照
- 退出（菜单/关闭按钮统一走 onCloseRequested）：保存会话 → syncSnapshotsForExit（脏→补写快照；干净但有旧快照→删除）→ forceQuit → Rust `exit_app`（落 window.json）

### 5.3 打开大文件（L1/L2/L3）
- openUserFile：byteLen>20MB → 确认框；确认→ openLoaded(focus=false 后台)
- openLoaded：`veryLarge=chars≥40M` → noHistory=true；且先做**预卸载**（在 state updater 内把最老的非活动超大干净标签退化为占位，保持常驻 ≤4）
- 常驻上限兜底 effect 与预卸载同规则（处理“先开大文件再开大文件”的时序漏网）
- onActivate：目标 tab `unloaded` → 读盘 + 原地 reloadBigTab（保留 id/顺序、恢复 languageOverride）+ “正在加载大文件…”；失败则保持原活动并提示
- 细节与实测见 `large-file-strategy.zh.md`

### 5.4 单行顶栏与菜单交互（App.tsx + MenuBar/TabBar）
- `App` 顶栏结构：`<button class="title-brand">`（点击切换品牌下拉）｜嵌入 `<TabBar>`（‹ › + 标签，自动滚动至活动标签）｜`.title-actions`（`🔎` 预览、`＋` 新建）｜`.win-controls`（最小化/最大化-还原/关闭，46px 等宽、12px SVG 图标）
- 拖拽/双击最大化只绑定在顶栏空白区；品牌按钮不参与拖拽，保证 click 不被 mousedown 吞掉
- `MenuBar` 增加 `vertical` 模式：一级纵向（文件/编辑/帮助，右侧 `›`），悬停切换面板并带 180ms 延迟关闭（进入面板即取消）；`.menu-panel-right { top: 0 }` 保证二级面板与一级条目对齐
- 菜单项动作统一回调 `onItemAction` → `App.closeBrandMenu()`：一级项与二级子项点击后都立即收起品牌下拉

### 5.5 预览（防 OOM + HTML 沙箱）
- PreviewPane 按 `kind: 'markdown'|'html'` 分流（`activePreviewKind` / `previewKindOf` 由扩展名决定），`overLimitChars` 由 App 计算后下传
  - `markdown` → 现有管线
  - `html` → `buildHtmlPreview`（DOMParser 静态化：本地相对图片内联 data URL + 注入文档级 CSP meta）渲染进 `<iframe sandbox="" srcDoc>`（无 allow-scripts/same-origin/forms/top-navigation）→ 脚本/表单/对象/顶层导航全禁
- text>800 万字符 → 跳过渲染显示“预览已禁用”（三种入口一致，HTML 同）；预览文本只在预览挂载且未超限时才 materialize
- Markdown 路径：debounce 300ms → render.ts（`html:false` + texmath/KaTeX + mermaid 块 + `data-line` 标注）
  → mermaid lazy render + 图片 fixup（decode→resolve→read_image_base64→data URL，模块级缓存）
- 分屏滚动同步（仅 Markdown）：块级 data-line ↔ 编辑器视口行

### 5.6 Markdown 锚点与目录（preview/render.ts）
- 两条 core 规则，顺序固定：
  1. `header-custom-ids`（挂在 `inline` **之前**）：解析标题行尾 `{#id}`（含全角/宽字符），剥离标记并写入 `token.attrSet('id', …)`
  2. `anchors-toc`（挂在 `inline` **之后**）：自定义 id 优先，否则 `slugify(headingText(token))`；重复 id 追加 `-2/-3`；识别独立成段的 `[TOC]` 并用 `<nav class="md-toc">` 替换该段落
- `link_open` 钩子：http(s) 链接补 `target="_blank" rel="noopener noreferrer"`
- 预览点击处理为 **document 级 capture**：`http(s)` → `openExternal`；`#frag` → `decodeURIComponent` → 宽松归一化（大小写/空白/连字符/URL 解码差异）匹配标题 id → 直接设置 `.preview-scroll` 的 `scrollTop`（等值、即时，不做平滑）

### 5.7 主题
- 内置 light/dark 静态 HighlightStyle + palette；VS Code 导入 JSON 解析（含 tokenColors 前缀→Tag、颜色保留；状态栏 statusBg 取 statusBar.background，缺省中性色）存储于 localStorage（lexora.vscodeThemes.v1），可在设置删除；删除在用主题回退内置浅色
- 颜色/字体串校验：主题颜色必须匹配 `^#[0-9a-fA-F]{3,8}$`（`hexOr`），字体栈经 `safeFontStack` 清洗，非法值回退默认，避免注入到 CSS 变量
- 外壳主题变量在 app-root 上定义：`--bg/--fg/--panel-bg/--status-bg/--border/--accent`；顶栏、品牌下拉、菜单面板/子列表、最近打开、`.modal` 统一用 `--bg/--fg`，状态栏用 `--status-bg`

### 5.8 光标稳定性（EditorHost）
- `EditorHost` 仅在 `view.state.doc !== tab.cmState.doc` 时才用新 `cmState` 重建/`setState`，其它重渲染（主题、开关、偏好）只通过 Compartment 重配置；store 侧对未变更文档不再回写 `cmState`（修复“移动光标后偶尔跳回原位”）

### 5.9 退出确认口径
- 退出应用：不再询问（自动快照+退出）
- 关闭单个未保存标签：仍询问 保存/不保存并关闭/取消

### 5.10 拖放与外部传入
- **拖放**：`getCurrentWebview().onDragDropEvent` → `enter/over` 存 `dropPaths` 显示浮层；`drop` 清空浮层并把路径交给 `handleDroppedPaths`（先 `classify_paths` 过滤出真实文件，再用 `isLikelyTextFile` 去掉图片/音视频/压缩包，最后逐个走 `openUserFile`，因此 L1 大文件确认同样生效，多个大文件进入确认队列）
- **启动参数**：Rust `setup` 用 `collect_open_args(std::env::args().skip(1))` 收集存在的文件（忽略选项式参数、去重、大小写不敏感）；前端启动流程末尾 `take_launch_paths()` 取走并打开
- **单实例**：`tauri-plugin-single-instance`（必须在其它插件之前注册）在第二次启动时把 argv 交给 `push_launch_paths`，后者写入状态并 `emit("open-paths")`，同时 `set_focus`/`unminimize` 主窗口；前端 `listen("open-paths")` 再打开这些文件

### 5.11 外部修改检测
- 基线：每次打开文件（`openLoaded`）与每次手动保存后 `file_stat` 记录 {modifiedMs, byteLen} 到 `diskStatRef`
- 轮询：设置开启（`files.watchExternal`，默认 true）时每 3 秒对“已加载且有路径的编辑标签”逐个 `file_stat`，`statsDiffer(基线, 当前)` 判定（大小或 mtime 变化、或文件消失）
- 发现变化：**立即把当前 stat 写回基线**（同一次变化只提示一次），再弹窗询问；多个文件排队逐个确认
- 重新加载：`readTextFile` → `store.reloadBigTab`（原地替换，保留 id/顺序；按 `languageOverride` 或新文件名重配语言；≥4000 万字符关闭撤销历史）→ 更新基线 → 清理该 docKey 的过期快照
- 保留当前编辑：不动缓冲区，仅保留新基线；标签若为脏，提示文案明确说明重载会丢失未保存内容

### 5.12 打印
- 入口：文件 →「打印…」（Ctrl+Shift+P）；`printSource` 把预览标签解析回其源编辑标签
- 模式选择：`printModesFor(kind)` —— markdown → `preview`/`raw`（弹 `PrintDialog` 二选一）；html/text → 仅 `raw`（直接打印原文，不询问）
- 内容构建：`buildPrintContent`（`raw` 走 `rawPrintHtml` 转义；`preview` 需要 `renderedHtml`）+ `buildPrintCss`（`@page` 16mm、分页避让、`print-color-adjust: exact`、`.print-raw` 等宽）；markdown 预览版用 `prepareMarkdownPrint`（渲染 → mermaid 内联 SVG（失败退回代码块）→ `materializeImages` 内联本地图片）
- 交付方式：`stage_print_doc(title, html)` 写入 Rust 打印槽 → `open_print_window()` 创建/聚焦 `print` 窗口 → 该窗口的 `main.tsx` 按 `getCurrentWindow().label === "print"` 分流渲染 `PrintView` → `take_print_doc()` 取一次（模块级缓存兼容 StrictMode 双调用）→ 渲染完成后自动调用 **Rust 侧系统打印对话框**，工具栏另有「在浏览器中打印」与「关闭」
- **系统打印对话框**：`print_window_show_dialog` 通过 `with_webview` 取到 `ICoreWebView2Controller`，`cast::<ICoreWebView2_16>()` 后调用 `ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)`，弹出原生 Windows 打印对话框（本机实测为 `ApplicationFrameWindow`：`Microsoft Edge WebView2 - 打印`），取消/打印后打印窗恢复可用
- **不使用 `window.print()`**：在 WebView2 中它会切到 Chromium 自带的 `edge://print` 预览页（CDP 实测：目标从我们的文档变为 `edge://print` + `chrome-untrusted://print/…pdf`），该页面在部分运行时上渲染为空白且无法关闭——正是用户报告的“打印页空白且关不掉”
- **后备路径**：`print_in_browser(title, document_html)` 把 `buildStandalonePrintDocument`（完整 HTML：charset + 标题 + 打印 CSS + 自动打印脚本）写入 `%TEMP%\lexora-print\lexora-<标题>-<时间戳>.html` 并交给默认浏览器打印；该目录每次调用清理 1 天前的自建文件
- 隔离：打印窗口只加载应用自身资源（CSP 不变），文档内容为纯 HTML（无脚本），本地图片已内联为 data URL

## 6. 安全与健壮性
| 项 | 措施 |
|---|---|
| 生产 CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';`（`devCsp: null`） |
| 本地文件访问 | 无 assetProtocol；图片全部走 `read_image_base64`（`is_file()` + 40MB），文本 512MB 上限 |
| 外链 | 仅 http/https 白名单 → `open_external`（rundll32 FileProtocolHandler），且链接点击由前端捕获后显式调用 |
| Markdown/HTML | markdown-it `html:false`；HTML 预览 iframe `sandbox=""` + 文档内 CSP |
| 快照可信 | key 字符集白名单（防穿越）+ `originalPath` 与 stem 哈希一致性校验 |
| 主题输入 | 颜色 `^#[0-9a-fA-F]{3,8}$`、字体栈清洗，非法回退 |
| 文件关联 | 仅写 `HKCU\Software\Classes`（绝不 HKLM、不申请提权）；`reg.exe` 参数由纯函数 `register_plan`/`to_argv` 生成并单测；取消注册只删除自建键，`.md` 默认值仅在等于本 ProgID 时清除 |
| 外部打开 | 命令行参数只接受“存在且是文件”的路径（`Path::is_file()`）；接收方再次校验后走常规打开流程 |
| 打印 | 打印窗口加载应用自身资源（同一 CSP，无脚本注入面）；`stage_print_doc` 限制 32MB 且取走即清空 |
| 编码 | UTF-16/32 拒读；非 UTF-8 原文禁原地保存；BOM 同文件保存保留 |
| FFI | 仅 font.rs ChooseFontW（结构体 x64 布局校验、线程消息队列），bench.rs PSAPI（Windows 条件编译） |
| 错误口径 | 全部走 `Result` 文案，失败保留原状态并提示，不静默吞错 |

## 7. 已知限制 / 演进
- 预览为整篇渲染：>800 万字符禁用（OOM 护栏）；远期可做分段/虚拟化预览
- 超大文档编辑：驻留上限策略缓解，仍有边界 GC 尖峰（可下调 K）
- 非 UTF-8 原文不支持原地编辑
- 无 Windows 10/11 之外的构建目标
- 窗口开启了 Tauri 的原生拖放（`dragDropEnabled`，文件拖入必需），因此网页层的 HTML5 拖放事件不可用；编辑器内的“拖动选中文本移动”属该限制范围
- 打印走 WebView2 的**系统打印对话框**（`ICoreWebView2_16::ShowPrintUI`，要求运行时 ≥ 1.0.1518）；不支持时工具栏提供「在浏览器中打印」后备路径。**禁止改用 `window.print()`**：那会打开 Chromium 的 `edge://print` 预览页，在部分运行时为空白且无法关闭
- 任何**创建窗口**的 Tauri 命令必须是 `async`：同步命令在主线程执行，而 `WebviewWindowBuilder::build()`/`Window::destroy()` 会派发回主线程并等待，从主线程调用即死锁整个应用（窗口出现但空白、无法关闭）。`open_print_window`/`close_print_window` 因此为 async 命令
- HTML 文件按需求只提供“原始文本”打印
- 文件关联为“回退关联”：Windows 已存在 `.md` 的 UserChoice 时系统优先使用它，此时需在系统默认应用设置中手动指定（设置页提供入口）

## 8. 目录导览
```
src-tauri/src/        lib.rs · paths.rs · window_state.rs · commands/*
src/                  App.tsx · components/ · editor/ · preview/ · tabs/ · files/ · print/ · ipc/ · styles/
scripts/              bump-version.mjs · crates-proxy.mjs · gen-icon.mjs
docs/                 requirements · design · acceptance · large-file-strategy · release-notes
```
- `src/files/`：外部修改判定（`externalChange.ts`）与拖放路径过滤/摘要（`dropPaths.ts`），均为纯函数 + 单测
- `src/print/`：打印文档构建（`build.ts`）与 markdown 打印前处理（`prepare.ts`）
- `src/preview/fixup.ts`：本地图片内联（data URL + 模块级缓存），预览与打印共用
