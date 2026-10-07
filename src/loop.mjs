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
// comment lines dropped: the text ships inside every emitted spec (wave-2 tests W1, W2)
const SEEN_TEXT = fs.readFileSync(path.join(__dir, "seen-text.js"), "utf8").replace(/^\s*\/\/.*\n/gm, "").trim();
const SNAPSHOT = fs.readFileSync(path.join(__dir, "snapshot.js"), "utf8").replaceAll("__SECRET_SRC__", SECRET_SRC.replace(/\\/g, "\\\\"));
const KEY = process.env.OPENROUTER_API_KEY;
// PERF (opt-in): QUICKE2E_PROF=1 adds per-phase timings (ms) to every step record as `prof`.
const PROF = !!process.env.QUICKE2E_PROF;
// PERF: speculative decision (see runOnce). QUICKE2E_SPECULATE=0 turns it off.
const SPECULATE = process.env.QUICKE2E_SPECULATE !== "0";
let lastNet = null;   // set by post(): { ttfb, body, tries } of the last engine call
const LOCAL_URL = process.env.LOCAL_URL || "http://127.0.0.1:8822";
// FIX (2026-09-21): was hardcoded to the reference app. A client could not point this at their own app
// without editing the source. Resolution order: flow.base -> runOnce({base}) -> $APP_BASE -> default.
const DEFAULT_BASE = process.env.APP_BASE || "http://localhost:3000";
// v0.3. Below MIN_CONFIDENCE the engine's pick is not executed (counts as BLOCKED); chosen from the
// fixture suite's measured confidences (see test/core.test.mjs and the 0.3.0 notes). LOOP_LIMIT: the
// same action on an unchanged page this many times ends the run with outcome LOOP.
const MIN_CONFIDENCE = 0.3;
const LOOP_LIMIT = 4;
const MAX_FREE_WAITS = 10;   // v0.4: WAITs that do not count toward maxSteps
const SLOW_MS = 3000;        // v0.4: an action slower than this is flagged in the record and output
// neverClick: strings are case-insensitive globs over the WHOLE label ("Pay*", "*delete*"); RegExps test as-is.
function neverMatcher(list) {
  if (!list?.length) return null;
  const res = list.map((p) => p instanceof RegExp ? p
    : new RegExp("^" + String(p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"));
  // invisible characters (a soft hyphen in "Del\u00ADete") must not slip past a pattern (security test W6)
  return (label) => { const l = norm(String(label ?? "").replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "")); return res.some((r) => { r.lastIndex = 0; return r.test(l); }); };
}
// What the page looks like to the loop: URL plus every action's label, value and state.
function pageSig(snap) {
  const s = snap.url + "\n" + snap.actions.map((a) => `${a.kind}|${a.label}|${a.value ?? ""}|${a.checked ?? ""}|${a.current_value ?? ""}`).join("\n");
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const RULES = "Choose the one operation that advances the goal from this page. " +
  "Do not repeat a step that is already satisfied. Fill required fields before submitting.";

// Retry 429 and 5xx with backoff (roadmap #1; the bake-off lost 1 of 120 runs to an HTTP 520).
// Every request has a timeout (launch test 2026-10-07: an engine call that never answered hung the run
// for good, past maxTimeMs). A timed-out request is retried like a 5xx.
const ENGINE_TIMEOUT_MS = Number(process.env.QUICKE2E_ENGINE_TIMEOUT_MS) || 30000;
// The signal covers a real fetch; the race also covers a body read or a fetch wrapper that ignores it.
const withTimeout = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() =>
  no(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ENGINE_TIMEOUT_MS + 100).unref())]);
async function post(url, body, auth, tries = 4) {
  for (let k = 0; ; k++) {
    const tq = performance.now();
    const res = await withTimeout(fetch(url, { method: "POST", signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(body) })).catch((e) => ({ ok: false, status: 0,
        text: async () => e?.name === "TimeoutError" ? `no answer from the engine in ${ENGINE_TIMEOUT_MS / 1000} s` : String(e) }));
    if (res.ok) { const th = performance.now(); const j = await withTimeout(res.json());
      lastNet = { ttfb: th - tq, body: performance.now() - th, tries: k + 1 }; return j; }
    if (k + 1 < tries && (res.status === 0 || res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** k)); continue;
    }
    // Tagged: an engine failure is not an app failure (outcome ENGINE_ERROR, no app reasons printed).
    throw Object.assign(new Error(res.status === 0 ? `engine request failed after ${k + 1} tries: ${(await res.text()).slice(0, 140)}`
      : `engine HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`), { engine: true, status: res.status });
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
                 keyOf = (label, role) => keyFor(label, inputs, role), goal = null, typedKeys = new Map(), never = null) {
  let els = [], targets = {}, criteria = {};
  const idx = {};
  const ops = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT", hover: "HOVER", drag: "DRAG" };
  const raw = [];
  // v0.4: a spec key that EXACTLY names one field is that field's key only; fields whose label merely
  // contains the word ("sliderValue" for key "slider") are not offered for it (demoqa: the engine typed
  // 75 into the readout box next to the slider at 0.57).
  const lc = (t) => norm(t).toLowerCase();
  const exactKeys = new Set(Object.keys(inputs || {}).filter((k) =>
    snap.actions.some((x) => (x.kind === "fill" || (x.kind === "click" && x.role === "combobox" && x.tag === "input")) && lc(x.label) === lc(k))));
  for (const a of snap.actions) {
    let op = ops[a.kind]; if (!op) continue;
    if (a.inert) continue;   // behind an open aria-modal dialog (snapshot.js)
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
      // neverClick covers a <select> option (security test W6) -- unless the spec's inputs name that very
      // option: then choosing it is the spec author's explicit choice (bulk action "Delete" + neverClick
      // on the confirm dialog's Delete button; wave-2 W4)
      if (k === null && never && never(a.optionLabel)) continue;
      raw.push({ a: { ...a, label: `${a.optionLabel} in ${a.selectLabel}` }, ops: [op] });
      continue;
    }
    // FIX (v1): keyed by page + role + label, not the per-snapshot ordinal. `n0` on page 2 is a
    // different field from `n0` on page 1 (fixtures/ordinal-a/b.html: page 2's only field vanished).
    if (op === "TYPE_TEXT") {
      const k = keyOf(a.label, a.role);
      if (k === null) continue;                          // no spec value: not this test's field
      if (exactKeys.has(k) && lc(a.label) !== lc(k)) continue;   // v0.4: another field IS this key
      // One spec key fills ONE field per page (audit B1 / fixtures/ambiguous.html): once "name" went
      // into one of First/Middle/Last name, the other two are not this key's fields. A re-fill of
      // the SAME field after a reload (TicketBay D1) is still allowed.
      const used = typedKeys.get(`${new URL(snap.url).pathname}|${k}`);
      if (used && used !== a.label) continue;
      // Repeated rows with the same label (a table's "Heading" column, row 2 of a formset): the key is
      // already in one of them, so the empty twin is not this key's field and does not hold Save back
      // (wave-2 test W4: Django TabularInline ran to MAX_STEPS).
      if (!norm(a.value) && snap.actions.some((b) => b !== a && b.kind === "fill" && b.label === a.label && norm(b.value) === norm(inputs[k]) && norm(b.value))) continue;
      // ...and of several EMPTY twins only the first: "Number" went into row 1 and "Heading" into row 2,
      // which saved two half chapters
      if (!norm(a.value)) { const first = snap.actions.find((b) => b.kind === "fill" && b.label === a.label && !norm(b.value)); if (first && first !== a) continue; }
      // FIX (v1, TicketBay D1): "filled" is read off the DOM, not remembered. A field that already
      // holds its spec value is done; a field we typed into that is EMPTY again (the form reloaded,
      // e.g. an Apply-code GET submit) is offered again. Remembered-and-non-empty stays suppressed,
      // so a masked field (phone formatting) cannot loop.
      // ENTER TO SUBMIT (launch test 2026-10-07: TodoMVC 0/8, a todo input has no button): a field that
      // holds its spec value and has no submit button in its form can be submitted with Enter.
      // A whitespace-only spec value ("   ", the "only spaces" attack) is a value to type: compared after
      // trimming it equalled the empty field, so it was never typed and the attack passed falsely
      // (wave-2 test W3). An empty string still means "leave it empty".
      const wsOnly = typeof inputs[k] === "string" && inputs[k].length > 0 && !inputs[k].trim();
      if (wsOnly ? a.wsValue === inputs[k] : norm(a.value) === norm(inputs[k])) {
        const hasSubmit = a.form >= 0 && snap.actions.some((b) => b.submit && b.form === a.form);
        if (hasSubmit || a.role === "password" || a.tag === "textarea" || a.role === "slider" || a.itype === "range") continue;
        op = "PRESS_ENTER";
      } else if (filled.has(fillKey(snap.url, a)) && norm(a.value)) continue;
    }
    // FIX (2026-09-21): never offer CLICK on a plain textbox. Text is entered via TYPE_TEXT from
    // the spec, so clicking one is always a wasted step -- measured: 5 of 22 steps burned clicking
    // Budget/Campaign name, exhausting the budget before Save. Comboboxes keep CLICK (they open).
    // FIX (2026-09-22): "password" was missing. snapshot.js:87 gives a password input role
    // "password", not "textbox", so this guard never covered it -- and on the rename fixture the
    // model duly clicked the password field, three trials out of three.
    if (op === "CLICK" && (a.role === "textbox" || a.role === "password" || a.role === "slider")) continue;   // v0.4: a click on a slider sets a random value
    // v0.3: a flow's `neverClick` patterns. The element is never offered, so the engine cannot pick it
    // (a refusal test once paid: the browser blocked the form, then "Pay" was clicked at 0.22).
    // ...and for every op that is not typing: a <select> option, a hover, a drag. Matched against the
    // page's own name too (baseLabel): QuickE2E's context suffix ("Delete account · Bob") made a pattern
    // "Delete account" miss, and the run clicked it (security test W6).
    if (op !== "TYPE_TEXT" && never && (never(a.label) || (a.baseLabel && never(a.baseLabel)) || (a.optionLabel && never(a.optionLabel)))) continue;
    const rowKey = a.kind === "drag" ? a.id : a.node;   // v0.4: drag pairs share a source node; keep each pair
    if (!(rowKey in idx)) { idx[rowKey] = raw.length; raw.push({ a, ops: [] }); }
    if (!raw[idx[rowKey]].ops.includes(op)) raw[idx[rowKey]].ops.push(op);
    // v0.4 AUTOCOMPLETE: a text input with role combobox (react-select, MUI Autocomplete) was only ever
    // offered as CLICK, so a spec value could not reach it (demoqa Subjects: 24 identical clicks). When
    // the spec has a key for it, it can also be typed into -- once: the input empties itself after an
    // option is picked, so "empty again" must not mean "type again".
    if (op === "CLICK" && a.role === "combobox" && a.tag === "input" && inputs) {
      const k = keyOf(a.label, "combobox");
      // Not on a readonly input (antd/Mantine Select: typing fails) and not once it shows the spec value:
      // a TYPE_TEXT row counts as "pending" and held the form's Save back forever (launch test 2026-10-07).
      if (k !== null && !a.readonly && norm(a.value) !== norm(inputs[k]) && !filled.has(fillKey(snap.url, a)) && !raw[idx[rowKey]].ops.includes("TYPE_TEXT"))
        raw[idx[rowKey]].ops.push("TYPE_TEXT");
    }
  }
  // FIX (v1): hold back a form's SUBMIT while a field the spec names in that form is still unset.
  // Measured on fixtures/select.html: the model typed Team, then chose "Save subscription" (0.61)
  // over "SELECT Growth" and saved an empty plan -- finding #2 again. Remove the option.
  // A select is pending only while the CONTROL is unset (bake-off re-run: counting every remaining
  // option kept "Create project" hidden forever after Enterprise was chosen -- 0/5 on two stacks).
  const pending = new Set(raw.filter((r) => r.a.form >= 0 && (r.ops.includes("TYPE_TEXT")
    // an unkeyed select holds the submit back only when it is REQUIRED: an "All" filter (value "") is a
    // valid choice, and holding Search back made the engine pick a category nobody asked for (wave-2 W2)
    || (r.ops.includes("SELECT") && (keyOf(r.a.selectLabel, "combobox") !== null || (!r.a.current_value && r.a.required)))))
    .map((r) => r.a.form));
  // v0.3: remember WHY a submit is missing, so a failed run can say so (field + spec key).
  const heldBack = [];
  for (let j = raw.length - 1; j >= 0; j--)
    if (raw[j].a.submit && pending.has(raw[j].a.form)) {
      const f = raw.find((r) => r.a.form === raw[j].a.form && (r.ops.includes("TYPE_TEXT")
        || (r.ops.includes("SELECT") && (keyOf(r.a.selectLabel, "combobox") !== null || (!r.a.current_value && r.a.required)))));
      const fl = f ? (f.a.selectLabel || f.a.label) : null;
      heldBack.push({ label: raw[j].a.label, waitingFor: fl, key: fl ? keyOf(fl, f.a.selectLabel ? "combobox" : f.a.role) : null });
      raw.splice(j, 1);
    }
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
    // aria-current marks the page/step the user is on: the engine clicked pager "2" five times on page 2
    els.push({ i: n, r: a.role, l: label, ...(a.popup ? { p: 1 } : {}), ...(v && !a.secret ? { v: String(v).slice(0, 24) } : a.current ? { v: "current" } : {}) });
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
  return { els, criteria, targets, dropped, lettersTrimmed, total: ranked.length, values, heldBack,
    render, all: [...ranked].sort((x, y) => x.i - y.i) };
}

function decisionState({ els, values }, snap, history) {
  return {
    url: urlPattern(snap.url),   // SECURITY (audit S4): token-like path segments become :id
    title: snap.title.slice(0, 60),
    elements: els,
    ...(values && Object.keys(values).length ? { values } : {}),
    done: history.slice(-5),
  };
}
async function decide(space, snap, goal, history, engine, inputs, weakKeys, redact) {
  const state = decisionState(space, snap, history), criteria = space.criteria;
  return choose({ state, criteria, goal, engine, inputs, weakKeys, redact });
}
// PERF: the exact engine input of one decision, as a string. Two snapshots with the same key get the
// same request, so a decision made on one is the decision the loop would make on the other.
const decisionKey = (space, snap, goal, history) =>
  JSON.stringify([decisionState(space, snap, history), space.criteria, goal]);

// One typed choice over the offered keys, on any engine. decide() uses it for the next action;
// the map router (src/route.mjs) uses it to pick a target page. Same wire shape everywhere.
export async function choose({ state, criteria, goal, rules = RULES, engine = "jev", inputs, weakKeys = [], redact = [] }) {
  const tp = performance.now();
  // SECURITY: every secret spec value is scrubbed from the entire payload, wherever it appears
  // (weak ones only where the loop saw them echoed); declared redact patterns apply to page content.
  ({ state, criteria, goal, rules } = scrub({ state, criteria, goal, rules }, inputs, { weakKeys }));
  ({ state, criteria } = redactPatterns({ state, criteria }, redact));
  // logged after the scrub and the redaction: JEV_DEBUG printed raw page text (security test W6)
  if (process.env.JEV_DEBUG) console.error(JSON.stringify({ state, criteria }));
  const questions = { action: { type: "choice", criteria, instructions: { goal, rules } } };
  const t0 = performance.now();
  const prepMs = t0 - tp;
  if (engine === "vercel") {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
      method: "POST", signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
      body: JSON.stringify({ model: "typesafe-ai/jev", state: JSON.stringify(state), questions }),
    });
    if (!res.ok) throw Object.assign(new Error(`engine (vercel) HTTP ${res.status}: ${(await res.text()).slice(0,200)}`), { engine: true, status: res.status });
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
      ms: performance.now() - t0, tokens: r.usage?.input_tokens || 0, cost: r.usage?.cost || 0, truncated: false,
      ...(PROF ? { prepMs, net: lastNet } : {}) };
  }
  // "local": an open decision model served by local-engine/server.py, constrained to the offered
  // option labels by construction -- one prefill, then read only the labels' logits.
  if (engine !== "local") throw new Error(`unknown engine "${engine}": use jev, vercel or local`);
  const r = await post(LOCAL_URL, { state, questions }, false);
  if (r.error) throw new Error(engine + ": " + r.error);
  return { choice: r.answers.action.choice, confidence: r.answers.action.confidence,
    ms: performance.now() - t0, inferMs: r.timing.infer_ms, queuedMs: r.timing.queued_ms,
    tokens: r.usage.input_tokens, cost: 0, truncated: r.timing.truncated, ...(PROF ? { prepMs, net: lastNet } : {}) };
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
// NETWORK QUIET (launch test 2026-10-07, false pass 6/6): a page that fetches "A-0977: Order placed"
// 200 ms after load was still quiet for 150 ms before the answer came, so the start check saw no
// "Order placed" and the run then passed on text the app shows by itself. Before the start check,
// wait until no fetch/XHR request is in flight (capped). Static pages have none and wait 0 ms.
export function trackNetwork(page) {
  const open = new Set();
  const on = (r) => { if (["fetch", "xhr"].includes(r.resourceType())) open.add(r); };
  const off = (r) => open.delete(r);
  page.on("request", on); page.on("requestfinished", off); page.on("requestfailed", off);
  return async (cap = 3000) => {
    const t0 = Date.now();
    while (open.size && Date.now() - t0 < cap) await page.waitForTimeout(50);
    return open.size === 0;
  };
}

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

// Every text that appears is remembered for the life of the document (capped).
// v0.3 (saucedemo): an SPA inserts a whole view as ONE element, far over 300 characters, and React
// splits "Item total: $39.98" into two text nodes. Recording only the inserted root (skipped: too
// long) or single text nodes ("Item total: $", "39.98") both missed it. So a long inserted element
// is walked: every element inside it whose full text is under 300 characters is recorded whole.
// A text change inside an existing element records that element's full text.
// expectSeen recorder: text that appeared at any moment, if a user could see it at that moment (launch
// test 2026-10-07, false pass: an opacity-0 toast and "Settings saved" inside a <script type=json>
// translation block both counted). Skips script/style/noscript/template text; records a node when it is
// visible now, or when it becomes visible within 1 s (a toast that fades in from opacity 0).
const SEEN_RECORDER = `(() => {
  window.__jevSeen = [];
  const push = (t) => { t = (t || "").trim(); if (t && t.length < 300 && window.__jevSeen.length < 5000) window.__jevSeen.push(t); };
  const SKIP = "script, style, noscript, template";
  const vis = (el) => { try {
    if (!el.isConnected || el.closest("[hidden], [aria-hidden='true']")) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1;
  } catch { return false; } };
  // The text a user sees in the element, by the same per-text-node rules as expect (seen-text.js):
  // innerText also returned a hidden child ("Processing <span style=opacity:0>Payment confirmed</span>"
  // passed expectSeen: security test W6, 2026-10-07).
  const seenText = (${SEEN_TEXT});
  const text = (el) => { try { return seenText(el); } catch { return ""; } };
  const watch = (el) => {
    if (vis(el)) { push(text(el)); return; }
    for (const ms of [120, 300, 600, 1000]) setTimeout(() => { if (!el.__jevSeenDone && vis(el)) { el.__jevSeenDone = true; push(text(el)); } }, ms);
  };
  const rec = (n) => {
    const el = n.nodeType === 3 ? n.parentElement : n.nodeType === 1 ? n : null;
    if (!el || el.closest(SKIP)) return;
    const t = (el.textContent || "").trim();
    if (!t) return;
    if (n.nodeType === 3 || t.length < 300) { watch(el); return; }
    for (const c of n.childNodes) rec(c);
  };
  new MutationObserver((ms) => { for (const m of ms) { m.addedNodes.forEach(rec); if (m.type === "characterData") rec(m.target); } })
    .observe(document, { childList: true, subtree: true, characterData: true });
})();`;

// `expectAbsent` (attack cases): text a user must NOT see -- the success state an attack must never
// reach (an order confirmation, a refund line). Returns the first such text on the page, or null.
// Text assertions ignore case: CSS text-transform shows "ENTER ACCOUNT INFORMATION" for the DOM text
// "Enter Account Information", and a spec author copies one or the other (launch test 2026-10-07).
const tnorm = (x) => norm(x).toLowerCase();
async function absentSeen(page, flow, { loose = false } = {}) {
  if (!flow.expectAbsent?.length) return null;
  try {
    // loose (the start check only): also text under aria-hidden. An open modal (Angular CDK) sets
    // aria-hidden on the app behind it, which hid "Your Basket" from the start check; closing the modal
    // then gave a false "app accepted the attack" (launch test 2026-10-07).
    const seen = tnorm(await page.evaluate(`(${SEEN_TEXT})()`) + (loose ? " " + await page.evaluate(() => document.body?.innerText || "") : ""));
    return flow.expectAbsent.find((x) => seen.includes(tnorm(x))) ?? null;
  } catch { return null; }
}

// v0.3: the same checks as checkGoal, one record per assertion, for the "why did it fail" report.
async function explainGoal(page, flow) {
  const outl = [];
  try {
    const url = page.url();
    if (flow.expectUrl) outl.push({ kind: "expectUrl", value: flow.expectUrl, held: new RegExp(flow.expectUrl).test(url), actual: url });
    const seen = tnorm(await page.evaluate(`(${SEEN_TEXT})()`));
    for (const x of flow.expect || []) outl.push({ kind: "expect", value: x, held: seen.includes(tnorm(x)) });
    if (flow.expectSeen?.length) {
      const past = tnorm((await page.evaluate(() => window.__jevSeen || [])).join(" "));
      for (const x of flow.expectSeen) outl.push({ kind: "expectSeen", value: x, held: seen.includes(tnorm(x)) || past.includes(tnorm(x)) });
    }
    for (const x of flow.expectAbsent || []) outl.push({ kind: "expectAbsent", value: x, held: !seen.includes(tnorm(x)) });
    for (const x of flow.expectGone || []) outl.push({ kind: "expectGone", value: x, held: !seen.includes(tnorm(x)) });
    if (flow.expectState?.length) {
      const snap = await page.evaluate(`(${SNAPSHOT})()`);
      for (const w of flow.expectState) outl.push({ kind: "expectState", value: w, held: stateOk(snap, [w]) });
    }
  } catch {}
  return outl;
}

async function checkGoal(page, flow, snap) {
  try {
    const urlOk = flow.expectUrl ? new RegExp(flow.expectUrl).test(page.url()) : true;
    if (!urlOk) return false;
    if (await absentSeen(page, flow)) return false;
    // `expect` asserts against what a USER perceives (src/seen-text.js), not raw innerText: form
    // controls contribute nothing (assert them with expectState), hidden/aria-hidden text not at all.
    const need = [...(flow.expect || []), ...(flow.expectSeen || []), ...(flow.expectGone || [])];
    const seen = need.length ? tnorm(await page.evaluate(`(${SEEN_TEXT})()`)) : "";
    if (!(flow.expect || []).every((x) => seen.includes(tnorm(x)))) return false;
    // expectGone: text that must NOT be visible at the end (a deleted row). Unlike expectAbsent it may
    // be on the start page -- that is the point (wave-2 tests B, W1, W3: a delete could not be asserted).
    if ((flow.expectGone || []).some((x) => seen.includes(tnorm(x)))) return false;
    // v1 (audit A5): `expectSeen` passes if the text appeared at ANY moment since the page loaded --
    // for a toast that lives 300 ms, shorter than a step. Recorded by SEEN_RECORDER (init script).
    if (flow.expectSeen?.length) {
      const past = tnorm((await page.evaluate(() => window.__jevSeen || [])).join(" "));
      if (!flow.expectSeen.every((x) => seen.includes(tnorm(x)) || past.includes(tnorm(x)))) return false;
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
  radio: "radio", menuitem: "menuitem", slider: "slider" };
// BAKEOFF: the snapshot stamps inside open shadow roots (Playwright CSS pierces them) and
// same-origin iframes (it does not), so the stamp is looked up in every frame, then the role chain.
// The fallback when the stamped node is gone (a re-render). It acts only on a UNIQUE match: .first() on
// "Delete" after a list re-mounted deleted Row A when the engine chose Row B (security test W6).
const one = async (loc) => { const n = await loc.count(); if (n !== 1) throw new Error(`${n} matches`); return loc; };
async function byRole(scope, action, fn) {
  const role = ARIA[action.role], name = (action.baseLabel || action.label || "").trim();   // v0.4: context suffix is ours, not the page's
  if (role && name) {
    try { await fn(await one(scope.getByRole(role, { name, exact: true })), 1500); return "role"; } catch {}
    try { await fn(await one(scope.getByRole(role, { name })), 1200); return "role~"; } catch {}
  }
  if (name) {
    try { await fn(await one(scope.getByText(name, { exact: true }).filter({ visible: true })), 1200); return "text"; } catch {}
  }
  throw new Error("unresolvable");
}
// v0.4: an action that fails on every strategy is usually blocked by an open popup (a date picker
// left open over the Save button: 14-24 failed clicks on demoqa). Press Escape once and retry.
// An ARIA slider has no value to fill: arrow keys move it one step at a time until aria-valuenow is the
// spec value. Stops (throws) when a key press does not move it or it passes the value. The emitted spec
// carries the same function (codegen SET_SLIDER), so the replay sets it the same way.
export const SET_SLIDER = `async (loc, v) => {
  const want = Number(v), now = async () => Number(await loc.getAttribute("aria-valuenow"));
  for (let i = 0, cur = await now(); i < 500; i++) {
    if (cur === want) return;
    await loc.press(cur < want ? "ArrowRight" : "ArrowLeft");
    const next = await now();
    if (next === cur || (cur < want) !== (next <= want) && next !== want) throw new Error("slider cannot reach " + v);
    cur = next;
  }
  throw new Error("slider cannot reach " + v);
}`;
// eslint-disable-next-line no-new-func
const setSlider = new Function(`return ${SET_SLIDER}`)();
async function act(page, action, fn) {
  try { return await actOnce(page, action, fn); }
  catch (e) {
    // Escape closes an open modal dialog: the user's form and its error message are gone, and the retry
    // then opens an empty one (launch test 2026-10-07). With a modal open, no Escape retry.
    if (await page.evaluate(() => !!document.querySelector("[role=dialog][aria-modal=true], [role=alertdialog], dialog[open]")).catch(() => false)) throw e;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    return (await actOnce(page, action, fn)) + "+esc";
  }
}
async function actOnce(page, action, fn) {
  let first = null;   // the stamped node's own error: "... intercepts pointer events" names an overlay
  for (const f of page.frames()) {
    const byNode = f.locator(`[data-jev-node="${action.node}"]`);
    if (!(await byNode.count().catch(() => 0))) continue;
    try { await fn(byNode, 1200); return f === page.mainFrame() ? "node" : "node@frame"; } catch (e) { first = e; }
    break;
  }
  // A visually hidden checkbox/radio (Chakra, Ark: a 1x1 px input under its styled label) is covered by
  // design: click its label, or dispatch the click on the input itself (launch regression 2026-10-07).
  if (/intercepts pointer events/.test(String(first?.message)) && action.kind === "click") {
    const via = await page.evaluate((node) => {
      const el = document.querySelector(`[data-jev-node="${node}"]`); if (!el) return null;
      const r = el.getBoundingClientRect(), tiny = r.width < 4 || r.height < 4;
      if (!(el.matches("input[type=checkbox], input[type=radio]") || tiny)) return null;
      const lab = el.labels?.[0] || el.closest("label");
      if (lab) { lab.click(); return "label"; }
      el.click(); return "dispatch";
    }, action.node).catch(() => null);
    if (via) return `node+${via}`;
  }
  // The element was found and something lies over it: other locators find the same covered element.
  if (/intercepts pointer events/.test(String(first?.message))) throw Object.assign(new Error("covered"), { first });
  for (const f of page.frames()) { try { return await byRole(f, action, fn); } catch {} }
  throw Object.assign(new Error("unresolvable"), { first });
}
// OVERLAYS (launch test 2026-10-07: a cookie banner over "Sign in" gave 4 failed clicks and a LOOP after
// 33 s, with no word about the banner). When Playwright says another element intercepts the click,
// read that element's text, so the history and the FAIL reason can name it.
async function coverOf(page, action, err) {
  if (!/intercepts pointer events/.test(String(err?.first?.message || err?.message || ""))) return null;
  return page.evaluate((node) => {
    const el = document.querySelector(`[data-jev-node="${node}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || el.contains(top)) return null;
    for (let n = top; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (["fixed", "sticky", "absolute"].includes(cs.position) || n.getAttribute("role") === "dialog") { top = n; break; }
    }
    return String(top.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90) || top.tagName.toLowerCase();
  }, action.node).catch(() => null);
}

export async function runOnce({ flow, engine = "local", budget = 30, browser: shared, trace,
                                base, context: ctxOpts, map, route: routeMode = "click", video,
                                minConfidence: minConfArg, locate = false, navTimeout, startCheck } = {}) {
  base = (flow.base || base || DEFAULT_BASE).replace(/\/$/, "");
  const t0 = performance.now();
  const browser = shared || await chromium.launch({ headless: true });
  const tBrowser = performance.now() - t0;
  // VIDEO (--video dir): Playwright records the viewport; the step record then carries each step's
  // start time and the target's box, so a replay can show what was clicked and when. The video is
  // what the browser showed -- typed values included -- so it is written only when asked for.
  const size = { width: 1280, height: 900 };
  const context = await browser.newContext({ viewport: size,
    ...(video ? { recordVideo: { dir: video, size } } : {}),
    ...(flow.storageState ? { storageState: flow.storageState } : {}), ...(ctxOpts || {}) });
  if (flow.expectSeen?.length) await context.addInitScript(SEEN_RECORDER);
  const page = await context.newPage();
  // WATCHDOG (security test W6): a page script in an endless loop blocks every evaluate, and the run hung
  // for good (maxTimeMs is checked only between steps). At a hard deadline the context is closed: the
  // blocked call fails, and the run ends with TIMEOUT.
  const hardMs = flow.maxTimeMs ? flow.maxTimeMs + 5000 : Number(process.env.QUICKE2E_RUN_TIMEOUT_MS) || 180000;
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; context.close().catch(() => {}); }, hardMs);
  watchdog.unref?.();
  const netQuiet = trackNetwork(page);
  // A 5xx answer to a main-frame navigation is never a result: the run stops with SERVER_ERROR.
  let httpStatus = null, startStatus = null;   // (apiError: see below)
  // A same-origin fetch/XHR that answers 5xx is a server error too: the UI said "Added to cart" while
  // POST /api/cart failed, and the run passed (wave-2 test W2). allowServerErrors: true opts out.
  let apiError = null;
  const appOrigin = (() => { try { return new URL(base).origin; } catch { return null; } })();
  page.on("response", (r) => { try {
    if (!flow.allowServerErrors && r.status() >= 500 && ["fetch", "xhr"].includes(r.request().resourceType()) && new URL(r.url()).origin === appOrigin) {
      httpStatus = r.status(); apiError ??= { method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }; }
  } catch {} });
  page.on("response", (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
    if (r.status() >= 500) httpStatus = r.status();
    // The first main-frame answer: a 401/403 start page (basic auth, no session) is named in the record.
    if (startStatus == null && !(r.status() >= 300 && r.status() < 400)) startStatus = r.status();   // redirects skipped
  } } catch {} });
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
  let startProf = null, firstSnap = null, startStopped = null, unreachable = null, engineStatus = null, coveredBy = null;
  let specIssued = 0, specUsed = 0;   // PERF: speculative decisions (see speculate)
  const specOpen = new Set();          // early calls not used (yet): their cost is added at run end
  let decideMs = 0, inferMs = 0, cost = 0, truncs = 0, routeRec = null, invalidChoice = null, absentHit = null;
  // v0.3 SIDE-EFFECT GUARD: an action the engine picks below this confidence is not executed; it
  // counts as BLOCKED (measured: a refusal test paid at 0.22 once the browser blocked the form).
  const minConfidence = flow.minConfidence ?? minConfArg ?? MIN_CONFIDENCE;
  // Framework dev-tool buttons (dev servers) are never offered: they are not part of the app.
  const DEV_TOOLS = /^(open next\.js dev tools|toggle nuxt devtools|toggle component inspector|open tanstack query devtools|open react query devtools|toggle svelte inspector)$/i;
  const userNever = neverMatcher(flow.neverClick);
  const never = (label) => DEV_TOOLS.test(String(label).trim()) || (userNever ? userNever(label) : false);
  const neverHit = new Set();   // labels neverClick kept from the engine: named when the run fails
  let lastHeldBack = [], lowBest = null;
  // v0.3 LOOP DETECTION: the same action on an unchanged page, again and again, is not progress
  // (measured: 8x the same field, 11x the wrong combobox, 24x an autocomplete). Stop and name it.
  let loopKey = null, loopSig = null, loopN = 0, loopRec = null;
  const seenPairs = new Map();
  // v0.4 NATIVE DIALOGS: without a handler Playwright dismisses every dialog, so "Delete? OK" could
  // never be confirmed and a prompt never got text (demoqa, the-internet). Accept by default
  // (flow.dialog: "dismiss" flips it); a prompt's text comes from the spec key its message names.
  const dialogs = [];
  // network failures (the app died mid-run): named on a FAIL instead of "low confidence" (wave-2 W1)
  const netFails = [];
  page.on("requestfailed", (r) => { try { const f = r.failure()?.errorText || ""; if (!/ERR_ABORTED/.test(f) && netFails.length < 20) netFails.push(f); } catch {} });
  page.on("dialog", async (dlg) => {
    const msg = scrubText(dlg.message().slice(0, 120), flow.inputs);
    const action = flow.dialog === "dismiss" && dlg.type() !== "beforeunload" ? "dismiss" : "accept";
    let key = null;
    if (dlg.type() === "prompt" && action === "accept") key = keyFor(dlg.message(), flow.inputs, "textbox");
    try { if (action === "accept") await dlg.accept(key !== null ? String(flow.inputs[key]) : undefined); else await dlg.dismiss(); } catch {}
    dialogs.push({ type: dlg.type(), message: msg, action, ...(key !== null ? { inputKey: key } : {}) });
    history.push(`${dlg.type()} "${msg.slice(0, 60)}" ${action}ed${key !== null ? " with " + key : ""}`);
  });

  try {
    // v0.4: a slow site needs more than Playwright's 30 s (the-internet's assets stalled ~29 s).
    const nav = flow.navTimeout ?? navTimeout;
    if (nav) page.setDefaultNavigationTimeout(nav);
    const tCtx = performance.now() - t0;
    try { await page.goto(base + (flow.start || "/"), { waitUntil: "domcontentloaded" }); }
    catch (e) { unreachable = String(e.message || e).split("\n")[0]; throw e; }
    // HYDRATION (launch test 2026-10-07): server-rendered buttons do nothing until the app's JS has
    // loaded; with JS ~1 s late, Next and SvelteKit runs clicked dead buttons and stopped with LOOP.
    // The load event comes after the scripts (capped: a slow image must not hold the run).
    await page.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
    if (PROF) startProf = { browser: Math.round(tBrowser), context: Math.round(tCtx - tBrowser), goto: Math.round(performance.now() - t0 - tCtx) };
    // v0.4 AUTH: a flow that brings a login (storageState) but lands on a sign-in page has a missing or
    // expired session. Stop now with a reason; the skill test burned 17 runs' steps on the sign-in page.
    const startPath = new URL(base + (flow.start || "/")).pathname;
    // pathname + hash: hash-routed apps redirect to #/login (launch test 2026-10-07)
    const startHash = new URL(base + (flow.start || "/")).hash, nowUrl = new URL(page.url());
    if (flow.storageState && /(sign[-_]?in|log[-_]?in|auth)/i.test(nowUrl.pathname + nowUrl.hash) && !/(sign[-_]?in|log[-_]?in|auth)/i.test(startPath + startHash)) {
      outcome = "AUTH_REQUIRED";
      error = `the start page redirected to ${nowUrl.pathname}${nowUrl.hash}: the storageState is missing or expired; log in again and save it`;
      throw Object.assign(new Error(error), { authRequired: true });
    }
    // MAP (v1): with a discovered map, Jev first picks the page where the work begins and code
    // walks there. The step loop below then only makes local choices. See src/route.mjs.
    // The decision space of one snapshot, before any tournament. Pure: reads the run state, changes none.
    const spaceFor = (snap) => {
      const here = new URL(snap.url).pathname;
      const stuckLabels = new Set([...stuck].filter((k) => k.startsWith(here + "|")).map((k) => k.split("|").slice(2).join("|")));
      const keyOf = (label, role) => stuckLabels.has(label) ? null : keyFor(label, flow.inputs, role) ?? keyMap.get(label) ?? null;
      return compact(snap, budget, filled, flow.inputs, 3, keyOf, flow.goal, typedKeys, never);
    };
    // The history shown to the model must agree with the page: a field offered for typing again
    // (it was emptied by a reload) is NOT "typed". Measured on the D1 repro: with the stale
    // "typed Email" line the model answered BLOCKED on a page with two empty required fields.
    const historyFor = (space) => {
      const retype = new Set(Object.values(space.targets.TYPE_TEXT || {}).map((a) => `typed ${a.label}`));
      return history.filter((h) => !retype.has(h));
    };
    // FIX (2026-09-21): while a modal listbox/menu is open, its options are the ONLY legal
    // moves -- which is why the snapshot can see nothing else. Offering WAIT/DONE/BLOCKED here
    // makes the model take the escape hatch: measured DONE@0.90, and BLOCKED@0.9997 when DONE
    // was removed. Removing the bad options (rather than instructing against them) gives
    // CLICK@1.00. Same principle as finding #2 in the README.
    // An open LIST (listbox, menu): its options are the only legal moves. An open DIALOG is a page of its
    // own: while its submit is pending the engine needs WAIT (launch test 2026-10-07: with no WAIT in a
    // portal modal it clicked Cancel and lost the server error; create-duplicate 0/3 on Next, Nuxt, Angular).
    const LIST_ROLES = ["option", "menuitem", "menuitemradio", "menuitemcheckbox"];
    const listOpen = (space) => space.all.some((r) => r.a.popup && LIST_ROLES.includes(r.a.role));
    const addMeta = (space, listboxOpen) => {
      // An open list with a choice already made (a multi-select stays open: MUI) can be closed; without
      // this the form behind it was unreachable (launch test 2026-10-07, 0/2). A list with nothing
      // chosen yet gets no escape option (2026-09-21: WAIT/DONE/BLOCKED there were taken over a pick).
      if (listboxOpen) { if (space.all.some((r) => r.a.popup && r.a.role === "option" && r.a.selected)) space.criteria.CLOSE = "close the open list"; return; }
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
    };
    // PERF: SPECULATIVE DECISION. settle() waits for the DOM to be quiet for 150 ms after the action,
    // and the engine call (~300 ms) waits for settle(). The loop now snapshots BEFORE settle(), starts
    // the engine call on that snapshot, settles, snapshots again, and uses the early answer only when
    // the engine input built from the settled snapshot is byte-identical (decisionKey). Otherwise the
    // early answer is discarded and the settled snapshot is decided as before. Only runs where the
    // input is a pure function of the snapshot speculate: no declared redaction (it reads the page),
    // no weak secrets (echo detection keeps per-snapshot history), no field that needs resolveKeys
    // (an engine call that changes keyMap), no tournament.
    // Not on `local`: local-engine/server.py answers one request at a time, so a discarded early call
    // delays the real one by a whole inference (review 2026-10-06).
    const canSpeculate = SPECULATE && engine !== "local" && !weak.length && !flow.redact?.length && !flow.control;   // a load attack never acts
    const needsResolve = (snap) => flow.inputs && snap.actions.some((a) => a.kind === "fill" && !keyMap.has(a.label)
      && keyFor(a.label, flow.inputs, a.role) === null);
    const speculate = async (i) => {
      let s0;
      try { s0 = await page.evaluate(`(${SNAPSHOT})()`); } catch { return null; }
      if (httpStatus || needsResolve(s0)) return null;
      // A snapshot where the run is already over is not worth an engine call.
      if (flow.expectAbsent?.length && await absentSeen(page, flow)) return null;
      if ((i > 0 || routeRec?.hops?.length || flow.control) && await checkGoal(page, flow, s0)) return null;
      const sp = spaceFor(s0);
      if (sp.dropped > 0) return null;
      addMeta(sp, listOpen(sp));
      const goal = redactGoal(flow.goal, flow.inputs, []), hist = historyFor(sp);
      const key = decisionKey(sp, s0, goal, hist);
      const pending = decide(sp, s0, goal, hist, engine, flow.inputs, [], flow.redact);
      pending.catch(() => {});
      specIssued++; specOpen.add(pending);
      return { key, pending };
    };
    // PERF: START CHECK in the run's own first page load (the CLI's weak() used a second context and a
    // second load of the start page). `startCheck({ at, weak, absent })` sees the same facts weak()
    // computed: the assertion on the settled start page with no text recorded before it (weak()'s
    // __jevSeen was empty, so expectSeen counts only as on-screen text), and expectAbsent text on it.
    // It returns true to stop the run. The settled snapshot is step 1's snapshot when no map moves the page.
    if (startCheck && !flow.control) {
      await netQuiet();
      // No early engine call here: a flow the start check stops must not send page content or cost a call
      // (review 2026-10-06). Step 1 is decided on this settled snapshot.
      await settle(page);
      firstSnap = await page.evaluate(`(${SNAPSHOT})()`);
      const now = { ...flow, expect: [...(flow.expect || []), ...(flow.expectSeen || [])], expectSeen: undefined };
      const w = { at: flow.start || "/", weak: await checkGoal(page, now, firstSnap), absent: await absentSeen(page, flow, { loose: true }) };
      if (await startCheck(w)) { outcome = w.absent ? "ABSENT_ON_START" : "WEAK_ASSERTION"; startStopped = w; throw Object.assign(new Error("start check"), { startStop: true }); }
      if (map && routeMode) firstSnap = null;
    }
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
          : await walk(page, r, t.target, never);
        else routeRec.unreachable = true;
      }
      routeRec.ms = Math.round(performance.now() - t0);
    }
    let freeWaits = 0;
    for (let i = 0; i < (flow.maxSteps || 14); i++) {
      // v0.4 time budget per flow
      if (flow.maxTimeMs && performance.now() - t0 > flow.maxTimeMs) { outcome = "TIMEOUT"; break; }
      let snap;
      const at = Math.round(performance.now() - t0);
      const pf = PROF ? {} : null; let tl = performance.now();
      const lap = PROF ? (k) => { const n = performance.now(); pf[k] = (pf[k] || 0) + (n - tl); tl = n; } : () => {};
      const reuse = i === 0 && firstSnap;
      const spec = reuse ? null : canSpeculate ? await speculate(i) : null;
      lap("speculate");
      if (reuse) snap = firstSnap;
      else {
        await settle(page); lap("settle");
        try { snap = await page.evaluate(`(${SNAPSHOT})()`); }
        catch { await page.waitForTimeout(150); snap = await page.evaluate(`(${SNAPSHOT})()`); }
      }
      lap("snapshot");
      if (userNever) for (const a of snap.actions) if (a.kind === "click" && userNever(a.label)) neverHit.add(a.label);
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
      lap("redact");
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
      // ATTACK CASES: an `expectAbsent` text on the page means the app ACCEPTED what it must refuse.
      // Stop here: the run is a finding, and wandering on to MAX_STEPS would read as "got lost".
      lap("weakScrub");
      if (httpStatus) { outcome = "SERVER_ERROR"; break; }
      if ((absentHit = await absentSeen(page, flow))) { outcome = "ABSENT_SEEN"; break; }
      // With `control`, loading the start URL IS the action (another user's order), so step 0 counts.
      lap("absent");
      if ((i > 0 || routeRec?.hops?.length || flow.control) && await checkGoal(page, flow, snap)) { outcome = "DONE_VERIFIED"; break; }
      // A load attack (control): loading the start URL IS the attack, so it is decided on that page. The
      // run used to keep clicking and passed on a linked page that said "Nothing here" while the start
      // URL had leaked the order (wave-2 test W4). Never act on a control flow.
      if (flow.control && i === 0 && !routeRec?.hops?.length) { outcome = "NOT_REFUSED"; break; }
      lap("checkGoal");

      // FIX (v1, TicketBay D2): a field whose label contains no spec key (a rename: "Email" ->
      // "E-mail") used to be invisible to the test. Jev now picks WHICH spec key belongs in it --
      // a typed choice over the keys, so the text still comes only from the spec. Once per label.
      if (flow.inputs) await resolveKeys(snap, flow.inputs, keyMap, engine, (c) => { cost += c; }, flow.redact);
      lap("resolveKeys");
      let space = spaceFor(snap);
      lap("compact");
      lastHeldBack = space.heldBack;
      const listboxOpen = listOpen(space);
      const shownHistory = () => historyFor(space);
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
      addMeta(space, listboxOpen);

      const goalNow = redactGoal(flow.goal, flow.inputs, keepWeak);
      let d = null;
      if (spec) {
        if (!heats && spec.key === decisionKey(space, snap, goalNow, shownHistory())) {
          d = await spec.pending.catch(() => null);   // a failed early call is retried below, as before
          if (d) { specUsed++; specOpen.delete(spec.pending); }
        }
        // A discarded early call still cost money: it stays in specOpen and is added at run end.
      }
      if (!d) d = heats?.decided ? { ...heats.decided, truncated: false }
        : await decide(space, snap, goalNow, shownHistory(), engine, flow.inputs, [], flow.redact);
      if (heats) delete heats.decided;
      if (PROF) { const now = performance.now(); pf.decide = now - tl; tl = now;
        if (d.prepMs != null) { pf.decidePrep = d.prepMs; pf.decideNet = d.ms; }
        if (d.net) { pf.ttfb = d.net.ttfb; pf.body = d.net.body; pf.tries = d.net.tries; } }
      // The engine must return one of OUR keys. Anything else is treated as BLOCKED, never acted on.
      if (!(d.choice in space.criteria)) { invalidChoice = d.choice; d.choice = "BLOCKED"; }
      decideMs += d.ms; inferMs += d.inferMs || 0; cost += d.cost;
      // Loud, because a silent truncation means the model never saw options we believe we offered.
      if (d.truncated) { truncs++; console.warn(`[truncated] ${flow.name} step ${i + 1}: the engine `
        + `discarded options past the ${LETTER_CEILING}-letter ceiling -- the model did not see them`); }

      let op = d.choice, tIdx = null, action = null, low = null;
      if (!["WAIT", "DONE", "BLOCKED", "CLOSE"].includes(op)) {
        const [o, ix] = String(d.choice).split(":");
        op = o; tIdx = ix; action = space.targets[o]?.[ix];
        if (!action) op = "BLOCKED";
        // Typing a spec value, or choosing the option the spec names, has no side effect: these picks are
        // not gated. On a long form every pending spec field is a right next step, so the engine's
        // probability splits and the top pick fell to 0.26-0.28, below the gate (wave-2 test W5: 0/2 ->
        // with the gate lowered 2/2). Clicks, which can buy, pay or delete, stay gated.
        else if (d.confidence != null && d.confidence < minConfidence
          && !(op === "TYPE_TEXT" && specValue(flow, action, keyMap) != null)
          && !(op === "SELECT" && keyFor(action.selectLabel, flow.inputs || {}, "combobox") !== null)) {
          low = { op, label: action.label, confidence: Math.round(d.confidence * 100) / 100 };
          if (!lowBest || low.confidence > lowBest.confidence) lowBest = low;
          op = "BLOCKED"; action = null; tIdx = null;
        }
      }
      // CODEGEN (2026-09-22): `role` and `tag` added. act() already resolves by
      // getByRole(ARIA[action.role], {name: action.label}) at line 232 -- but the step record
      // kept only the label, so a trace could not reproduce the locator act() itself used.
      // `tag` distinguishes a native <select> combobox from a <button role=combobox> trigger,
      // which need different assertions (toHaveValue vs toContainText).
      const step = { n: i + 1, at, decidedAt: Math.round(performance.now() - t0), url: snap.url, op, target: tIdx, label: action?.label ?? null,
        role: action?.role ?? null, tag: action?.tag ?? null, ...(action?.itype === "file" ? { file: true } : {}),
        confidence: d.confidence, ms: Math.round(d.ms), inferMs: d.inferMs, tokens: d.tokens,
        options: Object.keys(space.criteria).length, dropped: space.dropped, truncated: d.truncated,
        ...(low ? { lowConfidence: low } : {}),
        ...(space.heldBack?.length ? { heldBack: space.heldBack } : {}),
        // what the engine could choose from, for the trace (labels already scrubbed)
        ...(trace ? { offered: Object.values(space.criteria).slice(0, 120) } : {}),
        ...(heats ? { tournament: heats } : {}) };

      // LOOP: same op on the same element while the page looks exactly as it did the last time.
      if (action && op !== "WAIT") {
        const key = `${op}|${action.label}|${tIdx}`;
        const sig = pageSig(snap);
        loopN = key === loopKey && sig === loopSig ? loopN + 1 : 1;
        loopKey = key; loopSig = sig;
        // An A-B-A-B oscillation (Next / Search on page 3; open and close a menu) never repeats one action
        // back to back: count each (page, action) pair over the run (wave-2 tests W2, W5).
        const pair = `${sig}|${key}`; seenPairs.set(pair, (seenPairs.get(pair) || 0) + 1);
        if (seenPairs.get(pair) >= LOOP_LIMIT && loopN < LOOP_LIMIT) loopN = LOOP_LIMIT;
        if (loopN >= LOOP_LIMIT) {
          loopRec = { op, label: action.label, times: loopN - 1 };   // executed; the next one was stopped
          step.loop = true; steps.push(step); outcome = "LOOP"; break;
        }
      }

      if (op === "CLOSE") {
        await page.keyboard.press("Escape").catch(() => {});
        history.push("closed the list");
        await settle(page);
        step.wallAt = Math.round(performance.now() - t0); steps.push(step); continue;
      }
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
      if (PROF) tl = performance.now();
      // v0.4: a locator verified on the live page, for --emit (src/locate.mjs). Before the action:
      // after a click the element is often gone.
      if (locate && action) {
        const { verifiedLocator } = await import("./locate.mjs");
        const loc = await verifiedLocator(page, `[data-jev-node="${op === "SELECT" ? action.selectNode : action.node}"]`);
        if (loc) step.locator = loc;
        if (action.targetNode) {
          const tl = await verifiedLocator(page, `[data-jev-node="${action.targetNode}"]`);
          if (tl) step.targetLocator = tl;
        }
      }
      if (video && action) {
        const b = await page.locator(`[data-jev-node="${op === "SELECT" ? action.selectNode : action.node}"]`).first()
          .boundingBox({ timeout: 300 }).catch(() => null);
        if (b) step.box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      }
      if (op === "TYPE_TEXT") {
        const v = specValue(flow, action, keyMap);
        if (v === null) { step.noSpecValue = true; steps.push(step); outcome = "NO_SPEC_VALUE"; break; }
        step.inputKey = specKey(flow, action, keyMap);   // CODEGEN: the key, never the value
        const ariaSlider = action.role === "slider" && action.tag !== "input";
        // A file input takes a file path from the spec (relative to the working folder).
        const file = action.itype === "file";
        // one path or a list of paths (a multi-file input), relative to the working folder
        const files = file ? (Array.isArray(v) ? v : [v]).map((x) => path.resolve(String(x))) : null;
        const missing = files?.find((x) => !fs.existsSync(x));
        if (missing) { step.stale = true; step.missingFile = missing; steps.push(step);
          history.push(`stale ${action.label}`); stuck.add(fillKey(snap.url, action)); continue; }
        try { step.via = await act(page, action, ariaSlider ? (loc) => setSlider(loc, v)
          : file ? (loc, t) => loc.setInputFiles(files, { timeout: t }) : (loc, t) => loc.fill(String(v), { timeout: t })); lap("act"); }
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
        // v0.4: typing into a date field opens a calendar that stays open and covers later fields
        // (demoqa practice form: every later click failed). After typing into a plain field (not an
        // autocomplete, whose menu is the point), close such a popup the way a user does: Tab.
        if (action.role !== "combobox") {
          lap("act");
          const popupOpen = await page.evaluate(() => [...document.querySelectorAll(
            "[class*=datepicker i], [class*=calendar i], [class*=popper i], [role=dialog][aria-modal=true], [role=grid]")]
            .some((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
              return r.width > 40 && r.height > 40 && cs.visibility !== "hidden" && cs.display !== "none"; })).catch(() => false);
          if (popupOpen) { await page.keyboard.press("Tab").catch(() => {}); step.closedPopup = true; }
          lap("popupCheck");
        }
      } else if (op === "PRESS_ENTER") {
        try { step.via = await act(page, action, (loc, t) => loc.press("Enter", { timeout: t })); lap("act"); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        history.push(`pressed Enter in ${action.label}`);
        await page.waitForTimeout(150);
      } else if (op === "SELECT") {
        try { step.via = await act(page, { ...action, node: action.selectNode, label: action.selectLabel, role: "combobox" },
          (loc, t) => loc.selectOption({ label: action.optionLabel }, { timeout: t })); lap("act"); }
        catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        step.option = action.optionLabel; step.control = action.selectLabel;
        history.push(`selected ${action.label}`);
      } else if (op === "HOVER" || op === "DRAG") {
        // v0.4: hover reveals hidden text; drag moves a source onto a target (Playwright mouse moves,
        // which both HTML5 drag-and-drop and mouse-event libraries such as jQuery UI receive).
        try {
          const src = page.locator(`[data-jev-node="${action.node}"]`).first();
          if (op === "HOVER") { await src.hover({ timeout: 1500 }); step.via = "node"; }
          else { await src.dragTo(page.locator(`[data-jev-node="${action.targetNode}"]`).first(), { timeout: 3000 }); step.via = "node"; }
        } catch { step.stale = true; steps.push(step); history.push(`stale ${action.label}`); continue; }
        history.push(`${op === "HOVER" ? "hovered" : "dragged"} ${action.label}`);
        await page.waitForTimeout(200);
      } else if (op === "CLICK") {
        let clickErr = null;
        // The element actually resolved must not match neverClick either (a fallback could resolve a
        // different element than the one chosen; security test W6).
        const guarded = async (loc, t) => {
          const name = await loc.evaluate((el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").trim()).catch(() => "");
          if (name && never(name)) throw new Error("neverClick");
          return loc.click({ timeout: t });
        };
        try { step.via = await act(page, action, guarded); lap("act"); }
        catch (e) { clickErr = e; }
        // The field's own floating label over its trigger (Angular Material mat-select: <mat-label>
        // intercepts the click; launch test 2026-10-07, LOOP 0/4): when what lies over the target is a
        // non-control inside the target's own field wrapper, the click is meant for the target.
        if (clickErr && /intercepts pointer events/.test(String(clickErr.first?.message || clickErr.message)) && await page.evaluate((node) => {
          const el = document.querySelector(`[data-jev-node="${node}"]`); if (!el) return false;
          const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!top || top.closest("button, a[href], input, select, textarea, [role=button], [role=dialog]")) return false;
          // the shared wrapper must be the field itself: a box at most ~6x the target (never <body>, which
          // also holds a cookie banner)
          for (let p = el.parentElement, d = 0; p && d < 5 && p !== document.body; p = p.parentElement, d++) {
            const q = p.getBoundingClientRect();
            if (q.width * q.height > 6 * Math.max(1, r.width * r.height)) return false;
            if (p.contains(top)) return true;
          }
          return false;
        }, action.node).catch(() => false)) {
          try { await page.locator(`[data-jev-node="${action.node}"]`).first().click({ force: true, timeout: 1500 }); step.via = "node+force"; clickErr = null; } catch {}
        }
        if (clickErr) {
          const e = clickErr;
          step.stale = true;
          const cover = await coverOf(page, action, e);
          if (cover) { step.coveredBy = cover; coveredBy = { label: action.label, by: cover }; }
          steps.push(step);
          history.push(cover ? `"${action.label}" is covered by "${cover}": deal with that first` : `stale ${action.label}`);
          continue;
        }
        // FIX (2026-09-21): a link click starts a navigation that has not begun yet when we
        // re-snapshot. READY is true on the OLD page and settle() sees a DOM that is quiet only
        // because nothing has happened, so the loop re-reads the old page and clicks the same link
        // again. Measured after links were promoted to rank 1: "New campaign" clicked TEN times,
        // burning 10 of 22 steps and failing create-campaign 0/5. Only links pay this wait.
        if (action.role === "link") {
          await page.waitForURL((u) => u.toString() !== before, { timeout: 1200 }).catch(() => {});
          lap("linkWait");
        }
        history.push(`clicked ${action.label}`);
      } else {
        await Promise.race([
          page.waitForURL((u) => u.toString() !== before, { timeout: 2500 }),
          page.waitForFunction(READY, null, { timeout: 2500, polling: 50 }),
        ]).catch(() => {});
        history.push("waited");
      }
      lap("act");
      if (op !== "TYPE_TEXT") await page.waitForFunction(READY, null, { timeout: 4000, polling: 50 }).catch(() => {});
      lap("readyWait");
      if (PROF) step.prof = Object.fromEntries(Object.entries(pf).map(([k, v]) => [k, Math.round(v * 10) / 10]));
      step.wallAt = Math.round(performance.now() - t0);
      steps.push(step);
      // v0.4: waiting for a slow page is not a step toward the goal (dynamic loading needed maxSteps 25)
      if (op === "WAIT" && freeWaits < MAX_FREE_WAITS) { freeWaits++; i--; }

    }
    if (outcome === "UNKNOWN") outcome = "MAX_STEPS";
  } catch (e) { if (!e.authRequired && !e.startStop) { error = String(e.message || e).slice(0, 180); outcome = e.engine ? "ENGINE_ERROR" : "ERROR";
    if (e.engine) engineStatus = e.status; } }
  clearTimeout(watchdog);
  if (timedOut) { outcome = "TIMEOUT"; error = `the page did not answer for ${Math.round(hardMs / 1000)} s (a script in an endless loop?); the browser context was closed`; }

  const tLoopEnd = performance.now() - t0;
  if (httpStatus && !["ERROR", "ENGINE_ERROR"].includes(outcome)) outcome = "SERVER_ERROR";
  let passed = outcome !== "SERVER_ERROR" && !startStopped && await checkGoal(page, flow);
  // NO ACTION, NO PASS (launch test 2026-10-07, false pass on OrangeHRM): the start check read the page
  // while a SPA still showed its spinner; the form then rendered with a " * Required" footnote, and the
  // run passed after 11 WAITs without one action. Assertions that hold before the run did anything
  // prove nothing. A `control` flow is exempt: there, loading the start URL IS the attack.
  const acted = steps.some((st) => !["WAIT", "BLOCKED", "DONE"].includes(st.op) && !st.stale && !st.loop) || routeRec?.hops?.length;
  if (passed && !acted && !flow.control) { passed = false; outcome = "WEAK_ASSERTION";
    error = "the assertions held before any action: they do not prove the goal (the page reached this state by itself)"; }
  // A success marker that appeared after the last step is still a finding, not "got lost".
  if (!absentHit && !startStopped && !["ERROR", "ENGINE_ERROR", "SERVER_ERROR"].includes(outcome) && (absentHit = await absentSeen(page, flow))) outcome = "ABSENT_SEEN";
  const tCheck = performance.now() - t0;
  const finalUrl = page.url();
  // v0.3: say WHY. Per-assertion results always; the rest only when the run failed.
  const assertions = await explainGoal(page, flow);
  // REASONS (wave-2 tests W1, W3): what the spec gave that the run never used, the fields it had no
  // value for, what the page itself says is wrong, and a select value that matches no option.
  const used = new Set(steps.map((x) => x.inputKey).filter(Boolean));
  for (const x of steps) if (x.op === "SELECT" && x.control) { const k = keyFor(x.control, flow.inputs || {}, "combobox"); if (k) used.add(k); }
  const unusedInputs = Object.keys(flow.inputs || {}).filter((k) => !used.has(k));
  let endSnap = null;
  try { endSnap = await page.evaluate(`(${SNAPSHOT})()`); } catch {}
  const unkeyedFields = passed || !endSnap ? [] : [...new Set(endSnap.actions.filter((a) => a.kind === "fill" && !a.secret && !norm(a.value)
    && keyFor(a.label, flow.inputs || {}, a.role) === null && !keyMap.get(a.label)).map((a) => a.label))].slice(0, 6);
  const unmatchedOptions = [];
  if (endSnap) for (const st of endSnap.actions.filter((a) => a.kind === "state" && a.tag === "select")) {
    const k = keyFor(st.label, flow.inputs || {}, "combobox"); if (k === null) continue;
    const opts = endSnap.actions.filter((a) => a.kind === "select" && a.selectLabel === st.label).map((a) => a.optionLabel);
    const want = norm(flow.inputs[k]).toLowerCase();
    if (opts.length && !opts.some((o) => norm(o).toLowerCase() === want)) unmatchedOptions.push({ key: k, value: String(flow.inputs[k]), field: st.label, options: opts.slice(0, 8) });
  }
  const pageErrors = passed ? [] : await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true })); };
    const out = [];
    for (const el of document.querySelectorAll("[role=alert], [aria-live=assertive], [aria-live=polite], [role=status]"))
      if (vis(el)) { const t = el.innerText.replace(/\s+/g, " ").trim(); if (t && t.length < 200) out.push(t); }
    for (const f of document.querySelectorAll("[aria-invalid=true]")) {
      const ids = (f.getAttribute("aria-errormessage") || f.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      for (const id of ids) { const e = document.getElementById(id); const t = e && vis(e) ? e.innerText.replace(/\s+/g, " ").trim() : ""; if (t) out.push(t); }
    }
    return [...new Set(out)].slice(0, 4);
  }).catch(() => []);
  const emptyRequired = passed ? [] : await page.evaluate(() => [...document.querySelectorAll(
    "input[required],select[required],textarea[required],[aria-required=true]")]
    .filter((el) => el.offsetParent !== null && !String(el.value ?? "").trim() && el.type !== "hidden")
    .map((el) => (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "").trim().slice(0, 40))
    .filter(Boolean)).catch(() => []);
  const videoFile = video ? await page.video()?.path() : null;
  await context.close();
  if (!shared) await browser.close();
  const rec = { flow: flow.name, ...(flow.kind ? { kind: flow.kind } : {}), base, engine, budget, outcome, passed, finalUrl, error,
    ...(absentHit ? { absentSeen: absentHit } : {}), ...(httpStatus ? { httpStatus } : {}), ...(apiError ? { apiError } : {}), ...(engineStatus != null ? { engineStatus } : {}), ...(startStatus >= 400 ? { startStatus } : {}), steps,
    ...(routeRec ? { route: routeRec } : {}), ...(invalidChoice ? { invalidChoice } : {}),
    decideMs: Math.round(decideMs), inferMs: Math.round(inferMs), cost, truncations: truncs,
    doneRejects, wallMs: Math.round(performance.now() - t0),
    ...(video ? { video: { file: videoFile, at: videoAt, size } } : {}),
    assertions,
    ...(dialogs.length ? { dialogs } : {}),
    // v0.4: actions that took over SLOW_MS from decision to settled page (performance_glitch_user: 5.4 s)
    ...(() => { const slow = steps.filter((x) => x.wallAt != null && x.decidedAt != null && x.wallAt - x.decidedAt > SLOW_MS)
      .map((x) => ({ n: x.n, op: x.op, label: x.label, ms: x.wallAt - x.decidedAt })); return slow.length ? { slowSteps: slow } : {}; })(),
    ...(!passed ? {
      ...(neverHit.size ? { neverHidden: [...neverHit].slice(0, 5) } : {}),
      ...(pageErrors.length ? { pageErrors } : {}), ...(unkeyedFields.length ? { unkeyedFields } : {}),
      ...(netFails.length ? { networkErrors: [...new Set(netFails)].slice(0, 3), networkErrorCount: netFails.length } : {}),
      ...(coveredBy ? { coveredBy } : {}),
      ...(loopRec ? { loop: loopRec } : {}),
      ...(lastHeldBack?.length ? { heldBack: lastHeldBack } : {}),
      ...(lowBest && outcome === "MODEL_BLOCKED" ? { lowConfidence: lowBest, minConfidence } : {}),
      failedActions: [...new Map(steps.filter((x) => x.stale).map((x) => [`${x.op}|${x.label}`, { op: x.op, label: x.label }])).values()],
      emptyRequired,
    } : {}),
    tLoopEnd: Math.round(tLoopEnd), tCheck: Math.round(tCheck),
    ...(unusedInputs.length ? { unusedInputs } : {}), ...(unmatchedOptions.length ? { unmatchedOptions } : {}),
    ...(startStopped ? { startCheck: startStopped } : {}), ...(unreachable ? { unreachable } : {}),
    ...(specIssued ? { speculative: { used: specUsed, wasted: specIssued - specUsed } } : {}), ...(startProf ? { startProf } : {}) };
  // SECURITY (audit): the trace on disk is scrubbed too -- a GET form puts a password in finalUrl.
  rec.weakEchoed = echoed();
  // Labels in the record were scrubbed at the source; a weak value can still sit in a URL's QUERY
  // (a GET form), so queries get the weak scrub too -- paths stay intact for codegen's toHaveURL.
  const q = (u) => { if (!u || !rec.weakEchoed.length) return u; const i = u.indexOf("?");
    return i < 0 ? u : u.slice(0, i) + scrubText(u.slice(i), flow.inputs, { weakKeys: rec.weakEchoed }); };
  rec.finalUrl = redactUrl(q(rec.finalUrl));
  // the same scrub for the URL an expectUrl assertion reports as "actual" (a weak password in a GET
  // login query reached the FAIL line and --json: security test W6)
  for (const a of rec.assertions || []) if (typeof a.actual === "string") a.actual = redactUrl(q(a.actual));
  for (const st of rec.steps) { st.url = redactUrl(q(st.url)); if (st.label) st.label = String(st.label); }
  // Every early call that was not used still cost money, including one sent on the last step, before
  // the goal check ended the run (review 2026-10-06: that one was missing from rec.cost).
  for (const r of await Promise.allSettled([...specOpen])) if (r.status === "fulfilled") rec.cost += r.value?.cost || 0;
  // SECURITY (launch test 2026-10-07): the returned record is scrubbed too, not only the trace file. The
  // CLI prints it (--json, the FAIL reason lines), and CI logs keep stdout: a GET login form put the
  // password in finalUrl, and a page that echoed it put it in a step label.
  // Basic-auth credentials in the base URL (http://user:pass@host) never leave the run: not in the record,
  // the trace, or the emitted spec built from it (launch test: the emitted spec had them in BASE).
  const noCreds = (u) => typeof u === "string" ? u.replace(/(https?:\/\/)[^\/\s"]*@/gi, "$1") : u;   // a password may contain "@"
  rec.base = noCreds(rec.base); rec.finalUrl = noCreds(rec.finalUrl);
  for (const st of rec.steps) st.url = noCreds(st.url);
  for (const a of rec.assertions || []) if (typeof a.actual === "string") a.actual = noCreds(a.actual);
  // A verified locator is built from the live accessible name, after redaction ran on the snapshot: it
  // can hold text the spec declared with `redact`. Drop it; codegen then uses the redacted label's
  // stable prefix (security test W6: "Copy code ZX81-QQ42-7781" reached the emitted spec and the trace).
  const redactRx = (flow.redact || []).filter((r) => r instanceof RegExp);
  if (redactRx.length) for (const st of rec.steps) if (st.locator?.code && redactRx.some((r) => { r.lastIndex = 0; return r.test(st.locator.code); })) delete st.locator;
  const out = scrub(rec, flow.inputs);
  out.flow = flow.name;   // the spec's own name: a secret's partial-echo rule mangled "juice-login-wrong-password"
  if (trace) try { fs.writeFileSync(trace, JSON.stringify(out, null, 2)); } catch (e) { console.warn(`[trace] not written: ${e.message}`); }
  return out;
}

export { SEEN_RECORDER };
export { compact, redactGoal, stateOk, chromium, SNAPSHOT, SEEN_TEXT, settle, act, keyFor, norm, checkGoal, absentSeen, explainGoal, ARIA, LETTER_CEILING,
  neverMatcher, pageSig, MIN_CONFIDENCE, LOOP_LIMIT };
