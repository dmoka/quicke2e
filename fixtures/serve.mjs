// Tiny static server for the fixture pages + a truth-log endpoint.
// Node's http only. No framework, no dependency. Runnable: `node serve.mjs [port]`.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages");

// Recorded into the page by truth.js: every real interaction with a [data-truth] element.
// This is how the harness grades "did it hit the RIGHT element", not merely "did it survive".
const TRUTH = `(function(){
  function send(e,type){
    var t=e.target; if(!t||!t.closest) return;
    var el=t.closest('[data-truth]'); if(!el) return;
    try{ navigator.sendBeacon('/_truth', JSON.stringify({
      truth: el.getAttribute('data-truth'), type: type, id: el.id||'',
      value: (el.value===undefined?'':String(el.value)).slice(0,60),
      page: location.pathname })); }catch(x){}
  }
  document.addEventListener('click',function(e){send(e,'click');},true);
  document.addEventListener('change',function(e){send(e,'change');},true);
  document.addEventListener('input',function(e){send(e,'input');},true);
})();`;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export function startStatic(port = 8899) {
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/truth.js") {
      res.writeHead(200, { "Content-Type": TYPES[".js"] }); return res.end(TRUTH);
    }
    if (u.pathname === "/_truth") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(log));
      }
      let b = ""; req.on("data", (c) => (b += c));
      return req.on("end", () => {
        try { log.push(JSON.parse(b)); } catch {}
        res.writeHead(204); res.end();
      });
    }
    if (u.pathname === "/_truth/reset") { log.length = 0; res.writeHead(204); return res.end(); }
    // A server error page (attack cases: a crafted URL that crashes the app).
    if (u.pathname === "/_500") { res.writeHead(500, { "Content-Type": TYPES[".html"] }); return res.end("<h1>Internal Server Error</h1><a href='/login.html'>Home</a>"); }

    // Path ids, like an app route: /orders/<n> serves one page for every n (map routing fixture).
    const rel = u.pathname === "/" ? "/login.html" : u.pathname === "/orders" ? "/orders.html"
      : /^\/orders\/\d+$/.test(u.pathname) ? "/order-id.html" : u.pathname;
    const file = path.join(DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({
    server, port,
    base: `http://127.0.0.1:${port}`,
    reset: () => { log.length = 0; },
    truth: () => log.slice(),
    close: () => new Promise((d) => server.close(d)),
  })));
}

// Windows paths, spaces (%20) and symlinks (/tmp -> /private/tmp) never equal the raw file:// string
// (platform test W7: the README quick try exited silently on Windows).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const s = await startStatic(Number(process.argv[2]) || 8899);
  console.log(`fixtures on ${s.base}`);
}
