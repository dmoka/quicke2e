// replay-or-heal: the drift answer.
//
// Measured, on the fixtures/pages rename pair (2026-09-22):
//   a spec built on accessible names does NOT survive a rename, and NO fallback chain fixes it.
//   Replaying act()'s own ladder against login.mutated.html recovered 1 of 3 locators:
//     Email    -> getByRole loose .first() hit the right field, but only because "Email" is a
//                 substring of "Email address" AND document order put the login field before the
//                 signup one. Loose without .first() is a strict-mode violation (2 matches).
//     Password -> "Passphrase" shares no substring. 0 matches on every rung.
//     Sign in  -> "Continue" shares no substring. 0 matches on every rung.
//   So a fallback chain buys one accidental rescue and, worse, .first() can silently bind the
//   WRONG control. Measured on the BASELINE page, the getByText rung hit the <label> rather than
//   the input in all three cases (data-truth=null).
//
// Therefore: do not try to make one spec survive drift. Make drift cheap to recover from.
//   1. REPLAY the generated spec. Deterministic, no model, no network, works on Linux CI.
//   2. On failure, RE-EXPLORE with the original goal (the sidecar .flow.json). The explorer is
//      the thing that can read a renamed page, which is the whole premise of the project.
//   3. If the re-explore passes, REGENERATE and print the locator diff. The diff is the review
//      artifact: a rename you meant is a spec you accept; a rename you did not mean is an
//      accessible-name regression the diff just caught.
//   4. If the re-explore also fails, the app is actually broken. Fail.
//
// HONEST LIMIT: step 2 needs the decision model. MLX is Apple-silicon only, so on a Linux CI
// runner only steps 1 and 4 exist -- CI fails loudly on drift and a developer heals on a Mac.
// That is not a workaround; it is the shape the constraint forces.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runOnce, chromium } from "../src/loop.mjs";
import { generate } from "./codegen.mjs";

function replay(specPath, { config, base }) {
  const t0 = Date.now();
  try {
    execFileSync("npx", ["playwright", "test", "--config=" + config, "--workers=1", path.basename(specPath)],
      { cwd: path.dirname(config), stdio: "pipe", env: { ...process.env, ...(base ? { APP_BASE: base } : {}) } });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    const first = out.split("\n").find((l) => /waiting for|Error:/.test(l)) || "";
    return { ok: false, ms: Date.now() - t0, detail: first.trim().slice(0, 160) };
  }
}

export async function replayOrHeal({ specPath, sidecarPath, config, base, canHeal = true }) {
  const report = { steps: [] };
  const r1 = replay(specPath, { config, base });
  report.steps.push({ phase: "replay", ...r1 });
  if (r1.ok) { report.verdict = "PASS_REPLAY"; report.totalMs = r1.ms; return report; }
  if (!canHeal) { report.verdict = "FAIL_NO_HEAL"; report.totalMs = r1.ms; return report; }

  const flow = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  const before = flow.locators || [];
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  // delete flow.base defensively: loop.mjs:245 gives it precedence over the argument, and healing
  // against the wrong origin is a silent no-op that still reports re-explore ok=true.
  delete flow.base;
  const rec = await runOnce({ flow, engine: process.env.ENGINE || "local", browser, base: base || flow.defaultBase });
  await browser.close();
  report.steps.push({ phase: "re-explore", ok: rec.passed, ms: Date.now() - t0, outcome: rec.outcome, steps: rec.steps.length });
  if (!rec.passed) {
    report.verdict = "FAIL_REAL_REGRESSION";   // the explorer could not do it either
    report.totalMs = report.steps.reduce((a, s) => a + s.ms, 0);
    return report;
  }

  const g = generate(rec, flow, {});
  fs.writeFileSync(specPath, g.code);
  fs.writeFileSync(sidecarPath, JSON.stringify(g.sidecar, null, 2));
  report.diff = diffLocators(before, g.sidecar.locators);
  const r2 = replay(specPath, { config, base });
  report.steps.push({ phase: "replay-healed", ...r2 });
  report.verdict = r2.ok ? "HEALED" : "FAIL_HEAL_DID_NOT_REPLAY";
  report.totalMs = report.steps.reduce((a, s) => a + s.ms, 0);
  return report;
}

// Pair old and new locators positionally per op+role, so "Password -> Passphrase" reads as one
// rename rather than as a delete plus an insert.
function diffLocators(before, after) {
  const out = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const b = before[i], a = after[i];
    if (!b) { out.push(`+ ${a.op} ${a.role} "${a.name}"`); continue; }
    if (!a) { out.push(`- ${b.op} ${b.role} "${b.name}"`); continue; }
    if (b.name !== a.name || b.role !== a.role || b.op !== a.op)
      out.push(`~ ${b.op} ${b.role} "${b.name}"  ->  ${a.op} ${a.role} "${a.name}"`);
  }
  return out;
}
