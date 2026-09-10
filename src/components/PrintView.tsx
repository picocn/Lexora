import { useCallback, useEffect, useRef, useState } from "react";
import {
  closePrintWindow,
  printInBrowser,
  printWindowShowDialog,
  readSettings,
  takePrintDoc,
  type AppSettings,
  type PrintDoc,
} from "../ipc/commands";
import { buildPrintCss, buildStandalonePrintDocument } from "../print/build";

/** Remembers the staged document across React StrictMode's double-invoked
 * effects (the Rust slot is consumed exactly once). */
let cachedStaged: PrintDoc | null = null;

/**
 * Content of the dedicated print window (`print` label).
 *
 * The main window stages a printable HTML fragment (`stage_print_doc`) and
 * opens this window, which picks the fragment up once, renders it inside a
 * print-styled article and asks Rust to open the **system** print dialog for
 * this webview (`ICoreWebView2_16::ShowPrintUI` with the OS dialog).
 *
 * `window.print()` is intentionally not used: in WebView2 it switches the
 * webview to Chromium's `edge://print` preview, which some runtime builds
 * render as a blank, undismissable page. If the system dialog is unavailable
 * (older runtime), the toolbar offers printing through the default browser.
 */
export function PrintView() {
  const [doc, setDoc] = useState<PrintDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const autoPrintedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const staged = cachedStaged ?? (await takePrintDoc());
        if (disposed) return;
        if (!staged) {
          setError("没有待打印的内容（请重新从主窗口发起打印）。");
          return;
        }
        cachedStaged = staged;
        setDoc(staged);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      try {
        const s = await readSettings();
        if (!disposed) setSettings(s);
      } catch {
        /* browser preview / settings unavailable: print with defaults */
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const fontCss = buildPrintCss({
    fontFamily: settings?.preview.fontFamily,
    fontSizePx: settings?.preview.fontSize,
    // raw (source) printing stays monospaced, matching the editor font.
    rawFontFamily: settings?.editor.fontFamily,
  });

  // The window title shows up in the print dialog / taskbar; keep it in sync
  // with the document being printed.
  useEffect(() => {
    if (doc) document.title = doc.title;
  }, [doc]);

  const close = useCallback(() => {
    void closePrintWindow().catch(() => {
      /* ignore */
    });
  }, []);

  /** System print dialog (native, closable; no Chromium preview page). */
  const printSystem = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      await printWindowShowDialog();
    } catch (e) {
      setNotice(`系统打印对话框不可用：${e}　可改用「在浏览器中打印」。`);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Fallback: hand the document to the default browser and let it print. */
  const printBrowser = useCallback(async () => {
    if (!doc) return;
    setNotice(null);
    setBusy(true);
    try {
      const document_ = buildStandalonePrintDocument({
        title: doc.title,
        html: doc.html,
        css: fontCss,
        autoPrint: true,
      });
      await printInBrowser(doc.title, document_);
      setNotice("已用默认浏览器打开打印页（在浏览器中确认打印即可）。");
    } catch (e) {
      setNotice(`在浏览器中打印失败：${e}`);
    } finally {
      setBusy(false);
    }
  }, [doc, fontCss]);

  // Open the system dialog once the document is laid out; the toolbar button
  // stays available for repeat prints.
  useEffect(() => {
    if (!doc || autoPrintedRef.current) return;
    autoPrintedRef.current = true;
    const t = window.setTimeout(() => void printSystem(), 450);
    return () => window.clearTimeout(t);
  }, [doc, printSystem]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        void printSystem();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, printSystem]);

  if (!doc) {
    return (
      <div className="print-view print-view-empty">
        <style>{fontCss}</style>
        <p>{error ?? "正在准备打印…"}</p>
        <div className="print-toolbar no-print">
          <button className="btn" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="print-view">
      <style>{fontCss}</style>
      <div className="print-toolbar no-print">
        <span className="print-toolbar-title" title={doc.title}>
          {doc.title}
        </span>
        <button className="btn primary" disabled={busy} onClick={() => void printSystem()}>
          打印…
        </button>
        <button className="btn" disabled={busy} onClick={() => void printBrowser()}>
          在浏览器中打印
        </button>
        <button className="btn" onClick={close}>
          关闭
        </button>
      </div>
      {notice && <div className="print-notice no-print">{notice}</div>}
      <article className="print-body" dangerouslySetInnerHTML={{ __html: doc.html }} />
    </div>
  );
}
