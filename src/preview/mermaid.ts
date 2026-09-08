// Lazy mermaid renderer. Mermaid is heavy (~1MB+), so it is loaded only when
// the preview actually contains a diagram, and only once per process.

type MermaidModule = {
  initialize(cfg: Record<string, unknown>): void;
  run(opts: { nodes: HTMLElement[] }): Promise<void>;
};

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = (mod.default ?? mod) as MermaidModule;
      mermaid.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
        fontFamily: "Consolas, 'Courier New', monospace",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Renders every `pre.mermaid` inside `container` into an SVG diagram. */
export async function renderMermaidIn(container: HTMLElement): Promise<void> {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>("pre.mermaid"));
  if (!nodes.length) return;
  try {
    const mermaid = await loadMermaid();
    await mermaid.run({ nodes });
  } catch (e) {
    // Mark failed diagrams so the user can see something went wrong.
    for (const n of nodes) {
      n.textContent = `[Mermaid 渲染失败: ${e instanceof Error ? e.message : String(e)}]`;
    }
  }
}
