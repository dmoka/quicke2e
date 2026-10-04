// The run loop. A decision model picks each step; nothing in the loop generates text.
//   decisions  -> the engine: jev (hosted, OpenRouter), vercel (Jev via the Vercel AI Gateway) or local
//   text input -> from the test spec
//   "am I done?" -> deterministic assertion
import { chromium } from "playwright";
import { buildRedactor, redactSnapshot } from "./redact.mjs";
import { SECRET_SRC, scrub, scrubText, scrubSpecText, isSecretKey, isStrong, redactPatterns } from "./secret.mjs";
import { pattern as urlPattern } from "./discover-pattern.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SEEN_TEXT = fs.readFileSync(path.join(__dir, "seen-text.js"), "utf8").replace(/^\/\/.*\n/gm, "").trim();
const SNAPSHOT = fs.readFileSync(path.join(__dir, "snapshot.js"), "utf8").replaceAll("__SECRET_SRC__", SECRET_SRC.replace(/\\/g, "\\\\"));
const KEY = process.env.OPENROUTER_API_KEY;
const LOCAL_URL = process.env.LOCAL_URL || "http://127.0.0.1:8822";
// FIX (2026-09-21): was hardcoded to the reference app. A client could not point this at their own app
// without editing the source. Resolution order: flow.base -> runOnce({base}) -> $APP_BASE -> default.
const DEFAULT_BASE = process.env.APP_BASE || "http://localhost:3000";

const RULES = "Choose the one operation that advances the goal from this page. " +
  "Do not repeat a step that is already satisfied. Fill required fields before submitting.";

// Retry 429 and 5xx with backoff (roadmap #1; the bake-off lost 1 of 120 runs to an HTTP 520).
async function post(url, body, auth, tries = 4) {
  for (let k = 0; ; k++) {
    const res = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(body) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return res.json();
    if (k + 1 < tries && (res.status === 0 || res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** k)); continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  }
}

// ---- compression: the 1,024-token budget is the whole constraint ----
// FIX (2026-09-21): option/menuitem/link were absent and fell to the ?? 2 default, BELOW every
// button. Measured consequences: a 62-link list page offered 0 of its links (52 row checkboxes +
// 58 buttons ate the budget first); an OrangeHRM listbox had 7 options in the snapshot and 0
// survived, which silently disabled the open-listbox rule entirely; an Ant Pro nav flow scored
// 0/3 at budget 30 and 3/3 at 60. Options in an OPEN listbox are the only legal move, so they
// rank first; links are how you navigate, so they rank with buttons rather than below them.
const PRIORITY = { textbox: 0, password: 0, combobox: 0, button: 1, tab: 1, checkbox: 1, switch: 1, radio: 1 };
// REVERTED 2026-09-21. Adding option/menuitem at 0 and link at 1 FIXED link starvation
// (the 62-link list page went from 0 links offered to 13) and BROKE create-campaign 5/5 -> 0/5:
// with links promoted, the loop spent its budget cycling the five optional "rule" comboboxes and
// never reached Create campaign. Ranking is a real tension between list pages and forms, and it
// needs a measured fix, not a guess. Tracked separately; do not re-apply this naively.
// FIX (2026-09-21): `inputs` is now passed in so TYPE_TEXT can be suppressed on any field
// the test spec has no value for. Text comes from the spec by design, so a field with no
// spec value is not part of this test -- offering it produced a hard NO_SPEC_VALUE failure
// on the Budget field. Remove the option rather than handle the error. (README finding #2.)
// FIX (2026-09-22, found by codegen's drift test): matching the spec key against the LABEL is
// exactly what a rename breaks -- which makes it the one place the project cannot afford it.
// Measured on fixtures/pages/login.mutated.html, 3/3 trials on the PRISTINE repo: "Password" ->
// "Passphrase" makes hasSpec false, TYPE_TEXT is suppressed, the model CLICKS the password field
// instead, and the run ends MAX_STEPS on /login-denied.html. The README's flagship claim ("This
// loop: 5/5 on the rename, scripted Playwright 0/3") does not reproduce on the repo's own rename
// fixture. A password field is identified by its ROLE, which a rename cannot touch.
const ROLE_KEY = { password: "password" };
function keyFor(label, inputs, role) {
  const l = (label || "").toLowerCase();
  // Best match, not first match (audit A3: "Username" took the "name" key meant for "Full name"):
  // exact label > whole-word match > substring; ties go to the longer key.
  let best = null, bestScore = 0;
  for (const k of Object.keys(inputs || {})) {
    const kl = k.toLowerCase();
    if (!l.includes(kl)) continue;
    const word = new RegExp(`(^|[^a-z0-9])${kl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(l);
    const score = (l === kl ? 3000 : word ? 2000 : 1000) + kl.length;
    if (score > bestScore) { best = k; bestScore = score; }
  }
  if (best) return best;
  const rk = ROLE_KEY[role];
  if (rk && inputs && rk in inputs) return rk;
  return null;
}
function hasSpec(label, inputs, role) { return keyFor(label, inputs, role) !== null; }
// SECURITY (v1 audit A7): a secret is not only a type=password field. An API key, token, PIN or card
// field is a plain textbox. Its value never goes to the model, and neither do secret spec values in
// the goal string (the audit found "Demo-Pass-42!" inside goals).
function redactGoal(goal, inputs, keepWeak = []) { return scrubSpecText(String(goal || ""), inputs, { keepWeak }); }
// The engine maps each option to ONE LETTER and reads only those logits: server.py:18 has 52
// letters, :127-128 does keys[:52] and reports the loss ONLY as timing.truncated -- which this
// file counted and never read. Criteria are emitted in document order with WAIT/DONE/BLOCKED
// appended LAST, so anything past the 52nd is discarded silently AND the escape hatches are the
// first casualties. This is reachable at the DEFAULT budget: 30 elements can emit 60 criteria
// (CLICK + TYPE_TEXT each) + 3 meta = 63. Measured by the adversary harness: at budget 250 the
// target link WAS in the criteria and the model was never shown it.
const LETTER_CEILING = 52;
const fillKey = (url, a) => `${new URL(url).pathname}|${a.role}|${a.label}`;
// BAKEOFF 2026-09-24 (docs/bakeoff-2026-09-24.md): goal-anchored keep. A candidate whose label
// tokens ALL occur in the goal is ranked -1, so neither the budget cut nor the letter-ceiling trim
// can drop it. Deep-row T3 went 0/40 -> 40/40 across 8 stacks with no representation change.
const tok = (t) => String(t || "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((w) => w.length > 1);
function compact(snap, budget, filled = new Set(), inputs = null, reserve = 3,
                 keyOf = (label, role) => keyFor(label, inputs, role), goal = null, typedKeys = new Map()) {
  let els = [], targets = {}, criteria = {};
  const idx = {};
  const ops = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" };
  const raw = [];
  for (const a of snap.actions) {
    const op = ops[a.kind]; if (!op) continue;
    // FIX (v1): native <select>. Each OPTION is its own action, keyed by option -- keying by node
    // kept only the placeholder, and SELECT had no dispatch branch, so fixtures/select.html burned
    // all 10 steps in 64 s. The value comes from the spec when the spec names this control (text
    // comes from the spec, never from the model); otherwise a few real options are offered.
    // Option actions carry selectNode/selectLabel/optionLabel (snapshot.js, A+).
    if (op === "SELECT") {
      if (!a.value || a.value === a.current_value) continue;          // placeholder, or already set
      const k = keyOf(a.selectLabel, "combobox");
      if (k !== null) { const want = norm(inputs[k]).toLowerCase();
        if (norm(a.optionLabel).toLowerCase() !== want && norm(a.value).toLowerCase() !== want) continue; }
      else if (raw.filter((r) => r.a.selectNode === a.selectNode).length >= 8) continue;
      raw.push({ a: { ...a, label: `${a.optionLabel} in ${a.selectLabel}` }, ops: [op] });
      continue;
    }
    // FIX (v1): keyed by page + role + label, not the per-snapshot ordinal. `n0` on page 2 is a
    // different field from `n0` on page 1 (fixtures/ordinal-a/b.html: page 2's only field vanished).
    if (op === "TYPE_TEXT") {
      const k = keyOf(a.label, a.role);
      if (k === null) continue;                          // no spec value: not this test's field
      // One spec key fills ONE field per page (audit B1 / fixtures/ambiguous.html): once "name" went
      // into one of First/Middle/Last name, the other two are not this key's fields. A re-fill of
      // the SAME field after a reload (TicketBay D1) is still allowed.
      const used = typedKeys.get(`${new URL(snap.url).pathname}|${k}`);
      if (used && used !== a.label) continue;
      // FIX (v1, TicketBay D1): "filled" is read off the DOM, not remembered. A field that already
      // holds its spec value is done; a field we typed into that is EMPTY again (the form reloaded,
      // e.g. an Apply-code GET submit) is offered again. Remembered-and-non-empty stays suppressed,
      // so a masked field (phone formatting) cannot loop.
      if (norm(a.value) === norm(inputs[k])) continue;
      if (filled.has(fillKey(snap.url, a)) && norm(a.value)) continue;
    }
    // FIX (2026-09-21): never offer CLICK on a plain textbox. Text is entered via TYPE_TEXT from
    // the spec, so clicking one is always a wasted step -- measured: 5 of 22 steps burned clicking
    // Budget/Campaign name, exhausting the budget before Save. Comboboxes keep CLICK (they open).
    // FIX (2026-09-22): "password" was missing. snapshot.js:87 gives a password input role
    // "password", not "textbox", so this guard never covered it -- and on the rename fixture the
    // model duly clicked the password field, three trials out of three.
    if (op === "CLICK" && (a.role === "textbox" || a.role === "password")) continue;
    if (!(a.node in idx)) { idx[a.node] = raw.length; raw.push({ a, ops: [] }); }
    if (!raw[idx[a.node]].ops.includes(op)) raw[idx[a.node]].ops.push(op);
  }
  // FIX (v1): hold back a form's SUBMIT while a field the spec names in that form is still unset.
  // Measured on fixtures/select.html: the model typed Team, then chose "Save subscription" (0.61)
  // over "SELECT Growth" and saved an empty plan -- finding #2 again. Remove the option.
  // A select is pending only while the CONTROL is unset (bake-off re-run: counting every remaining
  // option kept "Create project" hidden forever after Enterprise was chosen -- 0/5 on two stacks).
  const pending = new Set(raw.filter((r) => r.a.form >= 0 && (r.ops.includes("TYPE_TEXT")
    || (r.ops.includes("SELECT") && (!r.a.current_value || keyOf(r.a.selectLabel, "combobox") !== null))))
    .map((r) => r.a.form));
  for (let j = raw.length - 1; j >= 0; j--)
    if (raw[j].a.submit && pending.has(raw[j].a.form)) raw.splice(j, 1);
  // Rank: form controls and buttons first, then links in document order. Links are the
  // repetitive part of a list page (55 creator rows) and the first to be dropped.
  const goalToks = goal ? new Set(tok(goal)) : null;
  const named = (a) => { const t = tok(a.label); return t.length > 0 && t.every((w) => goalToks.has(w)); };
  const ranked = raw.map((r, i) => ({ ...r, i, rank: goalToks && named(r.a) ? -1 : PRIORITY[r.a.role] ?? 2 }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i);
  let keep = budget ? ranked.slice(0, budget) : ranked;
  // Trim from the LOWEST-RANKED end until every criterion fits under the letter ceiling with room
  // for the meta options. Dropping here is visible (space.dropped); dropping in the engine is not.
  const critCount = (k) => k.reduce((n, r) => n + r.ops.length, 0);
  let lettersLost = 0;
  while (keep.length && critCount(keep) + reserve > LETTER_CEILING) { keep.pop(); lettersLost++; }
  keep.sort((x, y) => x.i - y.i);

  // BAKEOFF: removing the chosen option also removed the evidence it was chosen (SELECT@0.99 then
  // BLOCKED 4/4). A <select>'s value is shown as a non-choosable element, and a checkbox shows
  // checked/unchecked instead of its value attribute ("on", always).
  // v1: measured on fixtures/select.html -- the state as a non-choosable ELEMENT made Jev answer
  // BLOCKED (0.37) with Save as the only real option; the same facts as a separate `values` map
  // gave CLICK Save at 0.99. So form state goes in `values`, and `elements` holds only choices.
  const values = {};
  for (const a of snap.actions) {
    if (a.kind === "state" && a.value && !/^(choose|select|pick|--)/i.test(a.value)) values[a.label] = String(a.value).slice(0, 40);
    // A text field's CONTENT is sent only when it is exactly a NON-secret spec value (text the spec
    // supplied); anything else -- a pre-filled page value, a secret key's value -- is "(filled)".
    // Measured: with "(filled)" everywhere, Jev typed WELCOME10 and paid without clicking Apply
    // (TicketBay book-with-code 5/5 -> 0/5); seeing "Discount code: WELCOME10" it applies it.
    if (a.kind === "fill" && norm(a.value)) {
      const k = keyOf(a.label, a.role);
      values[a.label] = k !== null && !a.secret && !isSecretKey(k) && norm(a.value) === norm(inputs?.[k])
        ? String(a.value).slice(0, 40) : "(filled)";
    }
  }
  // Rendering is a function of the rows, so the tournament (runOnce) can render ANY subset of the
  // ranked candidates with exactly the same labels, values and keys as the normal path.
  const render = (rows) => {
    const els = [], criteria = {}, targets = {};
    let num = 0;
    for (const { a, ops: o } of rows) {
    const n = String(++num);
    // scrub BEFORE truncating: a cut-off echo of a secret cannot be recognised afterwards (audit R2b)
    const label = scrubText(a.label || "", inputs).slice(0, 44);
    const specShown = (x) => { const k = keyOf(x.label, x.role);
      return k !== null && !x.secret && !isSecretKey(k) && norm(x.value) && norm(x.value) === norm(inputs?.[k]) ? x.value : null; };
    const v = a.role === "checkbox" || a.role === "radio" ? (a.checked ? "checked" : "unchecked")
      : a.kind === "fill" || a.role === "textbox" ? specShown(a)   // only a non-secret spec value we typed
      : a.kind === "select" || a.role === "password" ? null
      : a.role === "combobox" && a.tag !== "input" && !a.secret ? a.value : null;   // audit S5
    els.push({ i: n, r: a.role, l: label, ...(a.popup ? { p: 1 } : {}), ...(v && !a.secret ? { v: String(v).slice(0, 24) } : {}) });
    // NB a select OPTION's `value` is the option, not the control's state: sending it as `v` told
    // the model the plan was already "Growth", and it answered DONE four times (fixtures/select.html).
    // FIX (2026-09-21): put the ROLE in the choice text. Without it the model had to pick between
    // "CLICK 5 Clients" (a nav link) and "CLICK 12 Client" (the form combobox) on label alone,
    // and chose the nav link at 0.55 confidence -- then wandered off the form entirely. The role
    // is already in state.elements; it was simply missing from the thing being chosen between.
    for (const op of o) { (targets[op] ??= {})[n] = a; criteria[`${op}:${n}`] = `${op} ${n} ${label} [${a.role}]`; }
  }
    return { els, criteria, targets };
  };
  ({ els, criteria, targets } = render(keep));
  const dropped = ranked.length - keep.length;
  const lettersTrimmed = lettersLost;
  return { els, criteria, targets, dropped, lettersTrimmed, total: ranked.length, values,
    render, all: [...ranked].sort((x, y) => x.i - y.i) };
}

async function decide({ els, criteria, values }, snap, goal, history, engine, inputs, weakKeys, redact) {
  const state = {
    url: urlPattern(snap.url),   // SECURITY (audit S4): token-like path segments become :id
    title: snap.title.slice(0, 60),
    elements: els,
    ...(values && Object.keys(values).length ? { values } : {}),
    done: history.slice(-5),
  };
  if (process.env.JEV_DEBUG) console.error(JSON.stringify({ state, criteria }));
  return choose({ state, criteria, goal, engine, inputs, weakKeys, redact });
}

// One typed choice over the offered keys, on any engine. decide() uses it for the next action;
// the map router (src/route.mjs) uses it to pick a target page. Same wire shape everywhere.
export async function choose({ state, criteria, goal, rules = RULES, engine = "jev", inputs, weakKeys = [], redact = [] }) {
  // SECURITY: every secret spec value is scrubbed from the entire payload, wherever it appears
  // (weak ones only where the loop saw them echoed); declared redact patterns apply to page content.
  ({ state, criteria, goal, rules } = scrub({ state, criteria, goal, rules }, inputs, { weakKeys }));
  ({ state, criteria } = redactPatterns({ state, criteria }, redact));
  const questions = { action: { type: "choice", criteria, instructions: { goal, rules } } };
  const t0 = performance.now();
  if (engine === "vercel") {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
      body: JSON.stringify({ model: "typesafe-ai/jev", state: JSON.stringify(state), questions }),
    });
    if (!res.ok) throw new Error(`vercel HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
    const r = await res.json();
    const g = r.providerMetadata?.gateway || {};
    return { choice: r.answers.action.choice, confidence: r.answers.action.confidence ?? 1,
      ms: performance.now() - t0, tokens: r.usage?.inputTokens || 0,
      cost: Number(g.cost ?? 0), marketCost: Number(g.marketCost ?? 0), truncated: false };
  }
  if (engine === "jev") {
    const r = await post("https://openrouter.ai/api/alpha/decisions",
      { model: "typesafe/jev-1.13", state, questions }, true);
    return { choice: r.answers.action.choice, confidence: r.answers.action.confidence,
      ms: performance.now() - t0, tokens: r.usage?.input_tokens || 0, cost: r.usage?.cost || 0, truncated: false };
  }
  // "local": an open decision model served by local-engine/server.py, constrained to the offered
  // option labels by construction -- one prefill, then read only the labels' logits.
  if (engine !== "local") throw new Error(`unknown engine "${engine}": use jev, vercel or local`);
  const r = await post(LOCAL_URL, { state, questions }, false);
  if (r.error) throw new Error(engine + ": " + r.error);
  return { choice: r.answers.action.choice, confidence: r.answers.action.confidence,
    ms: performance.now() - t0, inferMs: r.timing.infer_ms, queuedMs: r.timing.queued_ms,
    tokens: r.usage.input_tokens, cost: 0, truncated: r.timing.truncated };
}

// Text comes from the test spec. No model invents test data.
// Same resolution as compact()'s suppression check, or the loop offers a field it cannot fill.
function specValue(flow, action, keyMap) {
  const k = keyFor(action.label, flow.inputs, action.role) ?? keyMap?.get(action.label) ?? null;
  return k === null ? null : flow.inputs[k];
}
// CODEGEN (2026-09-22): which inputs KEY matched, not the value. The generated spec references
// INPUTS.<key>, so the credential stays in the spec file and never enters the trace on disk.
function specKey(flow, action, keyMap) { return keyFor(action.label, flow.inputs, action.role) ?? keyMap?.get(action.label) ?? null; }

// Jev maps an unmatched text field to one of the spec's UNUSED keys, or to NONE.
async function resolveKeys(snap, inputs, keyMap, engine, addCost, redact = []) {
  const fields = snap.actions.filter((a) => a.kind === "fill" && !keyMap.has(a.label));
  if (!fields.length) return;
  const used = new Set();
  for (const a of snap.actions) if (a.kind === "fill") {
    const k = keyFor(a.label, inputs, a.role) ?? keyMap.get(a.label);
    if (k) used.add(k);
  }
  for (const a of fields) {
    if (keyFor(a.label, inputs, a.role) !== null) continue;
    // Never map free text into a typed input (measured: the local engine put a name into the
    // "Tickets" number field, the fill failed, and the run retried it 12 times).
    if (/^(number|range|date|time|datetime-local|month|week|color|file)$/.test(a.itype || "")) { keyMap.set(a.label, null); continue; }
    const free = Object.keys(inputs).filter((k) => !used.has(k));
    if (!free.length || !a.label || a.label === "(unlabeled)") { keyMap.set(a.label, null); continue; }
    const criteria = { NONE: "none of these values belongs in this field" };
    free.forEach((k, i) => { criteria[`KEY:${i}`] = `the test value "${k}" goes in this field`; });
    const d = await choose({ state: { field: a.label, role: a.role, page: new URL(snap.url).pathname },
      criteria, goal: `Which test value belongs in the form field labelled "${a.label}"?`,
      rules: "Match by meaning: e-mail is email, passphrase is password, ticket holder is name.", engine, inputs, redact });
    addCost(d.cost || 0);
    const k = String(d.choice).startsWith("KEY:") && d.confidence >= 0.5 ? free[Number(d.choice.split(":")[1])] : null;
    keyMap.set(a.label, k);
    if (k) used.add(k);
  }
}

// FIX (2026-09-21): ONE normaliser, used by both sides. The model read a \s+-normalised copy
// while checkGoal compared raw innerText, so a correct run was failed by a single &nbsp;.
// Playwright\u2019s rule: the element name and the expected name go through the SAME function
// (roleSelectorEngine.ts:167-169). \\s+ already matches NBSP; zero-width chars are stripped
// because MUI renders one to hold line height and it reads as a truthy value.
const norm = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

// v1: counts controls inside open shadow roots too -- a Web Components page has ~0 light-DOM
// controls, so every step there waited the full 4 s timeout (bake-off: T2 took 18.7 s).
// v1: "at least one control, once parsed" -- the old "> 2 controls" was false on small pages, so every
// non-typing step there waited 2.5 s + 4 s (audit: ~7 s per SELECT step). Counts open shadow roots
// too: a Web Components page has ~0 light-DOM controls (bake-off: T2 18.7 s -> 2.8 s).
const READY = () => {
  if (document.readyState === "loading") return false;
  // A fully loaded page is ready even with no controls (a confirmation page): waiting for one cost
  // 4 s per landing (fixtures login-done.html). SPA hydration is settle()'s job (DOM quiet).
  if (document.readyState === "complete") return true;
  const Q = "input:not([type=hidden]),button,a[href],select,textarea,[role=button]";
  if (document.querySelector(Q)) return true;
  for (const el of document.querySelectorAll("*")) if (el.shadowRoot?.querySelector(Q)) return true;
  return false;
};

// FIX (2026-09-21): READY only asks "are there a few controls?", which is true almost immediately
// and does NOT mean React has finished rendering. Measured: identical code and spec passed 5/5
// headless but failed 3/3 headed with slowMo:120 -- the snapshot was catching half-rendered forms,
// so the model saw different option sets and diverged. Wait for the DOM to go QUIET instead.
async function settle(page, quietMs = 150, timeout = 1200) {
  await page.evaluate(
    ([quiet, cap]) =>
      new Promise((resolve) => {
        let t = setTimeout(done, quiet);
        const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const hard = setTimeout(done, cap);
        function done() { clearTimeout(t); clearTimeout(hard); obs.disconnect();
          const anims = document.getAnimations ? document.getAnimations() : [];
          if (!anims.length) return resolve();
          Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))),
                        new Promise((r) => setTimeout(r, 400))]).then(resolve, resolve); }
      }),
    [quietMs, timeout]
  ).catch(() => {});
}

// FIX (2026-09-22): `expect` is a DOM substring, and a substring cannot express a SELECTION.
// Measured on a create form with a Radix client picker: expect:["Acme DevTools"] is true on the very first
// snapshot, before the loop touches anything -- Radix renders a visually-hidden native <select>
// carrying every client's name for form submission, so the text is on the page from page load.
// Opening the portal dropdown has the same effect on any library. `expectState` asserts the
// {role, name, value} triple of the CONTROL instead, which is only true once a value is set:
//
//   expectState: [{ role: "combobox", name: "Client", value: "Acme DevTools" }]
//   expectState: [{ role: "checkbox", name: "Select Never Activated", checked: true }]
//
// Matched against the SAME in-page snapshot the model is offered, so it costs one extra
// evaluate() (~1-7 ms) and needs no CDP session. `value` matches by substring because the
// snapshot truncates a combobox value at 40 chars; the flags match exactly.
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

// Every text node that appears is remembered for the life of the document (capped).
const SEEN_RECORDER = `(() => {
  window.__jevSeen = [];
  const rec = (n) => { const t = (n.textContent || "").trim(); if (t && t.length < 300 && window.__jevSeen.length < 2000) window.__jevSeen.push(t); };
  new MutationObserver((ms) => { for (const m of ms) { m.addedNodes.forEach(rec); if (m.type === "characterData") rec(m.target); } })
    .observe(document, { childList: true, subtree: true, characterData: true });
})();`;

// `expectAbsent` (attack mode): text a user must NOT see -- the success state an attack must never
// reach (an order confirmation, a refund line). Returns the first such text on the page, or null.
async function absentSeen(page, flow) {
  if (!flow.expectAbsent?.length) return null;
  try {
    const seen = norm(await page.evaluate(`(${SEEN_TEXT})()`));
    return flow.expectAbsent.find((x) => seen.includes(norm(x))) ?? null;
  } catch { return null; }
}

async function checkGoal(page, flow, snap) {
  try {
    const urlOk = flow.expectUrl ? new RegExp(flow.expectUrl).test(page.url()) : true;
    if (!urlOk) return false;
    if (await absentSeen(page, flow)) return false;
    // `expect` asserts against what a USER perceives (src/seen-text.js), not raw innerText: form
    // controls contribute nothing (assert them with expectState), hidden/aria-hidden text not at all.
    const need = [...(flow.expect || []), ...(flow.expectSeen || [])];
    const seen = need.length ? norm(await page.evaluate(`(${SEEN_TEXT})()`)) : "";
    if (!(flow.expect || []).every((x) => seen.includes(norm(x)))) return false;
    // v1 (audit A5): `expectSeen` passes if the text appeared at ANY moment since the page loaded --
    // for a toast that lives 300 ms, shorter than a step. Recorded by SEEN_RECORDER (init script).
    if (flow.expectSeen?.length) {
      const past = norm((await page.evaluate(() => window.__jevSeen || [])).join(" "));
      if (!flow.expectSeen.every((x) => seen.includes(norm(x)) || past.includes(norm(x)))) return false;
    }
    if (!flow.expectState?.length) return true;
    // A control's state is only readable once the portal has closed and put the value back on
    // the trigger: while a Radix listbox is open the trigger is not in the candidate set at all.
    // The loop already checks the goal on EVERY snapshot (finding #8), so the first snapshot
    // after the dropdown closes is where this fires. Nothing extra is needed to wait for it.
    return stateOk(snap ?? await page.evaluate(`(${SNAPSHOT})()`), flow.expectState);
  } catch { return false; }
}


// A snapshot-time attribute goes stale the moment a component re-renders its portal
// (Radix/shadcn selects, menus, dialogs). Resolve semantically at click time instead.
const ARIA = { textbox: "textbox", password: "textbox", button: "button", link: "link",
  option: "option", combobox: "combobox", tab: "tab", checkbox: "checkbox", switch: "switch",
  radio: "radio", menuitem: "menuitem" };
// BAKEOFF: the snapshot stamps inside open shadow roots (Playwright CSS pierces them) and
// same-origin iframes (it does not), so the stamp is looked up in every frame, then the role chain.
async function byRole(scope, action, fn) {
  const role = ARIA[action.role], name = (action.label || "").trim();
  if (role && name) {
    try { await fn(scope.getByRole(role, { name, exact: true }).first(), 1500); return "role"; } catch {}
    try { await fn(scope.getByRole(role, { name }).first(), 1200); return "role~"; } catch {}
  }
  if (name) {
    try { await fn(scope.getByText(name, { exact: true }).filter({ visible: true }).first(), 1200); return "text"; } catch {}
  }
  throw new Error("unresolvable");
}
async function act(page, action, fn) {
  for (const f of page.frames()) {
    const byNode = f.locator(`[data-jev-node="${action.node}"]`);
    if (!(await byNode.count().catch(() => 0))) continue;
    try { await fn(byNode, 1200); return f === page.mainFrame() ? "node" : "node@frame"; } catch {}
    break;
  }
  for (const f of page.frames()) { try { return await byRole(f, action, fn); } catch {} }
  throw new Error("unresolvable");
}

export async function runOnce({ flow, engine = "local", budget = 30, browser: shared, trace,
                                base, context: ctxOpts, map, route: routeMode = "click", video } = {}) {
  base = (flow.base || base || DEFAULT_BASE).replace(/\/$/, "");
  const t0 = performance.now();
  const browser = shared || await chromium.launch({ headless: true });
  // VIDEO (--video dir): Playwright records the viewport; the step record then carries each step's
  // start time and the target's box, so a replay can show what was clicked and when. The video is
  // what the browser showed -- typed values included -- so it is written only when asked for.
  const size = { width: 1280, height: 900 };
  const context = await browser.newContext({ viewport: size,
    ...(video ? { recordVideo: { dir: video, size } } : {}),
    ...(flow.storageState ? { storageState: flow.storageState } : {}), ...(ctxOpts || {}) });
  if (flow.expectSeen?.length) await context.addInitScript(SEEN_RECORDER);
  const page = await context.newPage();
  const videoAt = video ? Math.round(performance.now() - t0) : null;
  const steps = [], history = [];
  let outcome = "UNKNOWN", error = null, doneRejects = 0, blocked = 0;
  const filled = new Set();
  const keyMap = new Map();   // field label -> spec key, resolved by Jev when no substring matches
  const stuck = new Set();    // fields whose fill threw: never offered for typing again
  const typedKeys = new Map(); // "path|key" -> the field label that key was typed into
  let redactUrl = (u) => u;   // declared regex redaction for URLs written to the trace
  // ECHO DETECTION for weak secrets ("admin", "letmein1"): such a value cannot be told from a page
  // word by its shape, but it can by its HISTORY. If the word was on a page before we typed it, it
  // is the page's own word ("Admin" in the nav) and stays; if it appears only after, it is an echo
  // of what we typed and is scrubbed from everything the engine sees. (audit W1)
  const weak = Object.entries(flow.inputs || {}).filter(([k, v]) => isSecretKey(k) && v != null && String(v).length >= 3 && !isStrong(v));
  // Static-ness is per STRING, not per word (audit r7: "summer" was in "Summer sale" before typing,
  // so the echo "Unlock with summer" went out). Every label and title seen before a weak key was
  // typed is the page's own; after typing, a weak word is scrubbed only from strings that are new.
  const weakTyped = new Set(), before = new Set();
  const noteWeak = (snap) => {
    if (weakTyped.size === weak.length && weak.length) return;
    for (const t of [snap.title, ...snap.actions.map((a) => a.label)]) before.add(norm(t).toLowerCase());
  };
  const echoed = () => [...weakTyped];
  const isOwn = (text) => before.has(norm(text).toLowerCase());
  let decideMs = 0, inferMs = 0, cost = 0, truncs = 0, routeRec = null, invalidChoice = null, absentHit = null;

  try {
    await page.goto(base + (flow.start || "/"), { waitUntil: "domcontentloaded" });
    // MAP (v1): with a discovered map, Jev first picks the page where the work begins and code
    // walks there. The step loop below then only makes local choices. See src/route.mjs.
    if (map && routeMode) {
      const { pickTarget, findRoute, walk } = await import("./route.mjs");
      const { pattern } = await import("./discover.mjs");
      const t = await pickTarget(map, redactGoal(flow.goal, flow.inputs), engine, pattern(page.url()), flow.inputs, flow.redact);
      cost += t.cost; decideMs += t.ms;
      routeRec = { target: t.target, pattern: t.pattern, decisions: t.decisions, hops: [] };
      // Only move when the start page is IN the map and a real click route exists. A jump to a
      // page the map cannot reach by links would skip state the flow needs (measured: teleporting
      // off an unmapped start page took the fixture suite from 18/33 to 12/33).
      const here = page.url().replace(/#.*$/, "");
      const known = map.pages.some((p) => p.urls.some((u) => u.replace(/#.*$/, "") === here));
      if (t.target && known && t.target.replace(/#.*$/, "") !== here) {
        const r = findRoute(map, here, t.target);
        if (r) routeRec.hops = routeMode === "goto"
          ? (await page.goto(t.target, { waitUntil: "domcontentloaded" }), [{ goto: t.target }])
          : await walk(page, r, t.target);
        else routeRec.unreachable = true;
      }
      routeRec.ms = Math.round(performance.now() - t0);
    }
    for (let i = 0; i < (flow.maxSteps || 14); i++) {
      let snap;
      const at = Math.round(performance.now() - t0);
      await settle(page);
      try { snap = await page.evaluate(`(${SNAPSHOT})()`); }
      catch { await page.waitForTimeout(150); snap = await page.evaluate(`(${SNAPSHOT})()`); }
      // FIX (2026-09-21): check the goal on EVERY snapshot, not only when the model claims DONE.
      // Measured on create-campaign: the campaign WAS created at step 17, the model never noticed,
      // and it then clicked away to /team and destroyed its own result -- reported as MAX_STEPS.
      // The assertion is deterministic and costs ~2ms, so there is no reason to wait to be told.
      // Checked here, before deciding, rather than after acting: checking post-action races with
      // the navigation the action just started, and can pass on a URL that is already going away.
      // DECLARED REDACTION, AT THE SOURCE (src/redact.mjs): before anything is built from the snapshot.
      if (flow.redact?.length) {
        const r = await buildRedactor(page, flow.redact);
        redactSnapshot(snap, r);
        redactUrl = r.url;
      }
      noteWeak(snap);
      // A weak value that is exactly a label on THIS page ("Admin") names that element when the goal
      // says it ("open the Admin page"), so the goal keeps the word here (audit r8, weak-later-page).
      const labelsNow = new Set(snap.actions.map((a) => norm(a.label).toLowerCase()));
      const keepWeak = weak.filter(([, v]) => labelsNow.has(String(v).toLowerCase())).map(([k]) => k);
      // Scrub weak-secret ECHOES at the source: only in strings the page did not have before typing.
      if (echoed().length) {
        const w = { weakKeys: echoed() };
        // A string that IS exactly the weak word ("Admin") is the page's word, not an echo of what we
        // typed (audit r8: the dashboard's "Admin" link reached the model as <password>). A weak
        // secret is guessable by definition; navigation must not break over it.
        const exact = new Set(weak.map(([, v]) => String(v).toLowerCase()));
        const fix = (t) => (t == null || isOwn(t) || exact.has(norm(t).toLowerCase()) ? t : scrubText(t, flow.inputs, w));
        snap.title = fix(snap.title);
        for (const a of snap.actions) { a.label = fix(a.label); if (a.optionLabel) a.optionLabel = fix(a.optionLabel); }
      }
      // ATTACK MODE: an `expectAbsent` text on the page means the app ACCEPTED what it must refuse.
      // Stop here: the run is a finding, and wandering on to MAX_STEPS would read as "got lost".
      if ((absentHit = await absentSeen(page, flow))) { outcome = "ABSENT_SEEN"; break; }
      // With `control`, loading the start URL IS the action (another user's order), so step 0 counts.
      if ((i > 0 || routeRec?.hops?.length || flow.control) && await checkGoal(page, flow, snap)) { outcome = "DONE_VERIFIED"; break; }

      // FIX (v1, TicketBay D2): a field whose label contains no spec key (a rename: "Email" ->
      // "E-mail") used to be invisible to the test. Jev now picks WHICH spec key belongs in it --
      // a typed choice over the keys, so the text still comes only from the spec. Once per label.
      if (flow.inputs) await resolveKeys(snap, flow.inputs, keyMap, engine, (c) => { cost += c; }, flow.redact);
      const keyOf = (label, role) => stuckLabels.has(label) ? null : keyFor(label, flow.inputs, role) ?? keyMap.get(label) ?? null;
      const here = new URL(snap.url).pathname;
      const stuckLabels = new Set([...stuck].filter((k) => k.startsWith(here + "|")).map((k) => k.split("|").slice(2).join("|")));
      let space = compact(snap, budget, filled, flow.inputs, 3, keyOf, flow.goal, typedKeys);
      // FIX (2026-09-21): while a modal listbox/menu is open, its options are the ONLY legal
      // moves -- which is why the snapshot can see nothing else. Offering WAIT/DONE/BLOCKED here
      // makes the model take the escape hatch: measured DONE@0.90, and BLOCKED@0.9997 when DONE
      // was removed. Removing the bad options (rather than instructing against them) gives
      // CLICK@1.00. Same principle as finding #2 in the README.
      const listboxOpen = space.all.some((r) => r.a.popup);
      // The history shown to the model must agree with the page: a field offered for typing again
      // (it was emptied by a reload) is NOT "typed". Measured on the D1 repro: with the stale
      // "typed Email" line the model answered BLOCKED on a page with two empty required fields.
      const shownHistory = () => {
        const retype = new Set(Object.values(space.targets.TYPE_TEXT || {}).map((a) => `typed ${a.label}`));
        return history.filter((h) => !retype.has(h));
      };
      // TOURNAMENT (v1). When the page has more candidates than one decision can hold (the budget,
      // then the 52-letter ceiling), the old loop DROPPED the rest -- fixtures/table.html's "Next
      // page" is candidate #63 and was never offered (0/3). Now nothing is dropped: the candidates
      // are split into heats that each fit, every heat is decided in parallel with a "none of
      // these" option, and the final decision is between the heat winners. Pages that fit in one
      // decision never get here, so their behaviour is unchanged.
      let heats = null;
      if (space.dropped > 0) {
        const CAP = LETTER_CEILING - 4, chunks = [];
        let cur = [], n = 0;
        for (const r of space.all) {
          if (cur.length && n + r.ops.length > CAP) { chunks.push(cur); cur = []; n = 0; }
          cur.push(r); n += r.ops.length;
        }
        if (cur.length) chunks.push(cur);
        const goal = redactGoal(flow.goal, flow.inputs, keepWeak);
        const results = await Promise.all(chunks.map(async (rows) => {
          const sub = space.render(rows);
          sub.criteria.NONE = "none of these options advances the goal";
          const d = await decide({ ...sub, values: space.values }, snap, goal, shownHistory(), engine, flow.inputs, [], flow.redact);
          return { rows, sub, d };
        }));
        const winners = [];
        for (const { rows, sub, d } of results) {
          cost += d.cost; decideMs += d.ms;
          if (d.choice === "NONE" || !(d.choice in sub.criteria)) continue;
          const [o, ix] = String(d.choice).split(":");
          const row = rows.find((r) => r.a === sub.targets[o]?.[ix]);
          if (row && !winners.includes(row)) winners.push(row);
        }
        winners.sort((x, y) => x.i - y.i);
        space = { ...space, ...space.render(winners) };
        heats = { heats: chunks.length, winners: winners.length };
        // The final exists to COMPARE winners. With exactly one there is nothing to compare: the heat
        // already decided it over a "none of these" option, so the final round trip is skipped.
        // (bake-off: two sequential rounds cost +335 ms on the 60-row list and changed no outcome.)
        if (winners.length === 1) {
          const only = results.find(({ rows }) => rows.includes(winners[0])).d;
          const key = Object.keys(space.criteria).find((k) => k.startsWith(String(only.choice).split(":")[0] + ":"));
          heats.decided = key ? { choice: key, confidence: only.confidence, ms: 0, cost: 0, tokens: 0 } : null;
        }
      }
      if (!listboxOpen) {
        space.criteria.WAIT = "wait for the page";
        // No DONE option. The goal is checked deterministically on EVERY snapshot before this decision,
        // so when the model is asked, "done" is false by construction; offering it only created a
        // failure mode (Jev 27/30 from false DONEs in the spike; the local engine answered DONE four
        // times in a row on late-enable.html and card-year.html). Take the bad option away.
        // BLOCKED ("nothing can progress") is false by definition while a value from the spec is still
        // waiting to be typed or chosen on this page -- that IS progress -- so it is offered only when
        // no such action exists.
        const specWork = Object.keys(space.criteria).some((k) => k.startsWith("TYPE_TEXT:") || k.startsWith("SELECT:"));
        if (!specWork) space.criteria.BLOCKED = "nothing can progress";
      }

      const d = heats?.decided ? { ...heats.decided, truncated: false }
        : await decide(space, snap, redactGoal(flow.goal, flow.inputs, keepWeak), shownHistory(), engine, flow.inputs, [], flow.redact);
      if (heats) delete heats.decided;
      // The engine must return one of OUR keys. Anything else is treated as BLOCKED, never acted on.
      if (!(d.choice in space.criteria)) { invalidChoice = d.choice; d.choice = "BLOCKED"; }
      decideMs += d.ms; inferMs += d.inferMs || 0; cost += d.cost;
      // Loud, because a silent truncation means the model never saw options we believe we offered.
      if (d.truncated) { truncs++; console.warn(`[truncated] ${flow.name} step ${i + 1}: the engine `
        + `discarded options past the ${LETTER_CEILING}-letter ceiling -- the model did not see them`); }

      let op = d.choice, tIdx = null, action = null;
      if (!["WAIT", "DONE", "BLOCKED"].includes(op)) {
        const [o, ix] = String(d.choice).split(":");
        op = o; tIdx = ix; action = space.targets[o]?.[ix];
        if (!action) op = "BLOCKED";
      }
      // CODEGEN (2026-09-22): `role` and `tag` added. act() already resolves by
      // getByRole(ARIA[action.role], {name: action.label}) at line 232 -- but the step record
      // kept only the label, so a trace could not reproduce the locator act() itself used.
      // `tag` distinguishes a native <select> combobox from a <button role=combobox> trigger,
      // which need different assertions (toHaveValue vs toContainText).
      const step = { n: i + 1, at, decidedAt: Math.round(performance.now() - t0), url: snap.url, op, target: tIdx, label: action?.label ?? null,
        role: action?.role ?? null, tag: action?.tag ?? null,
        confidence: d.confidence, ms: Math.round(d.ms), inferMs: d.inferMs, tokens: d.tokens,
        options: Object.keys(space.criteria).length, dropped: space.dropped, truncated: d.truncated,
        ...(heats ? { tournament: heats } : {}) };

      if (op === "DONE") {
        await page.waitForFunction(READY, null, { timeout: 2000, polling: 50 }).catch(() => {});
        if (await checkGoal(page, flow)) { steps.push(step); outcome = "DONE_VERIFIED"; break; }
        if (doneRejects < 3) { doneRejects++; step.doneRejected = true; steps.push(step); await page.waitForTimeout(200); continue; }
        steps.push(step); outcome = "DONE_REJECTED"; break;
      }
      if (op === "BLOCKED") {
        // "Nothing can progress" is only believable on a STABLE page. Wait up to 3 s for the page to
        // change (an async check finishing, a button enabling); a BLOCKED counts toward giving up only
        // when nothing changed. (fixtures/late-enable.html: three BLOCKEDs in ~1.5 s during a 1.8 s
        // availability check, then MODEL_BLOCKED, although the submit enabled a moment later.)
        const changed = await page.evaluate((cap) => new Promise((resolve) => {
          const obs = new MutationObserver(() => { obs.disconnect(); clearTimeout(t); resolve(true); });
          obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          const t = setTimeout(() => { obs.disconnect(); resolve(false); }, cap);
        }), 3000).catch(() => true);
        step.retried = true; steps.push(step);
        if (changed) continue;
        if (++blocked < 3) continue;
        outcome = "MODEL_BLOCKED"; break;
      }

      const before = page.url();
      if (video && action) {
        const b = await page.locator(`[data-jev-node="${op === "SELECT" ? action.selectNode : action.node}"]`).first()
          .boundingBox({ timeout: 300 }).catch(() => null);
        if (b) step.box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      }
      if (op === "TYPE_TEXT") {
        const v = specValue(flow, action, keyMap);
        if (v === null) { step.noSpecValue = true; steps.push(step); outcome = "NO_SPEC_VALUE"; break; }
        step.inputKey = specKey(flow, action, keyMap);   // CODEGEN: the key, never the value
        try { step.via = await act(page, action, (loc, t) => loc.fill(v, { timeout: t })); }
        catch {
          // A field that cannot take its value is dropped, not retried: a mapped key is unmapped,
          // and the field is not offered for typing again in this run.
          step.stale = true; steps.push(step); history.push(`stale ${action.label}`);
          if (keyMap.get(action.label)) keyMap.set(action.label, null);
          stuck.add(fillKey(snap.url, action)); continue;
        }
        filled.add(fillKey(snap.url, action));
        if (step.inputKey) typedKeys.set(`${new URL(snap.url).pathname}|${step.inputKey}`, action.label);
        if (step.inputKey && weak.some(([k]) => k === step.inputKey)) weakTyped.add(step.inputKey);
        history.push(`typed ${action.label}`);
      } else if (op === "SELECT") {
        try { step.via = await act(page, { ...action, node: action.selectNode, label: action.selectLabel, role: "combobox" },
          (loc, t) => loc.selectOption({ label: action.optionLabel }, { timeout: t })); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        step.option = action.optionLabel; step.control = action.selectLabel;
        history.push(`selected ${action.label}`);
      } else if (op === "CLICK") {
        try { step.via = await act(page, action, (loc, t) => loc.click({ timeout: t })); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        // FIX (2026-09-21): a link click starts a navigation that has not begun yet when we
        // re-snapshot. READY is true on the OLD page and settle() sees a DOM that is quiet only
        // because nothing has happened, so the loop re-reads the old page and clicks the same link
        // again. Measured after links were promoted to rank 1: "New campaign" clicked TEN times,
        // burning 10 of 22 steps and failing create-campaign 0/5. Only links pay this wait.
        if (action.role === "link") {
          await page.waitForURL((u) => u.toString() !== before, { timeout: 1200 }).catch(() => {});
        }
        history.push(`clicked ${action.label}`);
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

  const tLoopEnd = performance.now() - t0;
  const passed = await checkGoal(page, flow);
  // A success marker that appeared after the last step is still a finding, not "got lost".
  if (!absentHit && outcome !== "ERROR" && (absentHit = await absentSeen(page, flow))) outcome = "ABSENT_SEEN";
  const tCheck = performance.now() - t0;
  const finalUrl = page.url();
  const videoFile = video ? await page.video()?.path() : null;
  await context.close();
  if (!shared) await browser.close();
  const rec = { flow: flow.name, ...(flow.kind ? { kind: flow.kind } : {}), base, engine, budget, outcome, passed, finalUrl, error,
    ...(absentHit ? { absentSeen: absentHit } : {}), steps,
    ...(routeRec ? { route: routeRec } : {}), ...(invalidChoice ? { invalidChoice } : {}),
    decideMs: Math.round(decideMs), inferMs: Math.round(inferMs), cost, truncations: truncs,
    doneRejects, wallMs: Math.round(performance.now() - t0),
    ...(video ? { video: { file: videoFile, at: videoAt, size } } : {}),
    tLoopEnd: Math.round(tLoopEnd), tCheck: Math.round(tCheck) };
  // SECURITY (audit): the trace on disk is scrubbed too -- a GET form puts a password in finalUrl.
  rec.weakEchoed = echoed();
  // Labels in the record were scrubbed at the source; a weak value can still sit in a URL's QUERY
  // (a GET form), so queries get the weak scrub too -- paths stay intact for codegen's toHaveURL.
  const q = (u) => { if (!u || !rec.weakEchoed.length) return u; const i = u.indexOf("?");
    return i < 0 ? u : u.slice(0, i) + scrubText(u.slice(i), flow.inputs, { weakKeys: rec.weakEchoed }); };
  rec.finalUrl = redactUrl(q(rec.finalUrl));
  for (const st of rec.steps) { st.url = redactUrl(q(st.url)); if (st.label) st.label = String(st.label); }
  if (trace) fs.writeFileSync(trace, JSON.stringify(scrub(rec, flow.inputs), null, 2));
  return rec;
}

export { compact, redactGoal, stateOk, chromium, SNAPSHOT, SEEN_TEXT, settle, act, keyFor, norm, checkGoal, absentSeen, ARIA, LETTER_CEILING };
