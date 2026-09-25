// Ad-hoc: dump the raw snapshot for one fixture page from a given checkout.
//   node inspect.mjs --checkout <path> --url /table.html
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStatic } from "./serve.mjs";
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const checkout = path.resolve((arg("checkout", "~/dev/agent-browser-test") || "").replace(/^~/, process.env.HOME));
const s = await startStatic(Number(arg("port", 8901)));
const { chromium } = await import(pathToFileURL(path.join(checkout, "src", "loop.mjs")).href);
const SRC = fs.readFileSync(path.join(checkout, "src", "snapshot.js"), "utf8");
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext()).newPage();
await p.goto(s.base + arg("url", "/table.html"), { waitUntil: "domcontentloaded" });
await p.waitForTimeout(400);
const snap = await p.evaluate(`(${SRC})()`);
const byRole = {};
for (const a of snap.actions) byRole[a.role + ":" + a.kind] = (byRole[a.role + ":" + a.kind] || 0) + 1;
console.log("actions:", snap.actions.length, byRole);
console.log("first 34 (node/kind/role/label):");
const seen = new Set();
for (const a of snap.actions) { if (seen.has(a.node)) continue; seen.add(a.node);
  if (seen.size > 34) break; console.log(`  ${a.node.padEnd(5)} ${a.kind.padEnd(7)} ${String(a.role).padEnd(10)} ${String(a.label).slice(0, 40)}`); }
console.log("last 4 nodes:", snap.actions.slice(-4).map((a) => `${a.node}/${a.role}/${a.label}`));
await b.close(); await s.close();
