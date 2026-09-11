// 端到端回归：CRLF 文件不应被判脏，也不应写入恢复快照。
//
// 背景：CodeMirror 把 CRLF/CR 规范化成 LF，而 diskContent 是磁盘原文；不按行尾规范化比较时，
// 打开任何 CRLF 文件都会立刻显示 ● 未保存 并每个 autosave tick 写一次快照（0.4.1 及更早）。
// 本脚本用真实构建验证：状态栏应为「已保存」，且 13 秒（≥2 个 tick）内 autosave 目录保持为空。
//
// 用法（Windows）：
//   node scripts/e2e/crlf-dirty-check.mjs <lexora.exe 路径> <标签>
// 依赖：D:\lexora-bench\crlf-check.md（CRLF 测试文件）与 WebView2（CDP 端口 9448）。
// 注意：脚本会在 D:\lexora-bench\crlf-<标签>-<pid>\ 建立独立便携沙箱，
// 并先结束该目录下遗留的同名实例（两个版本共用同一 single-instance id，否则新启动会被吞掉）。
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const exeSrc = process.argv[2];
const label = process.argv[3] ?? "run";
const PORT = Number(process.env.CDP_PORT ?? 9448);
const FILE = process.env.CRLF_FILE ?? "D:\\lexora-bench\\crlf-check.md";
const sandbox = `D:\\lexora-bench\\crlf-${label}-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!exeSrc || !existsSync(exeSrc)) {
  console.error(`usage: node crlf-dirty-check.mjs <lexora.exe> <label>\nmissing exe: ${exeSrc}`);
  process.exit(64);
}

try {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='lexora.exe'" | Where-Object { $_.ExecutablePath -like 'D:\\lexora-bench\\crlf-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ], { stdio: "ignore" });
} catch { /* none */ }
await sleep(800);

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
const exe = path.join(sandbox, "lexora.exe");
copyFileSync(exeSrc, exe);
const autosaveDir = path.join(sandbox, "autosave");

const version = execFileSync("powershell", ["-NoProfile", "-Command",
  `(Get-Item '${exe.replace(/\\/g, "\\\\")}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
console.log(`[${label}] exe ProductVersion = ${version}`);

const child = spawn(exe, [FILE], {
  cwd: sandbox,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

let ws = null;
const t0 = Date.now();
while (Date.now() - t0 < 40_000) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) { ws = page.webSocketDebuggerUrl; break; }
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!ws) {
  console.log(`[${label}] FAILED: no DevTools target`);
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  process.exit(1);
}

const sock = new WebSocket(ws);
let id = 0;
const pending = new Map();
await new Promise((r) => sock.addEventListener("open", r));
sock.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evaluate = async (expression) => {
  const i = ++id;
  sock.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const r = await new Promise((res) => pending.set(i, res));
  return r?.result?.value;
};

// 等到状态栏进入“标签态”（就绪 是文件尚未打开时的占位）
let status = null;
for (let i = 0; i < 150; i++) {
  status = await evaluate(`(() => {
     const el = document.querySelector('.statusbar .status-left');
     return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
   })()`);
  if (typeof status === "string" && /已保存|未保存|预览/.test(status)) break;
  await sleep(200);
}
console.log(`[${label}] status bar       = ${JSON.stringify(status)}`);

const snapshots = () => (existsSync(autosaveDir) ? readdirSync(autosaveDir) : []);
console.log(`[${label}] snapshots before = ${JSON.stringify(snapshots())}`);
await sleep(13_000); // ≥2 个 autosave tick（间隔 5s）
const after = snapshots();
console.log(`[${label}] snapshots after  = ${JSON.stringify(after)}`);

const clean = typeof status === "string" && status.includes("已保存") && !status.includes("未保存");
const noSnap = after.length === 0;
console.log(`[${label}] VERDICT: ${clean && noSnap ? "OK（干净：无 ● 未保存、无恢复快照）" : "BAD（仍被判脏 / 写入快照）"}`);

try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
sock.close();
await sleep(1000);
process.exit(clean && noSnap ? 0 : 2);
