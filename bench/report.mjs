// Aggregates bench/results/matrix.jsonl -> markdown tables. node bench/report.mjs [file]
import fs from "node:fs";
const file = process.argv[2] || "bench/results/matrix.jsonl";
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const APS = ["A", "A-h", "A+", "B", "C", "A+G", "BG", "CG", "P", "D"].filter((a) => rows.some((r) => r.approach === a));
const STACKS = [...new Set(rows.map((r) => r.stack))];
const TASKS = ["T1", "T2", "T3"];
const cell = (a, s, k) => rows.filter((r) => r.approach === a && r.stack === s && r.task === k);

console.log("### Pass rate (pass/n)\n");
console.log(`| stack | task | ${APS.join(" | ")} |`);
console.log(`|---|---|${APS.map(() => "---").join("|")}|`);
for (const s of STACKS) for (const k of TASKS) {
  console.log(`| ${s} | ${k} | ${APS.map((a) => { const c = cell(a, s, k); return c.length ? `${c.filter((r) => r.passed).length}/${c.length}` : "–"; }).join(" | ")} |`);
}
console.log("\n### Totals per approach\n");
console.log("| approach | cells | pass | pass T1+T2 | median steps (passing) | median wall ms (passing) | median snapshot ms | total cost $ | cost / run $ |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const a of APS) {
  const r = rows.filter((x) => x.approach === a);
  const p = r.filter((x) => x.passed);
  const t12 = r.filter((x) => x.task !== "T3");
  const cells = new Set(r.map((x) => x.stack + x.task)).size;
  const snaps = r.map((x) => x.snapMsMedian).filter((x) => x != null);
  const cost = r.reduce((n, x) => n + (x.cost || 0), 0);
  console.log(`| ${a} | ${cells} | ${p.length}/${r.length} | ${t12.filter((x) => x.passed).length}/${t12.length} | ${med(p.map((x) => x.steps)) ?? "–"} | ${med(p.map((x) => x.wallMs)) ?? "–"} | ${snaps.length ? med(snaps) : "–"} | ${cost.toFixed(6)} | ${(cost / r.length).toFixed(6)} |`);
}
console.log("\n### Per-cell medians for passing runs: steps / wall ms / snapshot ms\n");
console.log(`| stack | task | ${APS.join(" | ")} |`);
console.log(`|---|---|${APS.map(() => "---").join("|")}|`);
for (const s of STACKS) for (const k of TASKS) {
  console.log(`| ${s} | ${k} | ${APS.map((a) => { const c = cell(a, s, k); const p = c.filter((r) => r.passed);
    const sn = med(c.map((r) => r.snapMsMedian).filter((x) => x != null));
    return c.length ? `${p.length ? med(p.map((r) => r.steps)) + " / " + med(p.map((r) => r.wallMs)) : "– / –"} / ${sn ?? "–"}` : "–"; }).join(" | ")} |`);
}
const total = rows.reduce((n, x) => n + (x.cost || 0), 0);
console.log(`\nruns: ${rows.length}, total OpenRouter cost in this file: $${total.toFixed(6)}, http retries (A as-is re-runs): ${rows.reduce((n, x) => n + (x.httpRetries || 0), 0)}`);
console.log("\n### Failure outcomes\n");
const fails = {};
for (const r of rows.filter((x) => !x.passed)) { const k = `${r.approach} ${r.stack} ${r.task}`; (fails[k] ??= {})[r.outcome] = (fails[k][r.outcome] || 0) + 1; }
for (const [k, v] of Object.entries(fails)) console.log(`- ${k}: ${Object.entries(v).map(([o, n]) => `${o}×${n}`).join(", ")}`);
