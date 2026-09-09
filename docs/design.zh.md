# Lexora 设计文档（Design）

- 适用版本：0.2.2
- 配套：`requirements.zh.md`、`acceptance.zh.md`、`large-file-strategy.zh.md`

## 1. 总体架构
```
┌────────────────────────────────────────────────────────────┐
│ React 18 渲染层（WebView2，生产 CSP 由 tauri 注入）          │
│  App.tsx 状态编排  ·  components/* UI  ·  tabs/ 状态机      │
│  editor/ CodeMirror6  ·  preview/ 渲染  ·  ipc/ 命令封装    │
├────────────────────────────────────────────────────────────┤
│ Tauri 2 IPC（invoke + 能力授权 capabilities/default.json）   │
├────────────────────────────────────────────────────────────┤
│ Rust 后端（src-tauri）                                      │
│  commands/{files,snapshots,settings,session,font,bench}    │
│  paths.rs（可移植目录）  window_state.rs（几何持久化）       │
│  本地文件系统（原文件 / settings\ / autosave\）             │
└────────────────────────────────────────────────────────────┘
```
- 单进程多 WebView 子进程（WebView2 实际内存都落在 msedgewebview2.exe 侧）。
- 前端纯逻辑放在 `tabs/store.ts` 等可单测模块；组件不直接持有业务数据（`App` 唯一真相持有者，`tabsRef` 镜像）。

## 2. 关键数据结构
### Tab / TabsState（src/tabs/types.ts）
- `TabModel`：id(kind 前缀 file:/untitled:/preview:)、title、path、docKey(=path 或未命名 id)、sourceTabId、manualSaved、diskContent、utf8Ok/utf8Bom、languageOverride
- `Tab`：model + `cmState`(EditorState) + `comps`(lang/theme/prefs Compartment) + langExt + lastSnapshotContent + `unloaded?`
- `TabsState`：tabs[] + activeId + nextUntitled

### AppSettings（settings.json）
autosave{enabled,intervalSec}、editor{fontFamily,fontSize,lineHeight,tabSize,wordWrap,lineNumbers}、preview{fontFamily,fontSize}、theme{kind:'builtin'|'vscode',id}、layout:'split'|'edit'|'preview'、recentFiles(≤10)
- 读取为“默认值对象 + 覆盖合并”（serde 缺字段默认；前端 settings 会话恢复跳过超大）。
- 数字字段容错：u64 字段经浮点取整 deserializer 接受小数输入。

### 快照（autosave/<stem>.md + <stem>.meta.json）
- stem = 可读前缀(≤80) + `-hash`（对 docKey 哈希）；写入 sanitize，读取 resolve_stem 双重约定（列表 stem / 原始 docKey），**拒绝路径分隔符/驱动符/`..`**（防穿越）
- meta：{originalPath,title,modifiedAtMs}

## 3. 目录与持久化（paths.rs）
```
<exe>\settings\settings.json · window.json · session.json
<exe>\autosave\<stem>.md(+.meta.json)
```
- exe 目录可写探测（一次性缓存，`.probe-<pid>` 创建/删除），不可写回退：
  settings→app_config_dir；autosave→app_data_dir/autosave
- 所有写盘：临时文件 + rename（原子），避免崩溃截断；BOM 容忍读取。

## 4. IPC 命令表（前端 ipc/commands.ts ↔ lib.rs）
| 命令 | 入参 | 返回 |
|---|---|---|
| read_text_file | path | {content,utf8Ok,utf8Bom,byteLen}（UTF-16/32 报错） |
| write_text_file | path,content | ()（原子写；手动保存唯一写原文件入口） |
| path_exists | path | bool |
| read_image_base64 | path | base64 字符串（≤40MB） |
| snapshot_write / list / read / remove | docKey,… / - / key / key | - / Info[] / Content / - |
| read_settings / write_settings | - / settings | AppSettings / () |
| session_save / load | paths,activePath / - | () / Session |
| exit_app | - | 退出进程（先存窗口几何） |
| pick_system_font | currentFamily,currentSizePt | {family,sizePt}\|null（异步，不阻塞 UI 线程） |
| bench_targets / process_mem_kb（内部） | - | BenchTargets\|err / KiB |

能力（capabilities/default.json）：core:default + window allow-close/destroy/minimize/toggle-maximize/start-dragging + dialog:default。

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
- openLoaded：`veryLarge=chars≥40M` → noHistory=true；且先做**预卸载**（把最老的非活动超大干净标签退化为占位，保持常驻 ≤4）
- 常驻上限兜底 effect 同规则
- onActivate：目标 tab `unloaded` → 读盘 + 原地 reloadBigTab（保留 id/顺序、恢复 languageOverride）+ “正在加载大文件…”；失败则保持原活动并提示
- 细节与实测见 `large-file-strategy.zh.md`

### 5.4 预览（防 OOM）
- PreviewPane：text>800 万字符 → 跳过渲染，显示“预览已禁用”说明（三种入口一致）
- 正常路径：debounce 300ms → render.ts（markdown-it html:false + texmath/KaTeX + mermaid 块 + data-line）→ mermaid lazy render + 图片 fixup（decodeURIComponent→resolveLocalImageSrc→read_image_base64→data URL）
- 分屏滚动同步：块级 data-line ↔ 编辑器视口行

### 5.5 主题
- 内置 light/dark 静态 HighlightStyle + palette；VS Code 导入 JSON 解析（含 tokenColors 前缀→Tag、颜色保留；状态栏 statusBg 取 statusBar.background，缺省中性色）存储于 localStorage（lexora.vscodeThemes.v1），可在设置删除；删除在用主题回退内置浅色

### 5.6 退出确认口径（v0.2.2 后）
- 退出应用：不再询问（自动快照+退出）
- 关闭单个未保存标签：仍询问 保存/不保存并关闭/取消

## 6. 安全与健壮性
- 生产 CSP：`default-src 'self' … style-src 'self' 'unsafe-inline'; img-src data: http: https:`（devCsp 放行 dev）
- 无 assetProtocol（本地图片全部走 read_image_base64）
- 快照 key 字符集白名单（防穿越）；UTF-16/32 拒读；图片尺寸 40MB 上限；输入校验/报错全走 Result 文案
- FFI：仅 font.rs ChooseFontW（结构体 x64 布局校验、线程消息队列），bench.rs PSAPI

## 7. 已知限制 / 演进
- 预览为整篇渲染：>800 万字符禁用（OOM 护栏）；远期可做分段/虚拟化预览
- 超大文档编辑：驻留上限策略缓解，仍有边界 GC 尖峰（可下调 K）
- 非 UTF-8 原文不支持原地编辑
- 无 Windows 10/11 之外的构建目标

## 8. 目录导览
```
src-tauri/src/        lib.rs · paths.rs · window_state.rs · commands/*
src/                  App.tsx · components/ · editor/ · preview/ · tabs/ · ipc/ · styles/
scripts/              bump-version.mjs · crates-proxy.mjs · gen-icon.mjs
docs/                 requirements · design · acceptance · large-file-strategy
```
