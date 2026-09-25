import { isSecretKey, scrubText } from "../src/secret.mjs";
// codegen: a PASSED run record -> a deterministic Playwright spec.
//
// Why this exists: the decision model runs on MLX, which is Apple Silicon only, so a Linux CI
// runner cannot load it. Exploring once on a Mac and replaying a plain Playwright spec in CI is
// the only free path to a merge gate. (README, "A CI merge gate -- not yet".)
//
// Three rules, all of them load-bearing:
//   1. USER-FACING LOCATORS ONLY. getByRole / getByLabel / getByText. Never CSS, never the
//      data-jev-node stamp -- snapshot.js:105 assigns it per snapshot, so it does not exist at
//      replay time and a trace's `target` ordinal is meaningless across runs (snapshot.js:58,64).
//   2. TEXT COMES FROM THE SPEC. The trace records which inputs KEY matched (loop.mjs specKey),
//      never the value. The spec file reads process.env / INPUTS, so no credential is written
//      into a trace on disk.
//   3. THE ASSERTION IS THE TEST. expectUrl/expect/expectState map 1:1 onto real expect() calls;
//      nothing is invented and nothing is softened.

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const q = (s) => JSON.stringify(String(s));
// The snapshot's own role vocabulary -> a real ARIA role Playwright's role engine understands.
// Identical table to act() in loop.mjs:226-228, on purpose: the spec must resolve the same way
// the exploratory run did, or it is testing something else.
const ARIA = { textbox: "textbox", password: "textbox", button: "button", link: "link",
  option: "option", combobox: "combobox", tab: "tab", checkbox: "checkbox", switch: "switch",
  radio: "radio", menuitem: "menuitem" };

// ---------------------------------------------------------------- step pruning
// An exploratory trace wanders. Three classes of junk, and only ONE of them is safe to drop
// on static grounds:
//
//   DROP (mechanical, always safe):
//     - WAIT           : no target, no label. Playwright auto-waits on every locator action,
//                        so a WAIT is an artefact of the loop's snapshot cadence, not a step.
//     - stale:true     : act() threw on all four strategies, so NOTHING happened to the page.
//                        loop.mjs:317,322 pushes the step and `continue`s without acting.
//     - noSpecValue / doneRejected / retried : the same shape -- recorded, not performed.
//     - DONE / BLOCKED : meta choices, never an interaction.
//
//   KEEP UNLESS REPLAY SAYS OTHERWISE (the dangerous class):
//     - a repeated CLICK on the same {op,label} at the same url. It LOOKS redundant. Yesterday's
//       finding is that such a click was twice the stepping stone the model needed -- e.g. the
//       first click opens a portal and the second lands in it, or a debounced control needs the
//       second event. Static analysis cannot tell those apart from a double-fire.
//       So: prune by REPLAY, not by rule. `prune()` below removes one candidate at a time and
//       re-runs the generated spec; a step whose removal still passes was not load-bearing.
export function classify(steps) {
  const out = [];
  for (const s of steps) {
    let drop = null;
    if (s.op === "WAIT") drop = "WAIT: playwright auto-waits";
    else if (s.op === "DONE" || s.op === "BLOCKED") drop = `${s.op}: meta choice, no interaction`;
    else if (s.stale) drop = "stale: act() resolved nothing, the page never changed";
    else if (s.noSpecValue) drop = "noSpecValue: run aborted here, nothing typed";
    else if (!s.label) drop = "no label: nothing to build a locator from";
    else if (s.op === "TYPE_TEXT" && !s.inputKey) drop = "TYPE_TEXT with no inputKey: re-run the trace on a loop.mjs that records it";
    out.push({ step: s, drop });
  }
  // A CLICK whose {op,label,url} repeats an EARLIER kept step is only a *candidate* for pruning.
  const seen = new Set();
  for (const o of out) {
    if (o.drop) continue;
    const k = `${o.step.op}|${o.step.label}|${o.step.url}`;
    if (seen.has(k)) o.candidate = "repeat of an earlier identical step -- prune only if replay still passes";
    seen.add(k);
  }
  return out;
}

// ---------------------------------------------------------------- locators
//
// `via` records which rung of act() resolved (loop.mjs:229-241), and it is the ONLY free evidence
// about the emitted locator. Measured across every saved run in `runs/` (2,751 resolved steps):
//
//     node 2738 (99.5%)   role 12 (0.44%)   role~ 1 (0.04%)   text 0
//
// So `via` is decisive where it exists and SILENT on 99.5% of steps: the stamped node wins first,
// so the role rungs are never exercised and nothing is learned about them. Two consequences:
//   - honour it where it exists. via "role~" means getByRole(..., exact:true) PROVABLY failed at
//     action time, so emitting exact:true there emits a locator known to match nothing.
//   - it cannot be the mechanism. For the 99.5% the emitted locator is unverified, which is why
//     verifyLocators() below re-walks the flow and counts matches per step.
export const STRATEGY = { exact: "exact", loose: "loose", text: "text" };
function strategyFor(s) {
  if (s.locatorStrategy) return s.locatorStrategy;   // measured by verifyLocators(), wins
  if (s.via === "role~") return STRATEGY.loose;      // exact provably failed at action time
  if (s.via === "text") return STRATEGY.text;        // both role rungs provably failed
  return STRATEGY.exact;                             // via "node"/"role": assume, then verify
}
export function locator(s, { page = "page", inputs, weakKeys = [] } = {}) {
  const role = ARIA[s.role];
  const name = s.label;
  // SECURITY (audit): a label that echoes a secret spec value is matched by the text before it.
  // A label may already carry a placeholder (a weak-secret echo scrubbed at the source), or carry a
  // strong secret that is scrubbed here: either way, match by the text before it.
  const scrubbed = scrubText(name, inputs, { weakKeys });
  if (role && (scrubbed !== String(name ?? "") || /<[\w ]+>/.test(String(name ?? "")))) {
    const prefix = scrubbed.split(/<[^>]+>/)[0].trim();
    // Never emit an empty name (`/^/` matches every control -- audit FP1). Fail loudly instead.
    if (!prefix) throw new Error(`cannot emit a stable locator for a ${role}: its accessible name is entirely a secret or redacted value`);
    return `${page}.getByRole(${q(role)}, { name: new RegExp(${q("^" + escapeRe(prefix))}) })`;
  }
  const st = strategyFor(s);
  // getByLabel is idiomatic for a form field and matches how snapshot.js:41 found the name
  // (label[for=id]). But accName() also falls back to placeholder, aria-label and the name
  // attribute (snapshot.js:43-51), which getByLabel cannot see -- measured on login.html,
  // getByLabel("Email") returns 2 matches and violates strict mode. getByRole is what act()
  // used, so it is the primary.
  // FIX (v1, TicketBay D4): a price in the accessible name ("Pay €121.54") breaks the replay on
  // any price change. Match the stable prefix instead.
  const priced = /^(.*?\S)\s*(?:[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?[€$£]).*$/.exec(name || "");
  if (role && priced) return `${page}.getByRole(${q(role)}, { name: new RegExp(${q("^" + escapeRe(priced[1]))}) })`;
  if (role && st === STRATEGY.exact) return `${page}.getByRole(${q(role)}, { name: ${q(name)}, exact: true })`;
  // .first() is deliberate here and ONLY here: a loose name is a substring match, so >1 candidate
  // is expected. Measured on the rename pair, .first() can bind the WRONG control (login.html's
  // "Email" loosely matches both the login field and the signup form's "Work email"), so this
  // rung is emitted only when a tighter one was measured to fail.
  if (role && st === STRATEGY.loose) return `${page}.getByRole(${q(role)}, { name: ${q(name)} }).first()`;
  return `${page}.getByText(${q(name)}, { exact: true }).filter({ visible: true }).first()`;
}

function actionLine(s, inputs, weakKeys) {
  const loc = locator(s, { inputs, weakKeys });
  if (s.op === "SELECT") return `  await page.getByRole("combobox", { name: ${q(s.control)}, exact: true }).selectOption({ label: ${q(s.option)} });`;
  // audit: `INPUTS.["discount code"]` is a SyntaxError -- bracket access has no dot.
  if (s.op === "TYPE_TEXT") return `  await ${loc}.fill(${IDENT.test(s.inputKey) ? `INPUTS.${s.inputKey}` : `INPUTS[${q(s.inputKey)}]`});`;
  return `  await ${loc}.click();`;
}

// ---------------------------------------------------------------- assertions
// Every branch mirrors exactly what the loop checks, so a green spec means the same thing a
// DONE_VERIFIED meant.
function assertions(flow, waitMs) {
  const out = [];
  // MEASURED (2026-09-22): the first generated create-campaign spec went 20/21 serially and 4/6
  // under parallel workers, always failing on the terminal toHaveURL. Playwright's default expect
  // timeout is 5,000 ms; the exploratory run measured 3,251 ms between the last click and
  // DONE_VERIFIED on an idle app, so a loaded app overruns the default. The exploratory run is the
  // only honest source for this number -- it is the one thing that watched the app do the work.
  const t = waitMs ? `, { timeout: ${waitMs} }` : "";
  if (flow.expectUrl)                                   // loop.mjs:206 new RegExp(...).test(url)
    out.push(`  await expect(page).toHaveURL(new RegExp(${q(flow.expectUrl)})${t});`);
  for (const w of flow.expectSeen || [])                // transient text (a toast): poll for it
    out.push(`  await expect(page.getByText(${q(w)}).first()).toBeVisible(${t ? `{ timeout: ${waitMs} }` : ""});`);
  for (const w of flow.expect || [])                    // loop.mjs:208-212 innerText substring,
    out.push(`  await expect(page.locator("body")).toContainText(${q(w)}${t});`);  // both sides normalised
  for (const w of flow.expectState || []) {             // loop.mjs:192-202 stateOk()
    const role = ARIA[w.role] || w.role;
    const loc = `page.getByRole(${q(role)}, { name: ${q(w.name)}, exact: true })`;
    if (w.value != null) {
      // snapshot.js:56-72 selectionOf(): a native <select> reports its selected option's label
      // (readable as the element's value); a <button role=combobox> reports its rendered text.
      // `tag` on the recorded control says which. Default to text, because that is the Radix
      // case and the one the substring assertion got wrong (README 2026-09-22).
      out.push(w.tag === "select" || w.tag === "input"
        ? `  await expect(${loc}).toHaveValue(new RegExp(${q(escapeRe(w.value))}));`
        : `  await expect(${loc}).toContainText(${q(w.value)});`);
    }
    if (w.checked != null)  out.push(`  await expect(${loc})${w.checked ? "" : ".not"}.toBeChecked();`);
    if (w.selected != null) out.push(`  await expect(${loc}).toHaveAttribute("aria-selected", ${q(String(w.selected))});`);
    if (w.expanded != null) out.push(`  await expect(${loc}).toHaveAttribute("aria-expanded", ${q(String(w.expanded))});`);
  }
  if (!out.length) out.push(`  // NO ASSERTION IN THE FLOW SPEC -- this spec proves nothing. README finding #4.`);
  return out;
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- the writer
export function generate(rec, flow, { title = flow.name, dropCandidates = [] } = {}) {
  if (!rec.passed) throw new Error(`refusing to generate from a run that did not pass (outcome=${rec.outcome})`);
  const classified = classify(rec.steps);
  const kept = [], dropped = [];
  for (const [i, c] of classified.entries()) {
    if (c.drop) { dropped.push({ n: c.step.n, op: c.step.op, label: c.step.label, why: c.drop }); continue; }
    if (dropCandidates.includes(c.step.n)) { dropped.push({ n: c.step.n, op: c.step.op, label: c.step.label, why: "pruned by replay: removing it still passed" }); continue; }
    kept.push(c);
  }

  const lines = [];
  lines.push(`// GENERATED from a passed exploratory run -- do not hand-edit; regenerate.`);
  lines.push(`// flow: ${flow.name}   engine: ${rec.engine}   outcome: ${rec.outcome}   ${rec.steps.length} steps in ${rec.wallMs} ms`);
  lines.push(`// Every locator below is an ACCESSIBLE NAME. A rename in the app breaks this spec --`);
  lines.push(`// that is the intended signal, not a defect. See replay-or-heal.mjs.`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(``);
  lines.push(`const BASE = process.env.APP_BASE ?? ${q(rec.base)};`);
  if (Object.keys(flow.inputs || {}).some(isSecretKey))
    lines.push(`const missing = (v) => { throw new Error(\`set \${v}: secret spec values are read from the environment only\`); };`);
  lines.push(`const INPUTS = {`);
  for (const [k, v] of Object.entries(flow.inputs || {}))
    // SECURITY (audit): a secret-looking key gets NO literal default -- the spec reads it from the
    // environment only, so a credential is never written into a generated file.
    lines.push(isSecretKey(k)
      ? `  ${IDENT.test(k) ? k : q(k)}: process.env.${envName(flow.name, k)} ?? missing(${q(envName(flow.name, k))}),`
      : `  ${IDENT.test(k) ? k : q(k)}: process.env.${envName(flow.name, k)} ?? ${q(v)},`);
  lines.push(`};`);
  lines.push(``);
  lines.push(`test(${q(title)}, async ({ page }) => {`);
  lines.push(`  await page.goto(BASE + ${q(flow.start || "/")});`);
  // MAP (v1): the run was routed to its target page before the step loop. Replay the same walk.
  for (const h of rec.route?.hops || []) {
    if (h.goto) lines.push(`  await page.goto(BASE + ${q(new URL(h.goto).pathname + new URL(h.goto).search)});`);
    else if (h.ok) lines.push(`  await page.getByRole(${q(h.role)}, { name: ${q(h.label)}, exact: true }).first().click();`);
  }

  let lastUrl = null;
  for (const c of kept) {
    const s = c.step;
    // A url change between two kept steps is a navigation the exploratory run observed. Asserting
    // it turns a silent wrong-page click into a named failure at the step that caused it.
    if (lastUrl !== null && s.url !== lastUrl)
      lines.push(`  await expect(page).toHaveURL(new RegExp(${q(escapeRe(new URL(s.url).pathname))}));`);
    lastUrl = s.url;
    if (c.candidate) lines.push(`  // kept: ${c.candidate}`);
    lines.push(actionLine(s, flow.inputs, rec.weakEchoed || []));
  }
  lines.push(``);
  lines.push(`  // ---- the assertion. This, not the steps, is the test.`);
  // Size the terminal wait from what the exploratory run MEASURED between its last action and
  // DONE_VERIFIED, x3 for headroom, floored at Playwright's own default so we never shorten it.
  const lastActed = [...rec.steps].reverse().find((s) => s.wallAt != null);
  const leg = lastActed ? Math.max(0, (rec.tLoopEnd ?? rec.wallMs) - lastActed.wallAt) : 0;
  for (const a of assertions(flow, Math.max(5000, Math.round(leg * 3 / 500) * 500))) lines.push(a);
  lines.push(`});`);
  lines.push(``);
  // The sidecar: everything needed to RE-EXPLORE this flow when the spec breaks. The spec is
  // derived; this is the source. Keep them next to each other in the repo.
  // NB `defaultBase`, NOT `base`. loop.mjs:245 resolves `flow.base || base || $APP_BASE`, so a
  // `base` key on the flow object OUTRANKS the explicit argument -- which silently sent the heal
  // re-exploration back to the page the spec was generated from. Measured: the heal loop reported
  // re-explore ok=true and then emitted a byte-identical spec that failed again.
  const sidecar = { name: flow.name, start: flow.start, defaultBase: rec.base, maxSteps: flow.maxSteps,
    inputs: flow.inputs, goal: flow.goal, done: flow.done,
    expectUrl: flow.expectUrl, expect: flow.expect, expectState: flow.expectState,
    generatedFrom: { engine: rec.engine, outcome: rec.outcome, wallMs: rec.wallMs, steps: rec.steps.length },
    locators: kept.map((c) => ({ n: c.step.n, op: c.step.op, role: c.step.role, name: c.step.label })) };
  return { code: lines.join("\n"), sidecar, kept: kept.map((c) => c.step.n), dropped, classified,
    measuredLegMs: leg };
}
const envName = (flow, k) =>
  (flow + "_" + k).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
