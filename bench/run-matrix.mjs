// The bake-off matrix: approach x stack x task x trial, engine jev.
//   node bench/run-matrix.mjs --approaches A,A-h,A+,B,C --n 5 --conc 4 --out bench/results/matrix.jsonl
//   [--stacks vanilla,mui] [--tasks T1,T3] [--budget 30]
// "A" is src/loop.mjs runOnce() imported as-is. Everything else goes through bench/lib/core.mjs.
// Resumable: a (approach, stack, task, trial) already in --out is skipped -- so ALWAYS pass a fresh
// --out to re-measure: the default file is committed and already holds 120 "A" rows (0 runs, $0). Order is interleaved
// (trial -> stack -> task -> approach) so CPU contention lands evenly on every approach.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { serveAll, PORTS } from "./stacks/serve.mjs";
import { TASKS } from "./tasks.mjs";
import { runFlow, httpStats } from "./lib/core.mjs";
import { runOnce } from "../src/loop.mjs";
import { runOnce as runProposal } from "./proposal/src/loop.mjs";
// v1-discover @7039ded, pinned byte-identical into bench/pins/discover (md5s in the results doc)
import { runOnce as runDiscover } from "./pins/discover/src/loop.mjs";
// v1-discover @6e38ddc, pinned into bench/pins/discover2
import { runOnce as runDiscover2 } from "./pins/discover2/src/loop.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const list = (k, d) => (arg(k, d) || "").split(",").filter(Boolean);
const APPROACHES = list("approaches", "A,A-h,A+,B");
const STACKS = list("stacks", Object.keys(PORTS).join(","));
const TASK_IDS = list("tasks", "T1,T2,T3");
const N = Number(arg("n", 5)), CONC = Number(arg("conc", 4)), BUDGET = Number(arg("budget", 30));
const OUT = arg("out", "bench/results/matrix.jsonl");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const MODULES = { "A-h": "a.mjs", "A+": "aplus.mjs", B: "b-aria.mjs", C: "c-cdp.mjs", "A+G": "aplus-g.mjs", BG: "b-g.mjs", CG: "c-g.mjs" };
const mods = {};
for (const a of APPROACHES) if (!["A", "P", "D", "D2"].includes(a) && !a.startsWith("pin:")) mods[a] = (await import(`./approaches/${MODULES[a]}`)).default;

const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(l); done.add(`${r.approach}|${r.stack}|${r.task}|${r.trial}`);
}
const queue = [];
for (let t = 1; t <= N; t++) for (const s of STACKS) for (const k of TASK_IDS) for (const a of APPROACHES)
  if (!done.has(`${a}|${s}|${k}|${t}`)) queue.push({ a, s, k, t });
console.log(`${queue.length} runs queued (${done.size} already in ${OUT})`);

const { bases, close } = await serveAll(STACKS);
const browser = await chromium.launch({ headless: true });
let finished = 0, cost = 0;

async function one({ a, s, k, t }) {
  const flow = { ...TASKS[k] };
  let rec, httpRetries = 0;
  if (a.startsWith("pin:")) {
    // any pinned src/ tree: bench/pins/<dir>/src/loop.mjs, called as plain runOnce
    const { runOnce: run } = await import(`./pins/${a.slice(4)}/src/loop.mjs`);
    rec = await run({ flow, engine: "jev", budget: BUDGET, browser, base: bases[s] });
    rec.approach = a;
  } else if (a === "D2") {
    rec = await runDiscover2({ flow, engine: "jev", budget: BUDGET, browser, base: bases[s] });
    rec.approach = "D2";
  } else if (a === "D") {
    rec = await runDiscover({ flow, engine: "jev", budget: BUDGET, browser, base: bases[s] });
    rec.approach = "D";
  } else if (a === "P") {
    // the proposed src/ (bench/proposal/src), called exactly as a user would call runOnce
    rec = await runProposal({ flow, engine: "jev", budget: BUDGET, browser, base: bases[s] });
    rec.approach = "P";
  } else if (a === "A") {
    // as-is: runOnce has no HTTP retry, so a rate-limited trial is re-run rather than scored
    for (let tries = 0; tries < 4; tries++) {
      rec = await runOnce({ flow, engine: "jev", budget: BUDGET, browser, base: bases[s] });
      if (!(rec.outcome === "ERROR" && /HTTP (429|5\d\d)|fetch failed/.test(rec.error || ""))) break;
      httpRetries++; await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
    }
    rec.approach = "A";
  } else {
    rec = await runFlow({ flow, approach: mods[a], engine: "jev", budget: BUDGET, browser, base: bases[s] });
  }
  const row = { approach: a, stack: s, task: k, trial: t, passed: rec.passed, outcome: rec.outcome, steps: rec.steps.length,
    wallMs: rec.wallMs, decideMs: rec.decideMs, snapMsMedian: rec.snapMsMedian ?? null, cost: rec.cost, error: rec.error, httpRetries,
    path: rec.steps.map((x) => `${x.op}${x.label ? " " + x.label : ""}${x.via ? "@" + x.via : ""}${x.stale ? "!stale" : ""}${x.doneRejected ? "!rej" : ""}`).join(" | "),
    maxDropped: Math.max(0, ...rec.steps.map((x) => x.dropped ?? 0)), finalUrl: rec.finalUrl };
  fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
  cost += rec.cost || 0;
  finished++;
  console.log(`[${finished}/${queue.length}] ${row.passed ? "PASS" : "fail"} ${a.padEnd(4)} ${s.padEnd(8)} ${k} #${t} ${row.steps}st ${row.wallMs}ms ${row.outcome}`);
}

let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (i < queue.length) await one(queue[i++]); }));
await browser.close(); await close();
console.log(`done. cost this invocation $${cost.toFixed(6)}; harness http retries ${httpStats.retries}/${httpStats.calls}`);
