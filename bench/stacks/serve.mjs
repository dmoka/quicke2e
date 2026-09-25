// Serves every built stack on a fixed port. Unknown paths fall back to index.html (SPA + MPA routing).
//   node bench/stacks/serve.mjs            -> all stacks
//   import { serveAll } from "./serve.mjs" -> { stack: base }
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export const PORTS = { vanilla: 5101, mui: 5102, antd: 5103, radix: 5104, "vue-ep": 5105, wc: 5106, iframe: 5107, legacy: 5108 };
const DIST = path.join(import.meta.dirname, "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png" };

function serveOne(stack, port) {
  const root = path.join(DIST, stack);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let file = path.join(root, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

export async function serveAll(only = Object.keys(PORTS)) {
  const servers = [], bases = {};
  for (const s of only) { servers.push(await serveOne(s, PORTS[s])); bases[s] = `http://127.0.0.1:${PORTS[s]}`; }
  return { bases, close: () => Promise.all(servers.map((sv) => new Promise((d) => sv.close(d)))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { bases } = await serveAll();
  for (const [s, b] of Object.entries(bases)) console.log(`${s.padEnd(8)} ${b}`);
}
