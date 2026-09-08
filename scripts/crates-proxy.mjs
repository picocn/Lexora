// Local crates.io sparse-index + download proxy.
// Why: on this machine schannel (used by cargo/curl/.NET) cannot establish TLS
// (SEC_E_NO_CREDENTIALS), while Node's bundled TLS works fine. Cargo is pointed
// at `sparse+http://127.0.0.1:8123/` via CARGO_HOME config; every request here
// is forwarded to crates.io using Node fetch. The config.json "dl" field is
// rewritten so crate downloads also route through this proxy.
import { createServer } from "node:http";
import { Readable } from "node:stream";

const PORT = 8123;
const INDEX = "https://index.crates.io";
const DL = "https://static.crates.io/crates";

async function relay(req, res, upstream) {
  const headers = {};
  if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
  try {
    const up = await fetch(upstream, { method: "GET", headers, redirect: "follow" });
    res.writeHead(up.status, {
      "content-type": up.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": up.headers.get("cache-control") ?? "no-cache",
      etag: up.headers.get("etag") ?? "",
    });
    if (up.status !== 304 && up.body) {
      await new Promise((resolve, reject) => {
        Readable.fromWeb(up.body).pipe(res).on("close", resolve).on("error", reject);
      });
    } else {
      res.end();
    }
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`proxy upstream error: ${e.message}`);
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/config.json") {
    // Serve crates.io's config but rewrite "dl" through the proxy.
    fetch(`${INDEX}/config.json`)
      .then(async (up) => {
        const cfg = await up.json();
        cfg.dl = `http://127.0.0.1:${PORT}/crate-dl`;
        cfg.api = `http://127.0.0.1:${PORT}/api`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(cfg));
      })
      .catch((e) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`config error: ${e.message}`);
      });
    return;
  }

  if (path.startsWith("/crate-dl/")) {
    // /crate-dl/{crate}/{version}/download -> static.crates.io/crates/{crate}/{version}/download
    relay(req, res, `${DL}${path.slice("/crate-dl".length)}`);
    return;
  }

  if (path.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("api not proxied");
    return;
  }

  // Sparse index file: /{prefix}/{name}
  relay(req, res, `${INDEX}${path}`);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`crates.io proxy listening on http://127.0.0.1:${PORT}`);
});
