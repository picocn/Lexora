import { useCallback, useEffect, useRef, useState } from "react";
import { closePrintWindow, readSettings, takePrintDoc, type AppSettings, type PrintDoc } from "../ipc/commands";
import { buildPrintCss } from "../print/build";

/** Remembers the staged document across React StrictMode's double-invoked
 * effects (the Rust slot is consumed exactly once). */
let cachedStaged: PrintDoc | null = null;

/**
 * Content of the dedicated print window (`print` label).
 *
 * The main window stages a printable HTML fragment (`stage_print_doc`) and
 * opens this window, which picks the fragment up once, renders it inside a
 * print-styled article and asks the WebView to open the system print dialog
 * (`window.print()`). Printing a separate top-level document keeps the app
 * chrome, tabs and status bar out of the printout.
 */
export function PrintView() {
  const [doc, setDoc] = useState<PrintDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const printedRef = useRef(false);

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

  const close = useCallback(() => {
    void closePrintWindow().catch(() => {
      /* ignore */
    });
  }, []);

  const doPrint = useCallback(() => {
    try {
      window.print();
    } catch {
      /* the system print dialog may be unavailable */
    }
  }, []);

  // Auto-open the print dialog once the document is laid out; the toolbar
  // button stays available in case the WebView blocks the automatic call.
  useEffect(() => {
    if (!doc || printedRef.current) return;
    const t = window.setTimeout(() => {
      if (printedRef.current) return;
      printedRef.current = true;
      doPrint();
    }, 400);
    return () => window.clearTimeout(t);
  }, [doc, doPrint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        doPrint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, doPrint]);

  const css = buildPrintCss({
    fontFamily: settings?.preview.fontFamily,
    fontSizePx: settings?.preview.fontSize,
    // raw (source) printing stays monospaced, matching the editor font.
    rawFontFamily: settings?.editor.fontFamily,
  });

  if (!doc) {
    return (
      <div className="print-view print-view-empty">
        <style>{css}</style>
        <p>{error ?? "正在准备打印…"}</p>
        <div className="print-toolbar">
          <button className="btn" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="print-view">
      <style>{css}</style>
      <div className="print-toolbar no-print">
        <span className="print-toolbar-title" title={doc.title}>
          {doc.title}
        </span>
        <span className="print-toolbar-hint">Ctrl+P 再次打印</span>
        <button className="btn primary" onClick={doPrint}>
          打印
        </button>
        <button className="btn" onClick={close}>
          关闭
        </button>
      </div>
      <article className="print-body" dangerouslySetInnerHTML={{ __html: doc.html }} />
    </div>
  );
}
