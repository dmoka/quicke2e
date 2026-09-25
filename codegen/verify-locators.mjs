// verifyLocators: re-walk a passed trace and MEASURE, per step, which locator strategy binds
// exactly one element at the moment that step runs.
//
// Why this is needed at all: `via` (loop.mjs:229-241) records which rung of act() resolved, and
// across every saved run in `runs/` it is "node" on 2,738 of 2,751 resolved steps (99.5%). The
// stamped node wins first, so the getByRole rungs are never exercised and the trace carries no
// evidence about the locator codegen is about to emit. Emitting exact:true on that basis is a
// guess. Codegen can afford to stop guessing: unlike the explorer, it can re-run the flow against
// the real app as often as it likes, for free, with no model in the loop.
//
// Per step it counts, in order of tightness:
//   exact  getByRole(role, { name, exact: true })
//   loose  getByRole(role, { name })                 -- >1 match here is expected, see below
//   text   getByText(name, { exact: true })
// and records the tightest that yields exactly ONE element. A step where `loose` matches several
// is flagged: .first() would bind one of them by document order, which the rename-pair
// measurement showed can be the WRONG control.
import { chromium } from "playwright";

const ARIA = { textbox: "textbox", password: "textbox", button: "button", link: "link",
  option: "option", combobox: "combobox", tab: "tab", checkbox: "checkbox", switch: "switch",
  radio: "radio", menuitem: "menuitem" };

export async function verifyLocators({ rec, flow, steps, base, browser: shared }) {
  base = (base || rec.base).replace(/\/$/, "");
  const browser = shared || await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    ...(flow.storageState ? { storageState: flow.storageState } : {}) });
  const page = await context.newPage();
  const out = [];
  try {
    await page.goto(base + (flow.start || "/"), { waitUntil: "domcontentloaded" });
    for (const s of steps) {
      const role = ARIA[s.role], name = s.label;
      const cands = [];
      if (role) cands.push([ "exact", page.getByRole(role, { name, exact: true }) ],
                           [ "loose", page.getByRole(role, { name }) ]);
      cands.push([ "text", page.getByText(name, { exact: true }).filter({ visible: true }) ]);

      const counts = {};
      for (const [k, loc] of cands) {
        // Give the page the same chance act() gives it: the step may follow a navigation.
        try { await loc.first().waitFor({ state: "attached", timeout: k === "exact" ? 3000 : 400 }); } catch {}
        try { counts[k] = await loc.count(); } catch { counts[k] = -1; }
      }
      const chosen = ["exact", "loose", "text"].find((k) => counts[k] === 1) ?? null;
      const rec1 = { n: s.n, op: s.op, label: name, role: s.role, via: s.via ?? null, counts, chosen,
        ambiguous: counts.loose > 1 };
      out.push(rec1);

      // Act with the chosen locator so the walk reaches the next step's page state.
      if (!chosen) { rec1.acted = false; break; }
      const loc = (chosen === "exact" ? page.getByRole(role, { name, exact: true })
                : chosen === "loose" ? page.getByRole(role, { name }).first()
                : page.getByText(name, { exact: true }).filter({ visible: true }).first());
      try {
        if (s.op === "TYPE_TEXT") await loc.fill(String(flow.inputs?.[s.inputKey] ?? ""), { timeout: 5000 });
        else await loc.click({ timeout: 5000 });
        rec1.acted = true;
      } catch (e) { rec1.acted = false; rec1.actError = String(e.message).split("\n")[0].slice(0, 80); break; }
      await page.waitForTimeout(250);
    }
  } finally {
    await context.close();
    if (!shared) await browser.close();
  }
  return out;
}

// Fold the measurement back into the steps so generate() emits the verified strategy.
export function applyStrategies(steps, verdicts) {
  const byN = new Map(verdicts.map((v) => [v.n, v]));
  return steps.map((s) => {
    const v = byN.get(s.n);
    return v?.chosen ? { ...s, locatorStrategy: v.chosen } : s;
  });
}
