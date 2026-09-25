// Regression harness. Points at ANY checkout of agent-browser-test and grades every fixture.
//   node run.mjs --checkout ~/dev/agent-browser-test [--n 3] [--only id,id] [--budget 30]
//   node run.mjs --checkout <path> --save-baseline      # freeze today's numbers
// Exits non-zero when a fixture that used to pass (verdict or right-element) no longer does.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStatic } from "./serve.mjs";
import { startProxy } from "./proxy.mjs";
import { FIXTURES } from "./flows.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes("--" + k);

let checkout = path.resolve((arg("checkout", "~/dev/agent-browser-test") || "").replace(/^~/, process.env.HOME));
// --pin freezes the target before measuring it. The shared main checkout was edited
// mid-benchmark on 2026-09-21 (PRIORITY reverted between two runs), which silently
// invalidates any number taken against a live tree.
if (arg("pin")) {
  const { execFileSync } = await import("node:child_process");
  const dest = path.join(HERE, "checkouts", arg("pin"));
  fs.mkdirSync(dest, { recursive: true });
  // AUDIT 2026-09-24: exclude fixtures/checkouts, or pinning a checkout copies its own earlier pins into the pin.
  execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", "fixtures/checkouts",
    "--exclude", "local-engine/.venv", "--exclude", "runs", checkout + "/", dest + "/"]);
  fs.rmSync(path.join(dest, "node_modules"), { force: true, recursive: true });
  fs.symlinkSync(path.join(checkout, "node_modules"), path.join(dest, "node_modules"), "dir");
  const md5 = (f) => execFileSync("md5", ["-q", path.join(dest, f)]).toString().trim();
  console.log(`pinned ${checkout} -> ${dest}\n  loop.mjs ${md5("src/loop.mjs")}  snapshot.js ${md5("src/snapshot.js")}`);
  checkout = dest;
}
const N = Number(arg("n", 3));
const BUDGET = Number(arg("budget", 30));
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const BASELINE = arg("baseline", path.join(HERE, "baseline.json"));
const UPSTREAM = process.env.LOCAL_UPSTREAM || "http://127.0.0.1:8822";
// AUDIT 2026-09-24: the engine was hardcoded to "local", so the suite could not grade jev at all.
const ENGINE = arg("engine", "local");
// Hosted engines bypass proxy.mjs, so record their calls in the same shape by wrapping fetch.
const hostedCalls = [];
let costTotal = 0;
if (ENGINE !== "local") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!/openrouter\.ai\/api\/alpha\/decisions|ai-gateway\.vercel\.sh\/v1\/evaluate/.test(u)) return realFetch(url, init);
    let sent = null; try { sent = JSON.parse(init.body); } catch {}
    const st = typeof sent?.state === "string" ? JSON.parse(sent.state) : sent?.state;
    const res = await realFetch(url, init);
    let ans = null; try { ans = await res.clone().json(); } catch {}
    hostedCalls.push({ url: st?.url ?? null, elements: st?.elements ?? [],
      criteria: Object.keys(sent?.questions?.action?.criteria || {}),
      criteriaText: sent?.questions?.action?.criteria || {},
      choice: ans?.answers?.action?.choice ?? null, confidence: ans?.answers?.action?.confidence ?? null,
      raw: String(init.body || ""), status: res.status, seen: Object.keys(sent?.questions?.action?.criteria || {}).length });
    return res;
  };
}

const statics = await startStatic(Number(arg("port", 8899)));
const proxy = await startProxy({ upstream: UPSTREAM, port: Number(arg("proxy-port", 8823)) });
// Set BEFORE importing the checkout: loop.mjs reads LOCAL_URL at module load.
process.env.LOCAL_URL = proxy.url;
process.env.APP_BASE = statics.base;

const loop = await import(pathToFileURL(path.join(checkout, "src", "loop.mjs")).href);
const { runOnce, chromium } = loop;
const SNAPSHOT_SRC = fs.readFileSync(path.join(checkout, "src", "snapshot.js"), "utf8");

let browser = await chromium.launch({ headless: true });
// AUDIT 2026-09-24: other agents on this machine kill Chromium; relaunch instead of cascading HARNESS_ERRORs.
let relaunches = 0;
const live = async () => { if (!browser.isConnected()) { relaunches++; browser = await chromium.launch({ headless: true }); } return browser; };
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const results = {};

for (const fx of FIXTURES) {
  if (ONLY.length && !ONLY.includes(fx.id)) continue;

  if (fx.kind === "probe") {
    const ctx = await (await live()).newContext();
    const page = await ctx.newPage();
    await page.goto(statics.base + fx.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);
    const snap = await page.evaluate(`(${SNAPSHOT_SRC})()`);
    const r = await fx.check(snap, page);
    await ctx.close();
    results[fx.id] = { kind: "probe", defect: fx.defect, want: fx.want, ok: r.ok ? 1 : 0, n: 1,
      pass: r.ok ? 1 : 0, steps: 0, notes: [r.note] };
    console.log(`  ${r.ok ? "ok  " : "FAIL"} ${fx.id.padEnd(20)} ${r.note}`);
    continue;
  }

  let okN = 0, passN = 0; const stepCounts = [], notes = [], outcomes = [];
  for (let i = 0; i < N; i++) {
    statics.reset(); proxy.reset(); hostedCalls.length = 0; await live();
    let rec;
    try { rec = await runOnce({ flow: fx.flow, engine: ENGINE, budget: BUDGET, browser, base: statics.base }); }
    catch (e) { rec = { passed: false, outcome: "HARNESS_ERROR", error: String(e.message || e), steps: [], finalUrl: statics.base }; }
    await new Promise((r) => setTimeout(r, 120)); // let sendBeacon flush
    costTotal += rec.cost || 0;
    if (arg("traces")) { fs.mkdirSync(arg("traces"), { recursive: true });
      fs.writeFileSync(path.join(arg("traces"), `${fx.id}.${i + 1}.json`), JSON.stringify({ rec, truth: statics.truth(),
        calls: ENGINE === "local" ? proxy.calls() : hostedCalls.slice() }, null, 2)); }
    const g = await fx.grade({ rec, truth: statics.truth(), calls: ENGINE === "local" ? proxy.calls() : hostedCalls.slice() });
    if (g.ok) okN++;
    if (rec.passed) passN++;
    stepCounts.push(rec.steps.length);
    outcomes.push(rec.outcome);
    notes.push(g.note);
  }
  results[fx.id] = { kind: "flow", defect: fx.defect, want: fx.want, ok: okN, pass: passN, n: N,
    steps: median(stepCounts), notes: [...new Set(notes)], outcomes: [...new Set(outcomes)] };
  console.log(`  ${okN === N ? "ok  " : "FAIL"} ${fx.id.padEnd(20)} right-element ${okN}/${N} · verdict ${passN}/${N} · ${median(stepCounts)} steps · ${[...new Set(outcomes)].join("/")}`);
  console.log(`       ${[...new Set(notes)].join(" ;; ")}`);
}

await browser.close();
console.log(`\nengine=${ENGINE}  reported cost $${costTotal.toFixed(6)}  browser relaunches ${relaunches}`);
await statics.close();
await proxy.close();

// ---- report ----
const W = [22, 46, 15, 10, 7];
const row = (c) => c.map((s, i) => String(s).padEnd(W[i])).join("");
console.log("\n" + row(["FIXTURE", "DEFECT", "RIGHT ELEMENT", "VERDICT", "STEPS"]));
console.log("-".repeat(W.reduce((a, b) => a + b, 0)));
for (const [id, r] of Object.entries(results))
  console.log(row([id, r.defect, `${r.ok}/${r.n}`, `${r.pass}/${r.n}`, r.steps || "-"]));

if (flag("save-baseline")) {
  fs.writeFileSync(BASELINE, JSON.stringify({ checkout, at: new Date().toISOString(), n: N, results }, null, 2));
  console.log(`\nbaseline saved -> ${BASELINE}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) { console.log(`\nno baseline at ${BASELINE}; run with --save-baseline`); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const regressions = [];
for (const [id, r] of Object.entries(results)) {
  const b = base.results[id]; if (!b) continue;
  const bOk = b.ok / b.n, bPass = b.pass / b.n, cOk = r.ok / r.n, cPass = r.pass / r.n;
  if (cOk < bOk) regressions.push(`${id}: right-element ${b.ok}/${b.n} -> ${r.ok}/${r.n}`);
  else if (cPass < bPass) regressions.push(`${id}: verdict ${b.pass}/${b.n} -> ${r.pass}/${r.n}`);
}
const fixed = Object.entries(results).filter(([id, r]) => base.results[id] && r.ok / r.n > base.results[id].ok / base.results[id].n);
if (fixed.length) console.log(`\nIMPROVED: ${fixed.map(([id]) => id).join(", ")}`);
if (regressions.length) { console.log("\nREGRESSIONS:\n  " + regressions.join("\n  ")); process.exit(1); }
console.log("\nno regressions vs baseline");
