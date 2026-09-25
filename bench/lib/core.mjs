// Parametrised copy of src/loop.mjs runOnce() for the bake-off. src/ is NOT edited.
// What is identical to src/loop.mjs: keyFor/hasSpec, compact() ranking + LETTER_CEILING trim,
// decide() wire shape, settle(), READY, checkGoal(), the step loop, DONE/BLOCKED handling, waits.
// What is parametrised: the snapshot (approach.snapshot) and the locator resolution (approach.act).
// What is added, and ONLY active when approach.selectFix is true: native <select> options become
// one SELECT criterion each, and SELECT gets a dispatch branch (src/ has none: fixtures/README).
// Also added for every approach, A included: retry on HTTP 429/5xx in decide(), so a rate limit
// is never scored as a representation failure.
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.OPENROUTER_API_KEY;
const LOCAL_URL = process.env.LOCAL_URL || "http://127.0.0.1:8822";
const RULES = "Choose the one operation that advances the goal from this page. " +
  "Do not repeat a step that is already satisfied. Fill required fields before submitting.";

export const httpStats = { retries: 0, calls: 0 };
async function post(url, body, auth) {
  for (let a = 0; ; a++) {
    httpStats.calls++;
    const res = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(body) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return res.json();
    const txt = (await res.text()).slice(0, 160);
    if (a < 5 && (res.status === 0 || res.status === 429 || res.status >= 500)) {
      httpStats.retries++; await new Promise((r) => setTimeout(r, 500 * 2 ** a)); continue;
    }
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
}

// ---- identical to src/loop.mjs ----
const PRIORITY = { textbox: 0, password: 0, combobox: 0, button: 1, tab: 1, checkbox: 1, switch: 1, radio: 1 };
const ROLE_KEY = { password: "password" };
function keyFor(label, inputs, role) {
  const l = (label || "").toLowerCase();
  for (const k of Object.keys(inputs || {})) if (l.includes(k.toLowerCase())) return k;
  const rk = ROLE_KEY[role];
  if (rk && inputs && rk in inputs) return rk;
  return null;
}
const hasSpec = (label, inputs, role) => keyFor(label, inputs, role) !== null;
export const LETTER_CEILING = 52;

const firstIdx = (snap, a) => snap.actions.indexOf(a);
const tok = (t) => String(t || "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((w) => w.length > 1);
export function compact(snap, budget, filled = new Set(), inputs = null, reserve = 3, selectFix = false, goalKeep = null) {
  const els = [], idx = {}, targets = {};
  const ops = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };
  const raw = [];
  for (const a of snap.actions) {
    const op = ops[a.kind]; if (!op) continue;
    if (op === "TYPE_TEXT" && filled.has(a.node)) continue;
    if (op === "TYPE_TEXT" && !hasSpec(a.label, inputs, a.role)) continue;
    if (op === "CLICK" && (a.role === "textbox" || a.role === "password")) continue;
    // selectFix: one criterion per real option. The placeholder (empty value) and the option that
    // is already selected are removed, not instructed against (README finding #2).
    if (op === "SELECT" && selectFix && (a.value === "" || a.value === a.current_value)) continue;
    if (!(a.node in idx)) { idx[a.node] = raw.length; raw.push({ a, ops: [] }); }
    if (!raw[idx[a.node]].ops.includes(op)) raw[idx[a.node]].ops.push(op);
  }
  // goalKeep (G): a candidate whose label tokens ALL occur in the goal is ranked -1, so the budget
  // cut and the letter-ceiling trim can never drop it. Deterministic, no model. It changes nothing
  // on a page where nothing is dropped. Motivation: T3's target (row 57 of 60) is dropped at
  // budget 30 by every representation -- the representation is not what loses it.
  const goalToks = goalKeep ? new Set(tok(goalKeep)) : null;
  const named = (a) => { const t = tok(a.label); return t.length > 0 && t.every((w) => goalToks.has(w)); };
  const ranked = raw.map((r, i) => ({ ...r, i, rank: goalToks && named(r.a) ? -1 : PRIORITY[r.a.role] ?? 2 }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i);
  let keep = budget ? ranked.slice(0, budget) : ranked;
  const critCount = (k) => k.reduce((n, r) => n + r.ops.length, 0);
  let lettersLost = 0;
  while (keep.length && critCount(keep) + reserve > LETTER_CEILING) { keep.pop(); lettersLost++; }
  keep.sort((x, y) => x.i - y.i);
  const criteria = {};
  // selectFix, part 2 -- STATE. Removing the chosen option (above) also removed the only evidence
  // that it was chosen: measured on vanilla T2, SELECT Enterprise@0.99 then BLOCKED 4/4 at 0.54-0.64.
  // So a <select>'s current value is shown as a non-choosable element {r:"combobox", l, v}, and a
  // checkbox/radio shows v:"checked"/"unchecked" instead of its value attribute ("on", always).
  const selState = selectFix ? snap.actions.filter((a) => a.kind === "state" && a.value && !/^(choose|select|--)/i.test(a.value)) : [];
  let stateAt = 0;
  for (const { a, ops: o } of keep) {
    while (stateAt < selState.length && firstIdx(snap, selState[stateAt]) < firstIdx(snap, a)) {
      const st = selState[stateAt++]; els.push({ i: "s" + stateAt, r: "combobox", l: (st.label || "").slice(0, 44), v: String(st.value).slice(0, 24) });
    }
    const n = String(els.filter((e) => !String(e.i).startsWith("s")).length + 1);
    const label = (a.label || "").slice(0, 44);
    const v = selectFix && (a.role === "checkbox" || a.role === "radio") ? (a.checked ? "checked" : "unchecked") : a.value;
    els.push({ i: n, r: a.role, l: label, ...(a.popup ? { p: 1 } : {}), ...(v && !a.secret ? { v: String(v).slice(0, 24) } : {}) });
    for (const op of o) { (targets[op] ??= {})[n] = a; criteria[`${op}:${n}`] = `${op} ${n} ${label} [${a.role}]`; }
  }
  return { els, criteria, targets, dropped: ranked.length - keep.length, lettersTrimmed: lettersLost, total: ranked.length };
}

async function decide({ els, criteria }, snap, goal, history, engine) {
  const state = { url: new URL(snap.url).pathname, title: snap.title.slice(0, 60), elements: els, done: history.slice(-5) };
  const questions = { action: { type: "choice", criteria, instructions: { goal, rules: RULES } } };
  const t0 = performance.now();
  if (engine === "jev") {
    const r = await post("https://openrouter.ai/api/alpha/decisions", { model: "typesafe/jev-1.13", state, questions }, true);
    return { state, questions, choice: r.answers.action.choice, confidence: r.answers.action.confidence,
      probabilities: r.answers.action.probabilities, ms: performance.now() - t0,
      tokens: r.usage?.input_tokens || 0, cost: r.usage?.cost || 0, truncated: false };
  }
  const r = await post(LOCAL_URL, { state, questions }, false);
  if (r.error) throw new Error(engine + ": " + r.error);
  return { state, questions, choice: r.answers.action.choice, confidence: r.answers.action.confidence,
    probabilities: r.answers.action.probabilities, ms: performance.now() - t0, tokens: r.usage?.input_tokens || 0,
    cost: 0, truncated: r.timing?.truncated };
}

const specValue = (flow, a) => { const k = keyFor(a.label, flow.inputs, a.role); return k === null ? null : flow.inputs[k]; };
export const norm = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();
const READY = () => document.querySelectorAll("input:not([type=hidden]),button,a[href]").length > 2;

async function settle(page, quietMs = 150, timeout = 1200) {
  await page.evaluate(([quiet, cap]) => new Promise((resolve) => {
    let t = setTimeout(done, quiet);
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const hard = setTimeout(done, cap);
    function done() { clearTimeout(t); clearTimeout(hard); obs.disconnect();
      const anims = document.getAnimations ? document.getAnimations() : [];
      if (!anims.length) return resolve();
      Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 400))]).then(resolve, resolve); }
  }), [quietMs, timeout]).catch(() => {});
}

function stateOk(snap, want) {
  return (want || []).every((w) => (snap?.actions || []).some((a) => {
    if (w.role && a.role !== w.role) return false;
    if (w.name != null && norm(a.label) !== norm(w.name)) return false;
    if (w.value != null && !norm(a.value).includes(norm(w.value))) return false;
    if (w.selected != null && a.selected !== w.selected) return false;
    if (w.checked != null && a.checked !== w.checked) return false;
    if (w.expanded != null && a.expanded !== w.expanded) return false;
    return true;
  }));
}

async function checkGoal(page, flow, snap, approach) {
  try {
    const urlOk = flow.expectUrl ? new RegExp(flow.expectUrl).test(page.url()) : true;
    if (!urlOk) return false;
    const domOk = await page.evaluate(({ words, src }) => {
      const n = eval("(" + src + ")");
      const t = n((document.body && document.body.innerText) || "");
      return words.every((x) => t.includes(n(x)));
    }, { words: flow.expect || [], src: norm.toString() });
    if (!domOk) return false;
    if (!flow.expectState?.length) return true;
    return stateOk(snap ?? await approach.snapshot(page), flow.expectState);
  } catch { return false; }
}

// ---- the loop: src/loop.mjs runOnce with snapshot/act injected ----
export async function runFlow({ flow, approach, engine = "jev", budget = 30, browser, base, onDecide }) {
  base = (flow.base || base).replace(/\/$/, "");
  const t0 = performance.now();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const steps = [], history = [], snapMs = [];
  let outcome = "UNKNOWN", error = null, doneRejects = 0, blocked = 0;
  const filled = new Set();
  let decideMs = 0, cost = 0;
  const sel = !!approach.selectFix;
  try {
    await page.goto(base + (flow.start || "/"), { waitUntil: "domcontentloaded" });
    for (let i = 0; i < (flow.maxSteps || 14); i++) {
      let snap;
      await settle(page);
      const ts = performance.now();
      try { snap = await approach.snapshot(page); }
      catch { await page.waitForTimeout(150); snap = await approach.snapshot(page); }
      snapMs.push(performance.now() - ts);
      if (i > 0 && await checkGoal(page, flow, snap, approach)) { outcome = "DONE_VERIFIED"; break; }

      const space = compact(snap, budget, filled, flow.inputs, 3, sel, approach.goalKeep ? flow.goal : null);
      const listboxOpen = space.els.some((e) => e.p === 1);
      if (!listboxOpen) {
        space.criteria.WAIT = "wait for the page";
        space.criteria.DONE = flow.done;
        space.criteria.BLOCKED = "nothing can progress";
      }
      const d = await decide(space, snap, flow.goal, history, engine);
      decideMs += d.ms; cost += d.cost;
      onDecide?.({ url: d.state.url, elements: d.state.elements, criteria: Object.keys(space.criteria),
        criteriaText: space.criteria, choice: d.choice, confidence: d.confidence, truncated: d.truncated,
        seen: d.probabilities ? Object.keys(d.probabilities).length : null });

      let op = d.choice, tIdx = null, action = null;
      if (!["WAIT", "DONE", "BLOCKED"].includes(op)) {
        const [o, ix] = String(d.choice).split(":");
        op = o; tIdx = ix; action = space.targets[o]?.[ix];
        if (!action) op = "BLOCKED";
      }
      const step = { n: i + 1, url: snap.url, op, target: tIdx, label: action?.label ?? null, role: action?.role ?? null,
        confidence: d.confidence, ms: Math.round(d.ms), snapMs: Math.round(snapMs.at(-1) * 10) / 10,
        options: Object.keys(space.criteria).length, total: space.total, dropped: space.dropped };

      if (op === "DONE") {
        await page.waitForFunction(READY, null, { timeout: 2000, polling: 50 }).catch(() => {});
        if (await checkGoal(page, flow, null, approach)) { steps.push(step); outcome = "DONE_VERIFIED"; break; }
        if (doneRejects < 3) { doneRejects++; step.doneRejected = true; steps.push(step); await page.waitForTimeout(200); continue; }
        steps.push(step); outcome = "DONE_REJECTED"; break;
      }
      if (op === "BLOCKED") {
        if (blocked < 3) { blocked++; step.retried = true; steps.push(step);
          await page.waitForFunction(READY, null, { timeout: 2500, polling: 50 }).catch(() => {}); continue; }
        steps.push(step); outcome = "MODEL_BLOCKED"; break;
      }
      const before = page.url();
      if (op === "TYPE_TEXT") {
        const v = specValue(flow, action);
        if (v === null) { step.noSpecValue = true; steps.push(step); outcome = "NO_SPEC_VALUE"; break; }
        try { step.via = await approach.act(page, action, (loc, t) => loc.fill(v, { timeout: t })); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        filled.add(action.node);
        history.push(`typed ${action.label}`);
      } else if (op === "CLICK") {
        try { step.via = await approach.act(page, action, (loc, t) => loc.click({ timeout: t })); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        if (action.role === "link") await page.waitForURL((u) => u.toString() !== before, { timeout: 1200 }).catch(() => {});
        history.push(`clicked ${action.label}`);
      } else if (op === "SELECT" && sel) {
        const target = { ...action, node: action.selectNode, role: "combobox", label: action.selectLabel, kind: "select" };
        try { step.via = await approach.act(page, target, (loc, t) => loc.selectOption({ label: action.optionLabel }, { timeout: t })); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        history.push(`selected ${action.label}`);
      } else {
        await Promise.race([
          page.waitForURL((u) => u.toString() !== before, { timeout: 2500 }),
          page.waitForFunction(READY, null, { timeout: 2500, polling: 50 }),
        ]).catch(() => {});
        history.push("waited");
      }
      if (op !== "TYPE_TEXT") await page.waitForFunction(READY, null, { timeout: 4000, polling: 50 }).catch(() => {});
      step.wallAt = Math.round(performance.now() - t0);
      steps.push(step);
    }
    if (outcome === "UNKNOWN") outcome = "MAX_STEPS";
  } catch (e) { error = String(e.message || e).slice(0, 180); outcome = "ERROR"; }
  const passed = await checkGoal(page, flow, null, approach);
  const finalUrl = page.url();
  await context.close();
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  return { flow: flow.name, approach: approach.name, engine, budget, outcome, passed, finalUrl, error, steps,
    decideMs: Math.round(decideMs), cost, doneRejects, wallMs: Math.round(performance.now() - t0),
    snapMsMedian: Math.round(med(snapMs) * 10) / 10, snapMsAll: snapMs.map((x) => Math.round(x * 10) / 10) };
}

// ---- shared act helpers ----
export const ARIA = { textbox: "textbox", password: "textbox", button: "button", link: "link", option: "option",
  combobox: "combobox", tab: "tab", checkbox: "checkbox", switch: "switch", radio: "radio", menuitem: "menuitem" };
// src/loop.mjs act(), frame-unaware: the baseline resolution chain.
export async function actA(page, action, fn) {
  const byNode = page.locator(`[data-jev-node="${action.node}"]`);
  try { await fn(byNode, 1200); return "node"; } catch {}
  return roleFallback(page, action, fn);
}
export async function roleFallback(scope, action, fn) {
  const role = ARIA[action.role], name = (action.label || "").trim();
  if (role && name) {
    try { await fn(scope.getByRole(role, { name, exact: true }).first(), 1500); return "role"; } catch {}
    try { await fn(scope.getByRole(role, { name }).first(), 1200); return "role~"; } catch {}
  }
  if (name) { try { await fn(scope.getByText(name, { exact: true }).filter({ visible: true }).first(), 1200); return "text"; } catch {} }
  throw new Error("unresolvable");
}
// A checkbox whose real <input> is not actionable (opacity 0 / 0x0 / pointer-events:none: MUI
// is fine, Element Plus and Shoelace are not) is operated through its <label>, as a user would.
export async function viaLabel(frame, loc, fn) {
  const tok = "p" + Math.random().toString(36).slice(2, 9);
  const ok = await loc.evaluate((el, t) => {
    const root = el.getRootNode();
    const lab = el.closest("label") || (el.id && root.querySelector?.(`label[for="${CSS.escape(el.id)}"]`));
    if (!lab) return false; lab.setAttribute("data-jev-proxy", t); return true;
  }, tok, { timeout: 800 });
  if (!ok) throw new Error("no label");
  await fn(frame.locator(`[data-jev-proxy="${tok}"]`), 1200);
  return "label";
}
