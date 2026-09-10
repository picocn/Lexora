# Lexora 迁移到 Go + Wails 3 规划设计

- 文档状态：方案设计（尚未开工，含待确认决策点）
- 适用基线：Lexora 0.4.1（Tauri 2.11.5 + Rust 后端 + React 18/CodeMirror 6 前端）
- 目标技术栈：Go 1.25+ + Wails v3（当前 beta）+ 同一套前端（React 18 / Vite / CodeMirror 6）
- 配套文档：`requirements.zh.md`、`design.zh.md`、`acceptance.zh.md`、`large-file-strategy.zh.md`、`release-notes.md`

## 0. 结论摘要（TL;DR）

1. **可行性：高，但不是零成本替换。** 前端（React + CodeMirror 6 + 预览渲染 + 全部 vitest 用例）可 100% 复用；需要重写的是约 **2.8k 行 Rust 后端**（含测试），预计 Go 侧 **2.5–3.2k 行** + 前端适配层约 250–400 行 + 构建/打包脚本约 300 行。
2. **最大收益**：构建时间从本机 **4–6 分钟**（cargo release + LTO + 依赖编译）降到 **10–40 秒**（Go 增量编译）；删除为绕过 schannel TLS 问题而存在的 `scripts/crates-proxy.mjs` 中转；后端依赖树从 ~400 个 crate 收敛到个位数 Go 模块；主进程内存与体积通常更小。
3. **最大风险**：Wails v3 仍是 **beta**（本机 CLI `v3.0.0-beta.16`，最新 `v3.0.0-beta.19`），API 可能漂移；**打印**能力在 Wails 下没有现成的 WebView2 COM 通道（现版本依赖 `ICoreWebView2_16::ShowPrintUI`），需要降级为“默认浏览器打印”或做一次 CGO/COM 验证。
4. **推荐路径**：**P0 五项能力验证 spike（3–5 天）→ go/no-go → 双后端并行迁移**（前端只依赖一层 `backend` 适配接口，Tauri 与 Wails 两套实现并存，随时可回滚）。不建议一次性替换 `src-tauri/`。
5. **兼容硬约束**：`settings.json` / `window.json` / `session.json` / `autosave/<stem>.md(+.meta.json)` 的**字段名、默认值合并规则、快照文件名哈希算法**必须逐字节兼容，否则用户数据（未保存内容）会在迁移后失联。第 5 节给出可直接落地的 Go 结构体与不变量。

---

## 1. 迁移目标与范围

### 1.1 为什么迁移

| 维度 | 现状（Tauri 2） | 迁移后（Go + Wails 3） |
|---|---|---|
| 构建耗时 | 本机 release 构建 4–6 min（LTO、~400 crate、`codegen-units=1`） | Go 增量 10–40s；首次全量 1–2 min |
| 工具链 | Rust + cargo + MSVC linker；需 `crates-proxy.mjs`（schannel TLS 故障绕行） | Go 1.26（已装）+ `wails3`（已装）；`GOPROXY=https://goproxy.cn` 直连可用 |
| 后端依赖 | tauri / wry / webview2-com / windows 等 | `github.com/wailsapp/wails/v3` + `golang.org/x/sys`（少量） |
| 语言一致性 | Rust（自绘窗口 + 系统 FFI） | Go（同一语言写业务、系统集成与测试） |
| 交付体积 | exe 8.8 MB（strip+lto） | 预计 8–15 MB（含 WebView2Loader 引导） |
| 生态 | Tauri 2 稳定版、插件成熟 | Wails v3 beta，官方已内建多窗口/菜单/对话/拖放/单实例/文件关联 |

### 1.2 迁移范围

**在范围内**：Tauri 外壳与 IPC 层、全部 Rust 命令（26 个）+ 1 个自定义事件、窗口与几何持久化、可移植目录与原子写、快照/设置/会话存储、系统集成（文件关联、单实例、拖放、系统字体对话框、外链打开、打印）、内部基准通道、版本与打包流水线、文档与验收对照。

**不在范围内**：前端 UI/编辑器/预览渲染逻辑的重写（保持不动）、新功能开发、Linux/macOS 支持、移动端（Wails 3 支持但本项目无需求）、L4（编辑器虚拟化预览）等已列为远期的事项。

### 1.3 成功判据（可验收）

1. `docs/acceptance.zh.md` 全部条目在新后端上逐条通过（自动化项 + 人工项）。
2. 用户数据零丢失：用 0.4.1 生成的 `settings/`、`autosave/` 目录直接启动迁移版，设置项、最近文件、未保存快照全部正确恢复（golden fixture 测试保证）。
3. 性能不劣化：`20×20MB` 顺序打开总耗时与峰值内存不差于 Rust 基线（~41s / ~3.3GB），`10×100MB` 的 L3 驻留上限策略仍然生效（峰值 ≤ ~5GB）。
4. 门禁等价：Go `go test ./...` 覆盖现 `cargo test` 的 35 个用例语义；前端 `vitest` 157 用例保持全绿；`tsc --noEmit` 0 错误；`gofmt`/`go vet`（或 golangci-lint）0 告警。
5. 打包产出等价：便携 exe + 安装包（NSIS；MSI 见决策点 D3）。
6. 回滚可用：迁移期间 `main`（Tauri）保持可发布；任一阶段失败可在 1 天内切回。

---

## 2. 现状盘点（迁移输入）

### 2.1 前端（可整体复用）

| 目录/文件 | 行数 | 迁移影响 |
|---|---|---|
| `src/App.tsx` | ~2150 | **必改**：窗口控制、拖放、退出、打印入口、外链（约 10 处 Tauri 调用点） |
| `src/ipc/commands.ts` | ~315 | **必改**：26 个命令的封装 → 改为 Go 绑定/适配层 |
| `src/main.tsx` | ~24 | **必改**：打印窗口分流判定 |
| `src/components/*`（EditorHost/PreviewPane/MenuBar/TabBar/StatusBar/SettingsModal/InfoDialog/Modal/PrintView/PrintDialog/ExternalChangeDialog/CloseConfirm） | ~1600 | 逻辑不动；`InfoDialog` 的第三方许可清单需改；`PrintView` 的「打印」按钮改为调用新后端 |
| `src/editor/*`、`src/preview/*`、`src/tabs/*`、`src/files/*`、`src/print/*`、`src/styles/app.css` | ~2200 | 不动（纯前端逻辑） |
| `src/**/*.test.ts`（157 用例） | ~1200 | 保持；仅 IPC mock 需要替换 |

关键结论：**前端只有 ~3 个文件与 Tauri 强耦合**，且集中在 IPC 与窗口 API 两处。

### 2.2 Rust 后端（需重写为 Go）

| Rust 文件 | 行数 | 职责 | 迁移难度 |
|---|---|---|---|
| `lib.rs` | 98 | 命令注册、状态注入、单实例插件、`exit_app`、`open_external` | 低 |
| `main.rs` | 6 | 入口 | 低 |
| `paths.rs` | 100 | exe 旁置目录探测（`.probe-<pid>`）、回退到 app_config/app_data、原子写 | 低（stdlib） |
| `window_state.rs` | 121 | `window.json` 读写、启动前应用几何、resize/close 时落盘 | 中（依赖 Wails 窗口查询能力） |
| `commands/files.rs` | 343 | 文本读写（UTF-8/UTF-16/UTF-32 检测、BOM 保留）、512MB 上限、原子写、`path_exists`、图片 base64（40MB 上限、`is_file()`）、`file_stat`、`classify_paths` | 低 |
| `commands/snapshots.rs` | 332 | 快照写/列/读/删；stem 哈希命名；key 白名单防穿越；`originalPath` 与 stem 哈希一致性校验；列表只读 2KB 取摘要 | 中（**算法必须逐字节兼容**） |
| `commands/settings.rs` | 343 | 设置读写、默认值深度合并、数值容错（浮点取整）、布局白名单、`recentFiles` 截断 20 | 低 |
| `commands/session.rs` | 50 | 会话读写 | 低 |
| `commands/font.rs` | 179 | `comdlg32.ChooseFontW` FFI（`LOGFONTW`/`CHOOSEFONTW` 布局、消息队列、pt↔px） | 中（Go syscall 重写） |
| `commands/bench.rs` | 80 | 内部基准：`bench_targets`（`settings/bench-targets.json` 存在才生效）、`process_mem_kb`（PSAPI） | 低 |
| `commands/launch.rs` | 202 | 启动参数解析（存在且是文件、去重、剥离引号）、待打开队列、`open-paths` 事件、主窗口置前 | 中 |
| `commands/assoc.rs` | 628 | `.md` 关联注册/注销/状态（`HKCU`，`reg.exe` 计划 + 执行，UserChoice 只读提示） | 中 |
| `commands/print_doc.rs` | 341 | 打印槽（32MB 上限、一次性取用）、打印窗口创建/关闭、**系统打印对话框**（`ICoreWebView2_16::ShowPrintUI`）、浏览器后备（临时 HTML + 默认浏览器 + 1 天清理） | **高**（见 4.2） |
| 合计 | **≈2823** | 其中测试约占 1/4（`cargo test` 35 用例） | — |

### 2.3 Tauri 命令面（迁移契约）

共 **26 个命令 + 1 个事件**，前端 `invoke(name, args)` 调用：

| 分组 | 命令（参数 → 返回） |
|---|---|
| 文件 | `read_text_file(path)` → `{content,utf8Ok,utf8Bom,byteLen}`；`write_text_file(path,content)`；`path_exists(path)` → bool；`read_image_base64(path)` → base64；`file_stat(path)` → `{exists,byteLen,modifiedMs}`；`classify_paths(paths)` → `[{path,kind}]` |
| 快照 | `snapshot_write(docKey,content,title,originalPath)`；`snapshot_list()` → `SnapshotInfo[]`；`snapshot_read(key)` → `{content,originalPath,title,modifiedAtMs}`；`snapshot_remove(key)` |
| 设置/会话 | `read_settings()` → `AppSettings`；`write_settings(settings)`；`session_save(paths,activePath)`；`session_load()` → `{paths,activePath}` |
| 启动/外部 | `take_launch_paths()` → `string[]`；**事件** `open-paths`（payload `string[]`）；`open_external(url)`；`exit_app()` |
| 关联 | `assoc_status()` → `AssocStatus`；`register_md_association()`；`unregister_md_association()`；`open_default_apps_settings()` |
| 打印 | `stage_print_doc(title,html)`；`take_print_doc()` → `{title,html}\|null`；`open_print_window()`；`close_print_window()`；`print_window_show_dialog()`；`print_in_browser(title,html)` → path |
| 字体/基准 | `pick_system_font(currentFamily,currentSizePt)` → `{family,sizePt}\|null`；`bench_targets()`；`process_mem_kb()` → KiB |

### 2.4 前端用到的 Tauri 运行时 API（必须一一替换）

| 用途 | 现状 | 出现位置 |
|---|---|---|
| 窗口几何/状态 | `getCurrentWindow().isMaximized/onResized/toggleMaximize/minimize/startDragging/close/destroy` | `App.tsx`（`withMainWindow`、最大化跟踪、拖拽、关闭请求） |
| 关闭拦截 | `win.onCloseRequested(async e => { e.preventDefault(); … })`（保存会话 → 同步快照 → `exit_app`） | `App.tsx` |
| 拖放 | `getCurrentWebview().onDragDropEvent`（`enter/over/drop/leave` + `paths`） | `App.tsx` |
| 事件 | `listen("open-paths")` | `ipc/commands.ts` |
| 文件对话框 | `@tauri-apps/plugin-dialog` 的 `open` / `save` | `ipc/commands.ts`、`App.tsx`（导入主题、打开/另存为） |
| 打印窗口识别 | `getCurrentWindow().label === "print"` | `main.tsx` |

### 2.5 持久化格式（迁移必须兼容）

```
<exe>\settings\settings.json      AppSettings（camelCase）
<exe>\settings\window.json        {width,height,maximized}（逻辑像素 + 最大化标志）
<exe>\settings\session.json       {paths[],activePath}
<exe>\autosave\<stem>.md          ← 未保存内容的恢复快照（永不写原文件）
<exe>\autosave\<stem>.meta.json   {originalPath,title,modifiedAtMs}
```
不可写时分别回退到 `app_config_dir` 与 `app_data_dir/autosave`。所有写盘均为“同目录临时文件 + rename”。

### 2.6 构建与发布现状

- 版本规则 `<major>.<minor>.<micro>`，每次构建 micro+1，micro≥10 进位到 minor（当前 0.4.1）。
- `scripts/bump-version.mjs` 同步 5 个版本源：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`package-lock.json`。
- `npx tauri build`：先 `npm run build`（tsc + vite → `dist/`），再 cargo release，再打 `msi`（WiX candle/light）+ `nsis`，产出 `lexora.exe`。
- 内部基准通道：`settings/bench-targets.json` 存在时启动即顺序打开文件并写回 JSON 报表；`process_mem_kb` 取进程工作集。测试数据与脚本在 `D:\lexora-bench`（`bench-targets.json`、`watchdog.ps1`、`verify-*.ps1`、CDP 脚本）。

### 2.7 本机环境实测（本次盘点，已确认）

| 项 | 结果 |
|---|---|
| Go | **go1.26.5 windows/amd64**（≥ Wails 要求 1.25）；`GOPATH=D:\GoPath`；`GOPROXY=https://goproxy.cn,direct` |
| Go 代理连通性 | `https://goproxy.cn` 200 OK（可取到 `v3.0.0-beta.14…beta.19`）；`proxy.golang.org` 直连超时 → **必须保留 `GOPROXY=goproxy.cn`** |
| Wails CLI | `D:\GoPath\bin\wails3.exe` 已存在，版本 **v3.0.0-beta.16**（最新 beta.19）；另有 v2 的 `wails.exe` |
| `wails3 doctor` | WebView2 **154.0.4258.9**、`Go WebView2Loader=true`、`CGO_ENABLED=0`、Windows 11 25H2 Insider、32GB |
| 打包依赖 | **NSIS 未安装**（Tauri 自带的 `makensis` 在 `%LOCALAPPDATA%\tauri\NSIS`）；MSIX Packaging Tool / MakeAppx / SignTool 未安装；`%LOCALAPPDATA%\tauri\WixTools314` 存在（原 MSI 用） |
| 前端工具链 | Node v24.4.1 / npm 11.4.2（不变） |
| Wails CLI 命令面 | `init`、`build`、`dev`、`package`、`task`、`generate {bindings,models,icons,syso,build-assets,…}`、`doctor`、`setup`、`updater`、`sign` 等 |

结论：**迁移所需的 Go 与 Wails 工具链已就绪**，唯一需要补的是打包器（NSIS），且可复用 Tauri 已下载的 NSIS 目录（见 8.3）。

## 3. 目标架构（Go + Wails 3）

> 本节 API 名称均已在本机 `D:\GoPath\pkg\mod\github.com\wailsapp\wails\v3@v3.0.0-beta.16` 源码中核对（下表标注了文件位置），不是文档推测。

### 3.1 进程与窗口模型

```
lexora.exe（单进程，Go）
├─ main 窗口   Name="main"   URL: 应用入口            ← 编辑器/预览/DOM 菜单
└─ print 窗口  Name="print"  URL: 应用入口 + 打印标记   ← 仅渲染打印文档
     └─ 两个窗口共用同一份前端 bundle（dist/）
     └─ WebView2 子进程（msedgewebview2.exe）承载渲染与内存
```

- 多窗口：`app.Window.NewWithOptions(application.WebviewWindowOptions{...})`（`window_manager.go`）；`app.Window.GetByName("print")` 可复用/聚焦已有窗口。
- **打印窗口的路由标记**：不依赖运行时“当前窗口名”JS API（P0 核实项）。首选把标记放在 URL 上：`NewWithOptions(WebviewWindowOptions{URL: "/?win=print"})`，前端 `main.tsx` 读 `location.search` 分流；备选 `Options.Assets.Handler` 自定义 `/print` 路由返回同一 `index.html`。
- 无边框：`WebviewWindowOptions{Frameless: true, Width: 1280, Height: 840, MinWidth: 640, MinHeight: 480, StartState: …, Hidden: true}`；启动先 `Hidden` 再应用几何后 `Show()`（等价现在的 `visible:false` 防闪烁）。
- 拖拽区：CSS `app-region`（Wails 官方无边框方案，WebView2 原生非客户区）替代现在 `mousedown → startDragging()`；`WebviewWindow.startDrag()` 仍可从 Go 调用作为兜底（`webview_window_windows.go:262` 用 `WM_NCLBUTTONDOWN/HTCAPTION`）。双击最大化由 `WebviewWindowOptions` 的标题栏双击动作（`titlebar_doubleclick_action.go`）或前端 `dblclick` 处理。
- 窗口几何持久化：`WindowDidResize`/`WindowMaximise`/`WindowRestore`/`WindowClosing` 窗口事件（`pkg/events/events.go`：`WindowDidResize=1032`、`WindowMaximise=1039`、`WindowRestore=1042`、`WindowClosing=1030`）→ 捕获 `Bounds()`（逻辑像素）/`IsMaximised()` → 写 `window.json`。

### 3.2 仓库布局（保持前端目录不变，新增 Go 侧）

```
D:\dsh\mdpad\
├─ src/                     ← 前端（不变）
├─ dist/                    ← vite 产物（Wails 资产目录）
├─ index.html               ← vite 入口（不变）
├─ main.go                  ← application.New(...) + 服务注册 + 窗口编排
├─ go.mod / go.sum
├─ internal/
│  ├─ app/          窗口与关闭流程、事件桥、打印窗口编排（对应 lib.rs + window_state.rs）
│  ├─ paths/        可移植目录探测 + 原子写（对应 paths.rs）
│  ├─ files/        文本读写/编码判定/图片 base64/stat/classify（对应 commands/files.rs）
│  ├─ snapshots/    快照哈希命名、信任校验、列表摘要（对应 commands/snapshots.rs）
│  ├─ settings/     默认合并/数值容错/夹取（对应 commands/settings.rs）
│  ├─ session/      会话读写（对应 commands/session.rs）
│  ├─ launch/       argv 解析 + 待打开队列（对应 commands/launch.rs）
│  ├─ assoc/        HKCU 关联注册/注销/状态（对应 commands/assoc.rs）
│  ├─ printdoc/     打印槽 + 浏览器交接 +（可选）系统对话框（对应 commands/print_doc.rs）
│  ├─ fontdlg/      ChooseFontW（对应 commands/font.rs）
│  ├─ bench/        bench_targets + process_mem_kb（对应 commands/bench.rs）
│  └─ win32/        syscall 封装：registry/ShellExecuteW/PSAPI/ChooseFontW/SHChangeNotify
├─ bindings/               ← wails3 generate bindings 产物（TS，供适配层引用）
├─ build/                  ← wails3 构建资产：config.yml、windows/*.nsi、icons/、windows/*.syso
├─ scripts/                ← bump-version.mjs（改造）、crates-proxy.mjs（删除）、gen-icon.mjs、e2e/
└─ docs/
```

### 3.3 服务与绑定（替代 Tauri 命令表）

```go
// main.go（骨架，API 名称来自本机 v3.0.0-beta.16 源码）
app := application.New(application.Options{
    Name:        "Lexora",
    Description: "Lexora - lightweight multi-tab markdown editor",
    Services: []application.Service{
        application.NewService(&files.Service{}),      // 6 个方法
        application.NewService(&snapshots.Service{}),  // 4
        application.NewService(&settings.Service{}),   // 2
        application.NewService(&session.Service{}),    // 2
        application.NewService(&launch.Service{}),     // 2（含队列）
        application.NewService(&assoc.Service{}),      // 4
        application.NewService(&printdoc.Service{}),   // 6（其中 1 个为可选系统对话框）
        application.NewService(&fontdlg.Service{}),    // 1
        application.NewService(&bench.Service{}),      // 2
    },
    SingleInstance: &application.SingleInstanceOptions{
        UniqueID:               "com.lexora.app",
        OnSecondInstanceLaunch: launch.OnSecondInstance, // SecondInstanceData{Args,WorkingDir,AdditionalData}
    },
    FileAssociations: []string{".md", ".markdown"},     // 元数据在 build/config.yml（NSIS 安装时写入）
    Assets: application.AssetOptions{                   // 资产服务器（vite 产物）
        Middleware: csp.Middleware,                     // 注入生产 CSP（见 4.3）
    },
    Windows: application.WindowsOptions{
        DisableQuitOnLastWindowClosed: false,
        WebviewUserDataPath:           "",              // 保持系统默认（与现版本 WebView2 行为一致）
    },
    OnShutdown: func() { /* 会话 + 快照收尾（等价 syncSnapshotsForExit） */ },
})
app.Run()
```

- 绑定生成：`wails3 generate bindings -ts -d bindings`（`services.go:48 NewService[T]`）；前端拿到类型化函数，例如 `files.ReadTextFile(path)`。
- 前端运行时包 `@wailsio/runtime` 实测导出：`Application`、`Browser`、`Call`、`Clipboard`、`Create`、`Dialogs`、`Events`、`Flags`、`Screens`、`System`、`Window`、`WML`、`Stream` 等（`internal/runtime/desktop/@wailsio/runtime/src/index.ts`）。
- **错误语义差异**：Tauri 的 `Err(String)` 会 reject 出字符串；Wails 绑定 reject 的是 `Error` 对象。适配层统一归一化：`err instanceof Error ? err.message : String(err)`，保证现有很多 `打开失败：${e}` 文案不出现 `Error: ` 前缀。
- **大对象**：Wails v3 提供 stream（`internal/runtime/.../stream.ts`、`pkg/application/stream*.go`）用于大 payload；本项目仍沿用“前端持有文档、只在打开/保存时全量过桥”的现有模型（与 Tauri 相同），不引入 stream，避免大改。

### 3.4 事件通道（替代 `listen("open-paths")`）

| 事件 | 触发方 | 前端订阅 |
|---|---|---|
| `open-paths`（自定义） | Go：第二实例转发 / 启动参数 / 文件拖放筛选后 | `Events.On("open-paths", cb)`（`@wailsio/runtime`） |
| `common:WindowFilesDropped` | WebView2 拖放（Go 侧 `WebviewWindow.OnWindowEvent`；前端亦可监听） | 后端处理为主（见 4.2） |
| `common:WindowClosing` / `WindowDidResize` / `WindowMaximise` / `WindowRestore` | Wails 内核 | Go 侧处理（窗口几何落盘、关闭流程） |

Go 侧发送：`app.Event.Emit("open-paths", paths)`（`event_manager.go: Emit/EmitEvent/On`）。

### 3.5 并发与线程约束（吸取本项目已踩过的坑）

1. **模态对话框（字体、系统打印）必须跑在专用 OS 线程**：`runtime.LockOSThread()` + 先 `PeekMessage` 建消息队列 + 模态循环，结束后解锁。这与现在 Rust 的 `std::thread::spawn + PeekMessageW` 做法一一对应。
2. **窗口操作不要在同步等待里再等主线程**：Wails 的窗口方法内部已 `InvokeSync` 派发到 UI 线程；服务方法本身运行在调用 goroutine，直接调用即可（本项目曾在 Tauri 上因“同步命令里建窗口”造成主线程死锁，Go 侧要避免同类模式：不要在 `WndProcInterceptor`/窗口事件回调里同步等待自己）。
3. 文件 IO（最大 512MB）在服务方法内用普通 goroutine 即可，不需要队列；但**避免并发写同一快照/设置**：使用 `sync.Mutex` 或串行化通道（对应 Rust 的 `Mutex<…>` 状态）。
4. 退出流程：`Options.OnShutdown` + `WindowClosing` 事件里做“保存会话 → 同步快照 → `app.Quit()`”；前端不再需要 `exit_app` 命令（如需强制退出，保留一个 `app.Quit()` 包装方法）。

## 4. 能力映射与自建方案

### 4.0 概念对照

| Tauri 2 | Wails v3（本机 beta.16 源码核对） |
|---|---|
| `tauri.conf.json` | `main.go` 的 `application.Options` + `build/config.yml`（打包元数据） |
| `#[tauri::command]` + `invoke_handler![]` | `application.NewService(&svc{})` + `Options.Services`，`wails3 generate bindings` |
| `#[tauri::command] async fn` | 普通 Go 方法（在调用 goroutine 执行，天然不阻塞 UI） |
| `app.emit` / `listen` | `app.Event.Emit(name, data…)` / `Events.On(name, cb)` |
| `WebviewWindow` / `WebviewWindowBuilder` | `app.Window.NewWithOptions(application.WebviewWindowOptions{…})` |
| `capabilities/default.json` | 无等价物（自定义 Go 方法不受能力表约束；`Permissions` 仅部分平台） |
| `tauri-plugin-dialog` | `app.Dialog.OpenFile()/SaveFile()`（原生 `IFileDialog`，无插件） |
| `tauri-plugin-single-instance` | `Options.SingleInstance`（内置） |
| `onDragDropEvent` | `EnableFileDrop` + `common:WindowFilesDropped`（`DroppedFiles() []string`） |
| `@tauri-apps/api` 运行时 | `@wailsio/runtime`（`Events`、`Window`、`Stream`…） |
| `npx tauri build` | `wails3 build` / `wails3 package`（Taskfile 驱动） |

### 4.1 命令映射（26 → Go 服务方法）

完整对照见附录 A。分组归属：`files`(6)、`snapshots`(4)、`settings`(2)、`session`(2)、`launch`(2)、`assoc`(4)、`printdoc`(6)、`fontdlg`(1)、`app`(2：`exit_app`/`open_external`)、`bench`(2)。

### 4.2 平台能力逐项映射

| 能力 | Tauri 现状 | Wails v3 方案 | 迁移动作 | 风险 |
|---|---|---|---|---|
| 自绘 36px 顶栏 + 拖拽 | `decorations:false` + `mousedown→startDragging()` | `Frameless:true` + CSS `app-region`（`features/windows/frameless`）；`startDrag()` 可兜底 | 改 `App.tsx` 拖拽区 + `app.css` | 低 |
| 最大化/还原图标与状态 | `isMaximized()` + `onResized` | `IsMaximised()`（`webview_window.go:761`）+ `WindowMaximise/WindowRestore/WindowDidResize` 事件 + `ToggleMaximise()`（:1193） | 改 `App.tsx` 4 处 | 低 |
| 关闭拦截（退出流程） | `onCloseRequested { preventDefault }` | `common:WindowClosing` 事件 + `Options.ShouldQuit`；`app.Quit()` | Go 侧实现“存会话→同步快照→退出”；删除前端 `exit_app` | 低 |
| 文件打开/保存对话框 | `@tauri-apps/plugin-dialog` | `app.Dialog.OpenFile()/SaveFile()`（`.AddFilter/.SetFilename/.PromptForMultipleSelection/.AttachToWindow`） | 适配层替换，删插件依赖 | 低 |
| 系统字体对话框 | `comdlg32.ChooseFontW` FFI（179 行） | 自建纯 Go `syscall` 调用（x64 结构体布局已核对：`LOGFONTW`=92B、`CHOOSEFONTW`=104B）；`hwndOwner` 用 `NativeWindow()` 的 HWND | 1:1 移植 + 专用 OS 线程 + 消息泵 | 中 |
| 文件拖放 | `onDragDropEvent`（Tauri 原生拦截，HTML5 拖放被禁用） | `EnableFileDrop:true`（窗口选项）+ `common:WindowFilesDropped`；**运行时在 DOM 层处理 dragenter/over/drop 并解析路径**，故 HTML5 拖放可用 | 后端做“筛选 + 打开”，前端用标准 DataTransfer 事件驱动浮层 | 低（限制反而消失） |
| 单实例 + argv 转发 | `tauri-plugin-single-instance` + 自定义队列 | 内置 `SingleInstanceOptions{UniqueID, OnSecondInstanceLaunch, AdditionalData, EncryptionKey}`；`SecondInstanceData{Args, WorkingDir}` | 删自建实现，回调里复用 `launch` 筛选逻辑 | 低 |
| 文件关联（运行时注册） | 自建 `reg.exe` 计划 + 执行（628 行） | `golang.org/x/sys/windows/registry` 直写 HKCU + `SHChangeNotify(SHCNE_ASSOCCHANGED)`；另可声明式走 `build/config.yml: fileAssociations`（安装时写入） | 移植计划/执行/状态查询；保留 UserChoice 只读与提示 | 中 |
| 外链 / 浏览器打开 | `rundll32 url.dll,FileProtocolHandler` | `app.Browser.OpenURL(url)` / `OpenFile(path)`（或 `ShellExecuteW`） | 适配层替换 + 保留 http(s) 白名单 | 低 |
| **打印** | `ICoreWebView2_16::ShowPrintUI(SYSTEM)`（可用，见 0.4.1） | `WebviewWindow.Print()` 在 Windows 上仅 `execJS("window.print();")`（`webview_window_windows.go:248`）→ 与已证伪的路径相同，**不可用** | 见决策 **D1** | **高** |
| 进程内存统计 | PSAPI `GetProcessMemoryInfo` | 自建 `psapi` syscall（`PROCESS_MEMORY_COUNTERS`，`Cb` 必填，SIZE_T→uintptr） | 1:1 移植 | 低 |
| 窗口图标/DPI/文件属性 | Tauri 打包 | `wails3 generate icons` + `goversioninfo`（.syso，含 manifest/DPI） | 新脚本 | 低 |
| 内部基准通道 | `bench_targets`/`process_mem_kb` | 同左（Go 版） | 1:1 移植（保持 `settings/bench-targets.json` 触发条件） | 低 |

**D1：打印方案三选一**

- **方案 A（推荐，零依赖、已在本项目验证过）**：沿用 0.4.1 的“浏览器交接”路径 —— Go 把打印 HTML 写到 `%TEMP%\lexora-print\*.html`（含 `@page` 打印 CSS 与自动打印脚本），用 `app.Browser.OpenFile(path)` 交给默认浏览器，Edge 的打印预览可正常使用、可取消、可关闭；应用内仍保留一个“打印预览窗口”（Wails 多窗口）用于查看排版，但打印动作交给浏览器。代价：打印界面离开应用窗口；需维护临时文件清理（现有 1 天清理逻辑照搬）。
- **方案 B（可选增强，需维护 fork）**：本地 fork Wails 暴露 `ICoreWebView2*` 或直接新增 `ShowPrintUI(SYSTEM)` 方法（Wails 内部 `windowsWebviewWindow` 已持有 webview；公开 API 只给了 HWND），通过 `go.mod` 的 `replace github.com/wailsapp/wails/v3 => ./third_party/wails` 引入。收益：完全应用内、原生系统打印对话框（与 0.4.1 体验一致）；代价：跟随上游 beta 版本升级时要重放补丁（补丁面 20–40 行）。
- **方案 C**：`PrintToPdf`（同样需要方案 B 的 COM 通道）+ `Browser.OpenFile(pdf)` 让用户从 PDF 阅读器打印；比 A 多一步、无额外收益，不推荐。

> 结论：**P0 先验证方案 A 是否满足使用需求；若必须应用内打印，再评估方案 B（fork）**。绝不要在 WebView2 上依赖 `window.print()`。

### 4.3 安全能力映射

| 安全项 | 现状（Tauri） | Wails v3 方案 |
|---|---|---|
| 生产 CSP | `tauri.conf.json` `security.csp` 注入响应头 | Wails 源码中无 CSP 配置项 → 用 `AssetOptions.Middleware`（`ChainMiddleware`）在资产响应上注入同样的 CSP 头；dev 模式按需放开 |
| 无 asset 协议 / 本地图片 | 全部走 `read_image_base64` | 不变（Go 侧同样读文件转 base64，40MB 与 `is_file()` 校验保留） |
| 外链白名单 | `open_external` 校验 `http(s)` | `Browser.OpenURL` 前做同样校验（Go 侧唯一入口） |
| 快照 key 防穿越 | 字符集白名单 + stem 哈希校验 | 同规则移植（5.2 表） |
| 文本/图片大小上限 | 512MB / 40MB | 同值（`os.Stat` 预检 + 读取上限） |
| 主题颜色/字体白名单 | 前端正则校验 | 不变（纯前端） |
| WebView2 特性开关 | 无 | `WindowsOptions.EnabledFeatures/DisabledFeatures/AdditionalBrowserArgs`：可显式禁用不需要的特性（如 `msWebView2EnableDraggableRegions` 视需要），并**不要**添加 `--remote-debugging-port`（仅测试期用环境变量） |
| 权限模型 | capabilities 白名单 | `WebviewWindowOptions.Permissions`（Windows 上作用有限）→ 不作为安全边界，安全仍由“只暴露明确服务方法 + 输入校验”保证 |

## 5. 数据结构与存储兼容（硬约束）

### 5.1 Go 侧结构体（JSON tag 必须与现网文件逐字段一致）

```go
// internal/settings
type AutosaveSettings struct {
    Enabled     bool   `json:"enabled"`
    IntervalSec uint64 `json:"intervalSec"`
}
type FilesSettings struct {
    WatchExternal bool `json:"watchExternal"`
}
type EditorSettings struct {
    FontFamily  string  `json:"fontFamily"`
    FontSize    uint64  `json:"fontSize"`
    LineHeight  float64 `json:"lineHeight"`
    TabSize     uint64  `json:"tabSize"`
    WordWrap    bool    `json:"wordWrap"`
    LineNumbers bool    `json:"lineNumbers"`
}
type PreviewSettings struct {
    FontFamily string `json:"fontFamily"`
    FontSize   uint64 `json:"fontSize"`
}
type ThemeSettings struct {
    Kind string `json:"kind"` // "builtin" | "vscode"
    ID   string `json:"id"`   // builtin: light|dark；vscode: 主题 id
}
type AppSettings struct {
    Autosave    AutosaveSettings `json:"autosave"`
    Files       FilesSettings    `json:"files"`
    Editor      EditorSettings   `json:"editor"`
    Preview     PreviewSettings  `json:"preview"`
    Theme       ThemeSettings    `json:"theme"`
    Layout      string           `json:"layout"` // split|edit|preview
    RecentFiles []string         `json:"recentFiles"`
}
```

其余结构（同样要求字段名/大小写一致）：

```go
type WindowState struct {
    Width     float64 `json:"width"`   // 逻辑像素
    Height    float64 `json:"height"`
    Maximized bool    `json:"maximized"`
}
type Session struct {
    Paths      []string `json:"paths"`
    ActivePath *string  `json:"activePath"`
}
type SnapshotMeta struct {
    OriginalPath *string `json:"originalPath"`
    Title        string  `json:"title"`
    ModifiedAtMs uint64  `json:"modifiedAtMs"`
}
type SnapshotInfo struct {
    Key          string  `json:"key"`
    OriginalPath *string `json:"originalPath"`
    Title        string  `json:"title"`
    ModifiedAtMs uint64  `json:"modifiedAtMs"`
    Snippet      string  `json:"snippet"`
}
type FileReadResult struct {
    Content string `json:"content"`
    Utf8Ok  bool   `json:"utf8Ok"`
    Utf8Bom bool   `json:"utf8Bom"`
    ByteLen int64  `json:"byteLen"`
}
type FileStat struct {
    Exists     bool  `json:"exists"`
    ByteLen    int64 `json:"byteLen"`
    ModifiedMs int64 `json:"modifiedMs"`
}
type PathKind struct {
    Path string `json:"path"`
    Kind string `json:"kind"` // file|dir|missing
}
type AssocStatus struct {
    ExePath      string  `json:"exePath"`
    ProgID       string  `json:"progId"`
    Registered   bool    `json:"registered"`
    MdDefault    *string `json:"mdDefault"`
    MdPointsToUs bool    `json:"mdPointsToUs"`
    UserChoice   *string `json:"userChoice"`
    Supported    bool    `json:"supported"`
}
type PrintDoc struct {
    Title string `json:"title"`
    HTML  string `json:"html"`
}
```

### 5.2 必须逐字复刻的行为规则

| 规则 | 现状实现 | Go 实现要点 |
|---|---|---|
| 默认值合并 | 读取时把存储 JSON 覆盖到“完整默认对象”上（`merge_json`，递归对象合并，非对象整体替换） | `map[string]any` 深合并 + `json.Unmarshal` 到结构体；**不能**只依赖 `omitempty`/零值 |
| 数值容错 | u64 字段接受浮点（`14.5` → 15），负数/非法报错 | 先解到 `json.Number`/`float64` 再取整；或自定义 `UnmarshalJSON` |
| 夹取 | `intervalSec ≥ 1`、`fontSize ≥ 8`、`tabSize 1..16`、`lineHeight ≥ 1.0`、`layout ∈ {split,edit,preview}`、`recentFiles` 取前 20 | 同规则，且**写入端也截断 20**（前端 `pushRecent` 已有同样规则） |
| 快照文件名 | `sanitize_stem(docKey)`：ASCII 字母数字与 `.-_` 保留、其余换 `_`、截断 80、空则 `snapshot`，再接 `-` + **u32 31 进制哈希的十六进制** | `h := uint32(0); for _, b := range []byte(raw) { h = h*31 + uint32(b) }`（自然溢出）→ `fmt.Sprintf("%s-%x", prefix, h)` |
| 快照 key 白名单 | 非空、非 `.`/`..`、长度 <200、全部为 ASCII 字母数字或 `.-_` | 同规则，`filepath.Join` 前校验（防穿越） |
| 快照可信校验 | `meta.originalPath` 经 `sanitize_stem` 得到的哈希后缀必须与文件 stem 一致，否则丢弃该 meta | 同规则（避免伪造 meta 把内容写回错误文件） |
| 列表摘要 | 只读每个 `.md` 头部 2048 字节，取前 120 字符、换行压成空格；按 `modifiedAtMs` 降序 | `os.Open` + `io.ReadFull` 前缀读 |
| 原子写 | 同目录 `.<name>.<pid>.tmp` → `rename` | `os.CreateTemp(dir, ".<name>.*.tmp")` + `f.Sync()` + `os.Rename`；Windows 上 `os.Rename` 已用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，可直接覆盖 |
| BOM/编码 | 读：BOM 容忍；UTF-16/32 拒读并提示；非 UTF-8 只读展示、禁止原地保存；写：同文件保存保留 BOM | `unicode/utf8.Valid`、BOM 嗅探 + `unicode/utf16.Decode`、`utf8.ValidString` 判定 |
| 目录探测 | exe 旁 `settings/`、`autosave/` 写探针（`.probe-<pid>`），失败回退用户目录；结果一次性缓存 | `os.Executable()` + `os.CreateTemp` 探针 + `sync.Once` |

### 5.3 兼容性测试（迁移门禁之一）

新增 Go 测试 `internal/store/compat_test.go`：

1. **Golden fixtures**：把 0.4.1 真实生成的 `settings.json`（含中文路径的 `recentFiles`、`files.watchExternal`）、`window.json`、`session.json`、`<stem>.md(+.meta.json)` 存入 `internal/store/testdata/`（脱敏），断言 Go 解析结果字段完全相等并可无损写回。
2. **哈希一致性**：对 12 组代表性 docKey（Windows 路径、中文路径、超长路径、untitled id、含空格/emoji）断言 `sanitizeStem` 与 Rust 实现输出**完全一致**（Rust 侧输出作为期望值固化进表）。
3. **往返测试**：Go 写盘 → Rust 版读盘（迁移期用 `cargo test` 里的只读校验工具或临时 CLI）→ 字段一致。

---

## 6. 大文件与性能策略

### 6.1 阈值与策略（原样移植）

| 常量 | 值 | 作用 |
|---|---|---|
| `LARGE_FILE_WARN_BYTES` | 20 MB | L1：手动打开前确认（后台打开/取消） |
| `UNLOAD_BIG_CHARS` | 40,000,000 | L2/L3：超大文档判定（关撤销历史、可退化占位） |
| `KEEP_LOADED_BIG` | 4 | L3：超大“干净”标签常驻上限 |
| `SESSION_SKIP_BYTES` | 64 MB | 启动会话恢复跳过阈值 |
| `PREVIEW_MAX_CHARS` | 8,000,000 | 预览 OOM 护栏（前端判定，无需后端） |

这些阈值与决策表位于**前端**（`src/tabs/thresholds.ts`、`src/tabs/autosave.ts`、`App.tsx` 的 L1/L2/L3 逻辑），**迁移后保持不变**；后端只需提供同等语义的 `file_stat`（判断大小）与读写接口。

### 6.2 Rust 基线（迁移后必须不劣于）

| 场景 | 基线（0.2.0 实测，同机） |
|---|---|
| 20×20MB 顺序打开 | 总耗时 ~41s，进程树峰值 ~3.3GB |
| 10×100MB 顺序打开（L3 生效） | 累计 ~112s；单文件 ~11–14s（首个 3.2s）；峰值 4.67GB，限制在 ~5GB 内 |
| 未加 L3 时（对照） | 第 10 个 96s、第 11 个 162s、11 个累计 434s |

### 6.3 Go 实现注意事项

1. **零拷贝**：`os.ReadFile` 得到 `[]byte` 后转字符串用 `unsafe.String(&b[0], len(b))`（需保证此后不再写 `b`；或用 `strings.Clone` 换取安全），避免 100MB 级别多一次全量拷贝。
2. **IPC 序列化成本**：返回大文件内容会经历一次 JSON 编码 + 前端解析（Wails 与 Tauri 相同量级）。避免在 Go 侧构造中间 `map[string]any` 再编码；直接用结构体。
3. **GC 与内存上限**：可用 `debug.SetMemoryLimit`（Go 1.19+）模拟现有 L3 的“内存天花板”，并在基准中确认峰值；`GOGC` 默认 100 可能在 100MB 文档下产生较大堆，必要时配合 `runtime/debug.FreeOSMemory()` 在卸载标签后主动归还。
4. **前端仍是内存主体**：WebView2 子进程承载 CodeMirror 文档，迁移前后这部分开销不变；`process_mem_kb` 只统计主进程工作集，基准脚本应继续统计**进程树**（含 `msedgewebview2.exe`）。
5. **基准复测**：沿用 `D:\lexora-bench` 的 `bench-targets.json` 通道（Go 版 `bench_targets`/`process_mem_kb` 复刻），对 20×20MB 与 10×100MB 各跑一轮，产出与 6.2 同格式的对照表，写入 `docs/large-file-strategy.zh.md` 新增小节。

---

## 7. 前端改造清单（逐文件）

### 7.1 必改文件

| 文件 | 改造内容 |
|---|---|
| `src/ipc/commands.ts`（新 `src/ipc/backend.ts` + `src/ipc/tauri.ts` + `src/ipc/wails.ts`） | 抽出后端接口（26 个命令 + 事件订阅 + 窗口操作），保持**现有导出函数签名不变**（`readTextFile`、`snapshotWrite`、`openPrintWindow`…），内部按 `import.meta.env.VITE_BACKEND` 选择实现；这样 `App.tsx` 与组件几乎无需改动，且迁移期两套后端可并行运行对比 |
| `src/App.tsx` | 10 处调用点替换：① `withMainWindow`（`isMaximized`/`onResized`/`toggleMaximize`/`minimize`）② `startWindowDrag` ③ `onCloseRequested` 拦截改为后端提供的关闭钩子 ④ 拖放改为后端文件拖放事件（`paths` 数组 + 进入/离开状态）⑤ `exit_app` ⑥ `open-paths` 事件订阅（已在适配层） |
| `src/main.tsx` | 打印窗口分流：由 `window.label === "print"` 改为后端提供的“当前窗口标识”（Wails 传参/窗口名） |
| `src/components/PrintView.tsx` | 「打印…」按钮：调后端“系统打印对话框”（若 P0 验证不可用 → 直接呈现「在浏览器中打印」为唯一主按钮，并隐藏不可用项） |
| `src/components/InfoDialog.tsx` | 第三方许可清单：`Tauri / @tauri-apps` → `Wails`（MIT）+ `Go 标准库`（BSD-3-Clause）+ 实际引入的 Go 模块 |
| `src/styles/app.css` | 增加 Wails 无边框拖拽区域声明（CSS 拖拽区），替换 Mousedown 调 `startDragging` 的兜底；其余样式不变 |
| `vite.config.ts` | dev server 端口/`strictPort` 需与 Wails 配置一致；`define` 增加 `__BACKEND__`；`build.outDir` 保持 `dist/` |
| `package.json` scripts | 增加 `wails:dev` / `wails:build` / `bindings` 脚本；保留 `test`/`build` |

### 7.2 明确不改的文件

`src/editor/*`（CodeMirror 配置、主题、语言）、`src/preview/*`（markdown-it/KaTeX/Mermaid/锚点/图片内联）、`src/tabs/*`（状态机、自动保存决策表、阈值）、`src/files/*`、`src/print/build.ts`、`src/styles/*`（除拖拽区）、`src/components/{EditorHost,PreviewPane,MenuBar,TabBar,StatusBar,SettingsModal,Modal,CloseConfirm,ExternalChangeDialog,PrintDialog}.tsx` 的业务逻辑。

### 7.3 测试影响

- 现有 157 个 vitest 用例中，凡是 mock `invoke` 的用例（`tabs/*.test.ts` 不涉及；主要影响 `App` 级集成）改为 mock 适配层接口。
- 新增：适配层契约测试（对同一组调用断言两套实现返回结构一致，Tauri 版用录制回放/mock）。
- 迁移完成后删除 `tauri.ts` 实现与 `@tauri-apps/*` 依赖。

## 8. 构建、打包与版本

### 8.1 Wails 工程与开发流程

| 环节 | 现状（Tauri） | 迁移后（Wails 3） |
|---|---|---|
| 初始化 | 已有 `src-tauri/` | `wails3 init -n lexora -t react`（模板列表实测：`react` = React + TypeScript + Vite；另有 `vanilla`/`vue`/`svelte` 等），生成骨架后并入本仓库并保留 `src/`、`dist/` |
| 开发 | `npm run dev` + `npx tauri dev` | `wails3 dev`（内部起 vite dev server，端口需与 `vite.config.ts` 一致） |
| 绑定 | 手写 `invoke(name, args)` | `wails3 generate bindings -ts -d bindings`（改 Go 服务后重新生成，前端类型安全） |
| 构建 | `npm run build` + `npx tauri build` | `wails3 build`（把前端产物内嵌进 exe）/ `wails3 package`（安装包） |
| 构建耗时 | 本机 4–6 min（首次更久） | 预计首次 1–2 min，增量 10–40s |
| TLS 绕行 | 需 `node scripts/crates-proxy.mjs` | **删除**（Go 走 `GOPROXY=https://goproxy.cn,direct`，本机实测可用） |

### 8.2 版本号与 `bump-version.mjs` 改造

版本源从 5 处改为 4 处（递增规则不变：micro+1，≥10 进位）：

| 文件 | 用途 | 变化 |
|---|---|---|
| `package.json` / `package-lock.json` | 前端版本（`vite define __APP_VERSION__`） | 保留 |
| `build/config.yml` | 安装包元数据（`productName`/`productVersion`/输出文件名） | **新增** |
| `build/windows/versioninfo.json` | exe 文件属性与产品版本（配合 `goversioninfo` 生成 `.syso`） | **新增** |
| ~~`src-tauri/tauri.conf.json`~~ / ~~`Cargo.toml`~~ / ~~`Cargo.lock`~~ | — | **删除** |
| Go 侧版本 | `-ldflags "-X main.version=1.2.3"`（构建脚本注入，不落盘） | **新增** |

脚本改造要点：`replaceCargoTomlVersion` / `replaceCargoLockVersion` 替换为 `replaceConfigYml`（YAML 文本替换，保留注释与缩进）与 `replaceVersionInfoJson`（四段版本 `1.2.3.0`），可选重新生成 `.syso`。

### 8.3 打包（当前环境实测缺口）

`wails3 doctor` 在本机报告：**NSIS 未安装**、MSIX Packaging Tool / MakeAppx / SignTool 未安装；Tauri 已下载的 NSIS 位于 `%LOCALAPPDATA%\tauri\NSIS`。

| 产物 | 方案 | 备注 |
|---|---|---|
| 便携 exe | `wails3 build` | exe 旁置 `settings/`、`autosave/` 语义不变 |
| NSIS 安装包 | `wails3 package`（需 NSIS） | ① 安装 NSIS ② 或把 `%LOCALAPPDATA%\tauri\NSIS` 加入 PATH；文件关联由 NSIS 脚本在安装时写入 |
| MSI | 决策 **D3** | ① 沿用 WiX（`%LOCALAPPDATA%\tauri\WixTools314` 已存在）自建 `.wxs` + `candle/light` ② 走 MSIX（需额外工具链）③ 暂不产出 |
| 代码签名 | `wails3 sign` / `signtool` | 与现状一致（当前未签名，首次运行仍有 SmartScreen 提示） |

### 8.4 图标与资源

`wails3 generate icons`（沿用现有 `icons/icon.png`/`icon.ico`，或继续用 `scripts/gen-icon.mjs`）→ `build/windows/icon.ico` 等；`goversioninfo` 生成 `.syso`（文件属性 + DPI manifest）。exe 体积预计 8–15 MB。

### 8.5 许可合规

`src/components/InfoDialog.tsx` 第三方清单：删除 `Tauri / @tauri-apps`，新增 **Wails（MIT）**、**Go 标准库（BSD-3-Clause）**、`golang.org/x/sys`（BSD-3-Clause）、`goversioninfo`（MIT，仅构建期）；前端依赖清单不变。

---

## 9. 测试与验收策略

### 9.1 Go 单测（对齐现 `cargo test` 的 35 个用例语义）

| 现 Rust 测试主题 | Go 测试位置 |
|---|---|
| 快照写/读/删、stem 哈希、key 白名单、`originalPath` 信任校验、列表摘要 | `internal/snapshots/*_test.go` |
| 设置默认合并、数值容错、夹取、recent≤20 | `internal/settings/*_test.go` |
| 文本读取（UTF-8/BOM/UTF-16/UTF-32 拒绝）、原子写、512MB 上限 | `internal/files/*_test.go` |
| 图片 base64 + `is_file()` + 40MB 上限、`file_stat`、`classify_paths` | 同上 |
| 启动参数筛选与去重 | `internal/launch/*_test.go` |
| 关联注册计划/参数构造、UserChoice 只读 | `internal/assoc/*_test.go` |
| 打印槽一次性取用 + 32MB 上限 + 临时文件命名/清理 | `internal/printdoc/*_test.go` |
| 字体对话框 pt↔px、结构体尺寸断言（`LOGFONTW`=92、`CHOOSEFONTW`=104） | `internal/fontdlg/*_test.go` |
| 窗口几何过滤（<320×240 丢弃）、BOM 容忍 | `internal/winstate/*_test.go` |

门禁：`gofmt -l` 为空、`go vet ./...` 0 告警、`go test ./...` 全绿（可选 `golangci-lint`）。

### 9.2 前端测试

- `vitest` 157 用例全部保留；仅把 mock 目标从 `@tauri-apps/api` 换成适配层接口。
- 新增适配层契约测试：同一调用在 mock 后端下的返回结构与当前实现逐字段一致（防 Go 侧 JSON 字段名笔误）。

### 9.3 Golden fixture 兼容测试（迁移门禁，见 5.3）

用 0.4.1 生成的真实 `settings.json` / `window.json` / `session.json` / `autosave/*` 作为 fixture，断言 Go 侧解析与写回完全无损。

### 9.4 端到端自动化（复用本会话已验证的手法）

迁移后在 Windows 上仍是 WebView2，因此本会话建立的自动化验收通道可直接复用：

1. 以环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动应用；
2. Node 脚本经 CDP（`Runtime.evaluate`）调用后端方法、读取 DOM 文本、断言打印窗口内容非空；
3. PowerShell 侧 `EnumWindows` 校验原生窗口（打印对话框、打印窗口启用状态、进程数、残留窗口）；
4. 建议把这些脚本从临时目录 `D:\lexora-bench` 迁入仓库 `scripts/e2e/` 纳入版本管理。

### 9.5 `acceptance.zh.md` 条目映射

| 验收分组 | 迁移后验证方式 |
|---|---|
| 构建门禁 | `wails3 build` + 冒烟启动（产物集合按 D3） |
| 窗口与菜单结构 | 人工 + CDP 断言（顶栏拖拽、最大化图标、品牌菜单） |
| 预览标签页 / 锚点与目录 | 人工（前端未改，风险低） |
| 自动保存语义（核心） | Go 单测 + 人工：改文件 → 原文件哈希不变、快照出现 |
| 会话恢复 | Go 单测 + 人工：退出重开 |
| 大文件 L1/L2/L3 | 基准复测（6.3）+ 人工 |
| 主题/字体 | 人工（字体对话框需重测 pt/px 与 CJK 字体名） |
| 文件输入、外部修改与打印 | 拖放（DOM 事件 + 后端筛选）、外部修改（`file_stat` 轮询）、打印（按 D1）逐项人工 + CDP |
| 状态栏 / 快捷键 / 查找替换 | 人工（前端未改） |

---

## 10. 风险登记与缓解

| # | 风险 | 影响 | 概率 | 缓解 | 回滚触发条件 |
|---|---|---|---|---|---|
| R1 | Wails v3 仍是 beta，API 漂移（本机 beta.16 / 最新 beta.19） | 中高 | 高 | 精确锁版本；升级前跑完整门禁；只用第 3–4 节已核对 API | 升级连续出现两个以上阻塞问题 |
| R2 | 打印能力降级（方案 A 需离开应用窗口） | 中 | 高 | 先交方案 A；不可接受再评估方案 B（fork） | 用户否决方案 A |
| R3 | 打包链缺口（NSIS 未安装 / MSI 无官方路径） | 中 | 高 | P1 内解决 NSIS（复用 Tauri 目录或安装）；MSI 按 D3 | MSI 为硬需求且 WiX 复用失败 |
| R4 | 大文件性能或内存劣化（Go GC + JSON 过桥） | 中 | 中 | M4 前跑两轮基准；必要时 `debug.SetMemoryLimit`、零拷贝字符串、去中间结构 | 峰值内存或耗时劣化 >20% |
| R5 | 快照/设置格式漂移导致用户数据失联 | 高 | 中 | golden fixture 门禁 + 真实用户目录只读启动验证 | 任一 fixture 断言失败 |
| R6 | 窗口几何/最大化行为差异（DPI、多屏） | 低 | 中 | 逻辑像素 `Bounds()` + 窗口事件落盘；多屏手工验证 | 高频抖动或恢复尺寸错误 |
| R7 | 字体对话框移植细节（结构体布局、消息泵、CJK 字体名） | 低 | 中 | 尺寸断言测试 + 专用 OS 线程 + 手工验证 | 对话框崩溃或空白 |
| R8 | 双轨维护成本（迁移期同时维护两套后端） | 中 | 中 | 适配层隔离 + 迁移期冻结新功能 + 上限 4 周 | 双轨超期 |
| R9 | Go 代理/网络（`proxy.golang.org` 超时） | 低 | 低 | 固定 `GOPROXY=https://goproxy.cn,direct`（本机已配置且实测可用） | 代理不可用 |
| R10 | 拖放语义变化（HTML5 拖放重新可用，可能与编辑器内文本拖拽冲突） | 低 | 中 | 仅在文件拖放场景 `preventDefault`；回归验证 CodeMirror 文本拖拽 | 编辑器内拖拽失效 |

---

## 11. 分阶段实施路线图

> 原则：**`main`（Tauri）始终可发布**；迁移在 `go-wails3` 分支推进；每阶段结束都有一个可运行的迁移版与明确回滚点。

### P0 · 技术验证 spike（3–5 人日）→ 产出 go/no-go

| 验证项 | 判定标准 |
|---|---|
| 1. 无边框窗口骨架 + CSS 拖拽 + 最大化/还原 + 几何持久化 | 与现顶栏体验一致 |
| 2. 拖放：`EnableFileDrop` + `common:WindowFilesDropped` 取路径 + 前端浮层 | 拖入 `.md` 能拿到绝对路径 |
| 3. 单实例：第二实例 argv 转发到首实例 | 双击第二个文件在首实例打开，且仅 1 个进程 |
| 4. 打印（D1）：应用内预览窗口 + 浏览器交接打印 | Edge 打印预览可用、可取消；无空白无法关闭窗口 |
| 5. 文件对话框 + 字体对话框（`ChooseFontW` 结构体布局） | 对话框正常，CJK 字体名往返正确 |
| 6. 资产/CSP：`AssetOptions.Middleware` 注入 CSP 后页面功能无损 | 与现 CSP 等价且 KaTeX/Mermaid/内联样式正常 |

退出条件：6 项全部通过 → 进入 P1；第 4 项不满足需求 → 决策是否走方案 B（fork）或调整需求。

### P1 · 骨架与基础设施（4–6 人日）

并入 `wails3 init` 骨架、`main.go` + 服务注册、前端适配层（`backend.ts` + `wails.ts`）、CSP 中间件、窗口与关闭流程；`wails3 dev` 热重载下跑通“打开文件 → 编辑 → 保存”。

### P2 · 存储与文件域（5–7 人日）

`paths` / `files` / `snapshots` / `settings` / `session` / `winstate` 全部移植 + Go 单测 + golden fixture 兼容测试；用 0.4.1 用户目录做只读启动验证（设置、最近文件、快照恢复一致）。

### P3 · 系统集成（5–8 人日）

`launch`（argv + 单实例队列）、`assoc`（HKCU 注册/注销/状态 + `SHChangeNotify`）、拖放、`fontdlg`、`printdoc`（方案 A）、`bench`；适配层切到 Wails 实现并移除 `@tauri-apps/*`。

### P4 · 性能与大文件（3–5 人日）

`20×20MB` 与 `10×100MB` 基准复测、内存上限调优、前端 L1/L2/L3 联调；结果补入 `large-file-strategy.zh.md`。

### P5 · 打包发布与验收（3–5 人日）

`build/config.yml` + NSIS（+ MSI 按 D3）、`goversioninfo`、`bump-version.mjs` 改造、`acceptance.zh.md` 全条目走查、文档更新（`design.zh.md`、README、release-notes）、发布 1.0.0 迁移里程碑。

**合计约 23–36 人日**（建议加 20% 缓冲 → **28–43 人日**）。

---

## 12. 里程碑与工作量

| 里程碑 | 内容 | 人日 | 结束标志 |
|---|---|---|---|
| M0 | P0 spike + go/no-go | 3–5 | 6 项验证结论（含 D1 打印决策） |
| M1 | P1 骨架 + 适配层 | 4–6 | `wails3 dev` 下能打开/编辑/保存文件 |
| M2 | P2 存储域 + 兼容门禁 | 5–7 | golden fixture 全绿；真实用户目录数据无损 |
| M3 | P3 系统集成 | 5–8 | 拖放/单实例/关联/字体/打印/外链全部可用 |
| M4 | P4 性能达标 | 3–5 | 与 6.2 基线同量级 |
| M5 | P5 打包验收发布 | 3–5 | 安装包 + 验收清单全过 + 1.0.0 |

---

## 13. 决策点（待确认）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 打印实现 | A 浏览器交接（零依赖）/ B fork Wails 暴露系统打印对话框 / C PrintToPdf | **先落地 A**，B 视需求再评估 |
| D2 | 迁移范围 | 全量迁移 / 仅后端替换并长期双轨 | 全量迁移，双轨保留到 M3 |
| D3 | MSI 是否必须 | 仅 NSIS + 便携 exe / NSIS + MSI（WiX 自建）/ MSIX | **仅 NSIS + exe**；MSI 为硬需求则沿用 WiX |
| D4 | 版本与发布 | 迁移完成发 1.0.0 / 继续 0.x 递增 | 发 **1.0.0** |
| D5 | 前端目录是否改为 Wails 模板结构（`frontend/`） | 保留 `src/` / 改为 `frontend/` | **保留 `src/`**，Wails 配置指向它 |
| D6 | 是否允许 CGO | 全纯 Go（`CGO_ENABLED=0`）/ 允许 CGO | **全纯 Go**（本方案全部无需 CGO） |
| D7 | Wails 版本策略 | 锁 beta.16（本机已装）/ 升 beta.19 / 跟最新 | M0 评估 beta.19 后锁定 |
| D8 | 是否长期保留 Rust 版 | 保留 LTS 分支 / 删除 | 保留至迁移验收通过后再定 |

---

## 附录 A · 命令级迁移对照表

| # | Tauri 命令（前端调用） | Go 服务方法（建议签名） | 前端适配函数 | 备注 |
|---|---|---|---|---|
| 1 | `read_text_file(path)` | `files.ReadTextFile(path string) (FileReadResult, error)` | `readTextFile` | UTF-16/32 拒绝、512MB 上限 |
| 2 | `write_text_file(path,content)` | `files.WriteTextFile(path, content string) error` | `writeTextFile` | 原子写；唯一写原文件入口 |
| 3 | `path_exists(path)` | `files.PathExists(path string) bool` | `pathExists` | |
| 4 | `read_image_base64(path)` | `files.ReadImageBase64(path string) (string, error)` | `readImageBase64` | 40MB + `is_file()` |
| 5 | `file_stat(path)` | `files.FileStat(path string) FileStat` | `fileStat` | 外部修改检测 |
| 6 | `classify_paths(paths)` | `files.ClassifyPaths(paths []string) []PathKind` | `classifyPaths` | 拖放筛选 |
| 7 | `snapshot_write(docKey,content,title,originalPath)` | `snapshots.Write(docKey, content, title string, originalPath *string) error` | `snapshotWrite` | stem 哈希必须逐字一致 |
| 8 | `snapshot_list()` | `snapshots.List() ([]SnapshotInfo, error)` | `snapshotList` | 头部 2KB 摘要 |
| 9 | `snapshot_read(key)` | `snapshots.Read(key string) (SnapshotContent, error)` | `snapshotRead` | |
| 10 | `snapshot_remove(key)` | `snapshots.Remove(key string) error` | `snapshotRemove` | |
| 11 | `read_settings()` | `settings.Read() (AppSettings, error)` | `readSettings` | 默认合并 + 夹取 |
| 12 | `write_settings(settings)` | `settings.Write(s AppSettings) error` | `writeSettings` | |
| 13 | `session_save(paths,activePath)` | `session.Save(s Session) error` | `sessionSave` | |
| 14 | `session_load()` | `session.Load() (Session, error)` | `sessionLoad` | |
| 15 | `take_launch_paths()` | `launch.TakeLaunchPaths() []string` | `takeLaunchPaths` | 取走即清空 |
| 16 | 事件 `open-paths` | `app.Event.Emit("open-paths", paths)` | `onOpenPaths` | 第二实例/拖放/启动参数 |
| 17 | `open_external(url)` | `appsvc.OpenExternal(url string) error` | `openExternal` | 仅 http(s)，内部 `Browser.OpenURL` |
| 18 | `exit_app()` | `appsvc.Quit()` | `exitApp` | 关闭流程主要在 Go 侧 |
| 19 | `assoc_status()` | `assoc.Status() AssocStatus` | `assocStatus` | UserChoice 只读 |
| 20 | `register_md_association()` | `assoc.Register() (AssocStatus, error)` | `registerMdAssociation` | 仅 HKCU |
| 21 | `unregister_md_association()` | `assoc.Unregister() (AssocStatus, error)` | `unregisterMdAssociation` | 仅删除自建键 |
| 22 | `open_default_apps_settings()` | `assoc.OpenDefaultAppsSettings() error` | `openDefaultAppsSettings` | `ms-settings:defaultapps` |
| 23 | `pick_system_font(family,sizePt)` | `fontdlg.Pick(currentFamily string, currentSizePt float64) (*FontPick, error)` | `pickSystemFont` | 专用 OS 线程 |
| 24 | `stage_print_doc(title,html)` | `printdoc.Stage(title, html string) error` | `stagePrintDoc` | 32MB 上限 |
| 25 | `take_print_doc()` | `printdoc.Take() (*PrintDoc, error)` | `takePrintDoc` | 一次性取用 |
| 26 | `open_print_window()` | `printdoc.OpenWindow() error` | `openPrintWindow` | `Window.NewWithOptions` |
| 27 | `close_print_window()` | `printdoc.CloseWindow() error` | `closePrintWindow` | |
| 28 | `print_window_show_dialog()` | `printdoc.PrintSystem() error` | `printWindowShowDialog` | 仅 D1 方案 B 需要 |
| 29 | `print_in_browser(title,html)` | `printdoc.PrintInBrowser(title, html string) (string, error)` | `printInBrowser` | D1 方案 A 主路径 |
| 30 | `bench_targets()` / `process_mem_kb()` | `bench.Targets()` / `bench.MemoryKB()` | `benchTargets` / `processMemKb` | 触发条件不变 |

## 附录 B · 迁移后需要更新的文档

| 文档 | 更新点 |
|---|---|
| `docs/design.zh.md` | 第 1 节架构图、第 4 节 IPC 表（改服务方法）、第 5.9–5.12 流程、第 6 节安全（CSP 注入方式、无 capabilities）、第 8 节目录导览 |
| `docs/requirements.zh.md` | 3.1 顶栏（拖拽改由 CSS 承担）、3.10 打印（D1 结论）、非功能表（构建耗时与安全实现方式） |
| `docs/acceptance.zh.md` | 构建门禁（wails3 产物）、打印条目（按 D1）、字体对话框条目 |
| `docs/large-file-strategy.zh.md` | 新增“Go 后端复测”小节 |
| `docs/release-notes.md` | 迁移里程碑版本条目（1.0.0） |
| `README.md` | 构建方式与依赖（Go 1.25+ / Wails 3 / NSIS）、目录结构 |
| `docs/TODO.md` | 增补迁移后续项（如 D1 方案 B 评估结论） |

## 附录 C · 参考资料

- Wails v3（beta）官网：<https://v3.wails.io/>　· 无边框窗口：<https://v3.wails.io/features/windows/frameless/>　· 文件关联：<https://v3.wails.io/guides/file-associations/>　· 单实例：<https://v3.wails.io/guides/single-instance/>　· Windows 打包：<https://v3.wails.io/guides/build/windows/>　· 安全建议：<https://v3.wails.io/guides/security>
- 本机源码核对：`D:\GoPath\pkg\mod\github.com\wailsapp\wails\v3@v3.0.0-beta.16\pkg\application`（`window_manager.go`、`webview_window.go`、`webview_window_options.go`、`webview_window_windows.go`、`single_instance.go`、`dialog_manager.go`、`browser_manager.go`、`application_options.go`）与 `pkg\events\events.go`
- Go 侧 Win32：`golang.org/x/sys/windows/registry`、`ChooseFontW`(comdlg32)、`ShellExecuteW`/`SHChangeNotify`(shell32)、`GetProcessMemoryInfo`(psapi)
- 本项目现状依据：`docs/design.zh.md`、`docs/large-file-strategy.zh.md`、`docs/acceptance.zh.md`、`src-tauri/src/commands/*`
