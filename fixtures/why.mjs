// Why did a fixture not reproduce? Dumps the assertion state and the full option set per step.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startStatic } from "./serve.mjs";
import { startProxy } from "./proxy.mjs";
import { FIXTURES } from "./flows.mjs";
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const checkout = path.resolve((arg("checkout", "./checkouts/asof") || "").replace(/^~/, process.env.HOME));
const s = await startStatic(8907);
const px = await startProxy({ port: 8827 });
process.env.LOCAL_URL = px.url;
const { runOnce, chromium } = await import(pathToFileURL(path.join(checkout, "src", "loop.mjs")).href);
const b = await chromium.launch({ headless: true });

// (b) does the ZWSP decoy actually satisfy checkGoal on the start page?
{
  const p = await (await b.newContext()).newPage();
  await p.goto(s.base + "/aria-label.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(300);
  const r = await p.evaluate((want) => {
    const norm = (t) => String(t == null ? "" : t).replace(/[​­]/g, "").replace(/\s+/g, " ").trim();
    const raw = document.body.innerText;
    const hint = document.querySelector(".hint");
    return { rawHasZwsp: /​/.test(raw), hintTextHasZwsp: /​/.test(hint.textContent),
      normHit: norm(raw).includes(norm(want)),
      rawHit: raw.includes(want),
      around: norm(raw).slice(Math.max(0, norm(raw).indexOf("Example")), norm(raw).indexOf("Example") + 90) };
  }, "Access code accepted: ABC123");
  console.log("ZWSP decoy on start page:", r);
}

// (a) full per-step option sets for a named fixture
const id = arg("fixture", "modal-long-list");
const fx = FIXTURES.find((f) => f.id === id);
s.reset(); px.reset();
const rec = await runOnce({ flow: fx.flow, engine: "local", budget: 30, browser: b, base: s.base });
console.log(`\n${id}: ${rec.outcome} passed=${rec.passed} url=${rec.finalUrl}`);
for (const [i, c] of px.calls().entries()) {
  const st = rec.steps[i] || {};
  console.log(`  step ${i + 1} ${String(c.url)} -> ${c.choice} (${String(c.confidence).slice(0, 4)}) op=${st.op} label=${st.label}`);
  console.log(`    ${c.criteria.length} opts: ${c.criteria.map((k) => (c.criteriaText[k] || k).slice(0, 34)).join(" | ").slice(0, 400)}`);
}
console.log("truth:", JSON.stringify(s.truth().map((e) => e.type + ":" + e.truth)));
await b.close(); await s.close(); await px.close();
