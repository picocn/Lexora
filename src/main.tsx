import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PrintView } from "./components/PrintView";
import "./styles/app.css";
import "katex/dist/katex.min.css";

/** The dedicated print window loads this same entry point; it renders the
 * printable document instead of the editor workbench. */
async function isPrintWindow(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label === "print";
  } catch {
    return false; // plain browser preview
  }
}

void (async () => {
  const print = await isPrintWindow();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{print ? <PrintView /> : <App />}</React.StrictMode>,
  );
})();
