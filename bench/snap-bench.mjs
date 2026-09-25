// Snapshot cost in isolation (no model, no concurrency): median of 20 snapshots per approach per
// page, every stack's three start pages. node bench/snap-bench.mjs
import { chromium } from "playwright";
import { serveAll, PORTS } from "./stacks/serve.mjs";
import { TASKS } from "./tasks.mjs";
const APS = { "A-h": "a.mjs", "A+": "aplus.mjs", B: "b-aria.mjs", C: "c-cdp.mjs" };
const mods = {}; for (const [k, f] of Object.entries(APS)) mods[k] = (await import(`./approaches/${f}`)).default;
const { bases, close } = await serveAll();
const browser = await chromium.launch();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const table = {};
for (const s of Object.keys(PORTS)) for (const [k, t] of Object.entries(TASKS)) {
  const pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await pg.goto(bases[s] + t.start); await pg.waitForTimeout(900);
  const row = {};
  for (const [a, m] of Object.entries(mods)) {
    await m.snapshot(pg);   // warm-up (CDP session, injected script)
    const ms = []; let n = 0;
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); const sn = await m.snapshot(pg); ms.push(performance.now() - t0); n = sn.actions.length; }
    row[a] = { ms: Math.round(med(ms) * 10) / 10, actions: n };
  }
  table[`${s} ${t.start}`] = row;
  console.log(`${s.padEnd(8)} ${t.start.padEnd(11)} ` + Object.entries(row).map(([a, r]) => `${a} ${r.ms}ms/${r.actions}`).join("  "));
  await pg.close();
}
const col = (a) => med(Object.values(table).map((r) => r[a].ms));
console.log("\nmedian over 24 pages: " + Object.keys(APS).map((a) => `${a} ${col(a)} ms`).join(", "));
console.log("ratio vs A-h: " + Object.keys(APS).map((a) => `${a} ${(col(a) / col("A-h")).toFixed(2)}x`).join(", "));
await browser.close(); await close();
