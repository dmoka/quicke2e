#!/usr/bin/env node
// quicke2e CLI. Run `quicke2e --help` or `quicke2e <command> --help`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import module from "node:module";
// PERF: V8 code cache for Playwright's modules (Node >= 22.1; ~50 ms per start once the cache is warm).
// It must be on before the first import of playwright, so the loop is imported dynamically.
module.enableCompileCache?.();
const { chromium, runOnce, SNAPSHOT, settle, checkGoal, absentSeen, trackNetwork } = await import("../src/loop.mjs");

const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Every printed line: no credentials from a URL (http://user:pass@host, a password may contain "@"), and
// no terminal control characters from page text (a label with ESC sequences could rewrite a FAIL line
// as PASS on screen: security test W6).
const hideCreds = (t) => String(t ?? "").replace(/(https?:\/\/)[^\/\s"]*@/gi, "$1");
const cleanLine = (t) => hideCreds(t).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const out = (s = "") => process.stdout.write(cleanLine(s) + "\n");
const die = (msg, code = 2) => { process.stderr.write(msg + "\n"); process.exit(code); };
const stripAnsi = (t) => String(t ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// Every command has a fixed set of flags. An unknown flag is an error, never ignored: a typo such as
// --bse used to fall back to localhost:3000 and send an unrelated local app's pages to the engine.
// value = takes the next argument; bool = a switch; many = may repeat.
const COMMON = { "--headed": "bool", "--headless": "bool", "--help": "bool", "-h": "bool" };
const COMMANDS = {
  discover: { args: "<baseUrl>", about: "crawl the app and write a map of pages, links and forms",
    flags: { "--start": "value", "--safe": "bool", "--i-own-this-data": "bool", "--reset": "value", "--inputs": "value",
      "--storage": "value", "-o": "value", "--redact": "many", "--max-pages": "value" } },
  run: { args: "<spec.mjs>", about: "run the flows in a spec file",
    flags: { "--base": "value", "--engine": "value", "--map": "value", "--runs": "value", "--emit": "value", "--trace": "value",
      "--video": "value", "--allow-weak": "bool", "--only": "value", "--json": "bool", "--min-confidence": "value",
      "--nav-timeout": "value", "--reset": "value" } },
  check: { args: "<spec.mjs>", about: "validate specs against the running app (no engine call)",
    flags: { "--base": "value", "--only": "value", "--json": "bool" } },
};
const HELP = {
  "--start": "comma-separated start paths (default /)", "--safe": "safe crawl: never submits a form",
  "--i-own-this-data": "allow a full crawl on a host other than localhost", "--reset": "shell command that restores seed data (discover: before the crawl; run: before every run)",
  "--inputs": "JSON file with form values for the crawl", "--storage": "Playwright storage-state file (logged-in crawl)",
  "-o": "output map file (default quicke2e.map.json)", "--redact": "CSS selector or /regex/ the engine must never see (repeatable)",
  "--max-pages": "page limit (default 40)", "--base": "app base URL (default $APP_BASE, then http://localhost:3000)",
  "--engine": "jev (default, needs OPENROUTER_API_KEY) | vercel (AI_GATEWAY_API_KEY) | local (local-engine/server.py from the GitHub repo, not in the npm package)",
  "--map": "map file from discover", "--runs": "runs per flow (default 1)", "--emit": "write a Playwright spec for each passing run",
  "--trace": "write a JSON trace per run", "--video": "save a WebM recording per run",
  "--allow-weak": "run a flow that failed the WEAK_ASSERTION check", "--only": "run only the flow with this name",
  "--json": "print all records as one JSON array on the last line of stdout",
  "--min-confidence": "an action the engine picks below this confidence is not executed (default 0.3; a flow's minConfidence overrides)",
  "--headed": "show the browser", "--headless": "hide the browser",
  "--nav-timeout": "page-load timeout in ms (default 30000; a flow's navTimeout overrides)",
};
const usageText = (c) => {
  if (c && COMMANDS[c]) {
    const fl = Object.keys(COMMANDS[c].flags).concat(["--headed", "--headless"]);
    return `quicke2e ${c} ${COMMANDS[c].args}: ${COMMANDS[c].about}\n\n` + fl.map((f) => `  ${f.padEnd(18)} ${HELP[f] || ""}`).join("\n");
  }
  return `quicke2e ${PKG.version}: plain-English end-to-end tests\n\nUsage:\n`
    + Object.entries(COMMANDS).map(([k, v]) => `  quicke2e ${k.padEnd(9)} ${v.args.padEnd(10)} ${v.about}`).join("\n")
    + `\n\n  quicke2e <command> --help   flags of one command\n  quicke2e --version\n\nDocs: https://github.com/dmoka/quicke2e`;
};
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const closest = (x, list) => list.map((c) => [lev(x, c), c]).sort((p, q) => p[0] - q[0]).find(([n]) => n <= 3)?.[1];

const raw = process.argv.slice(2);
if (raw[0] === "--version" || raw[0] === "-v") { out(PKG.version); process.exit(0); }
if (raw[0] === "help" && COMMANDS[raw[1]]) { out(usageText(raw[1])); process.exit(0); }   // "quicke2e help run"
if (!raw.length || raw[0] === "--help" || raw[0] === "-h" || raw[0] === "help") { out(usageText()); process.exit(raw.length ? 0 : 2); }
const cmd = raw[0];
if (!COMMANDS[cmd]) {
  const s = closest(cmd, Object.keys(COMMANDS));
  die(`unknown command "${cmd}".${s ? ` Did you mean "${s}"?` : ""}\n\n${usageText()}`);
}
const known = { ...COMMANDS[cmd].flags, ...COMMON };
const opts = {}, many = {}, positional = [];
for (let i = 1; i < raw.length; i++) {
  let a = raw[i];
  if (!a.startsWith("-") || a === "-") { positional.push(a); continue; }
  // --base=http://x works like --base http://x
  const eq = a.startsWith("--") ? a.indexOf("=") : -1;
  if (eq > 0 && known[a.slice(0, eq)] && known[a.slice(0, eq)] !== "bool") { raw.splice(i + 1, 0, a.slice(eq + 1)); a = a.slice(0, eq); }
  const kind = known[a];
  if (!kind) {
    const s = closest(a, Object.keys(known));
    die(`unknown option "${a}" for "quicke2e ${cmd}".${s ? ` Did you mean "${s}"?` : ""}\nRun "quicke2e ${cmd} --help" for the list.`);
  }
  if (kind === "bool") { opts[a] = true; continue; }
  const v = raw[i + 1];
  if (v == null || (v.startsWith("-") && known[v])) die(`option "${a}" needs a value.`);
  i++;
  if (kind === "many") (many[a] ||= []).push(v); else opts[a] = v;
}
if (opts["--help"] || opts["-h"]) { out(usageText(cmd)); process.exit(0); }
if (positional.length !== 1) die(`quicke2e ${cmd} needs exactly one ${COMMANDS[cmd].args}${positional.length ? `, got: ${positional.join(" ")}` : ""}.\n\n${usageText(cmd)}`);
const opt = (name, dflt) => (name in opts ? opts[name] : dflt);
const flag = (name) => Boolean(opts[name]);
// Headed when a person runs it (interactive terminal, a display available); headless in CI, with no
// display, or when the output is piped. --headed / --headless force either.
const headless = flag("--headless") ? true : flag("--headed") ? false
  : Boolean(process.env.CI) || !process.stdout.isTTY
    || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

// Launch once, with a one-line fix when Playwright's browser is missing.
async function launch() {
  try { return await chromium.launch({ headless }); }
  catch (e) {
    const m = stripAnsi(e.message || e);
    if (/Executable doesn't exist|npx playwright install/i.test(m)) die("Chromium is not installed for Playwright. Run: npx playwright install chromium");
    throw e;
  }
}

// SPEC VALIDATION (launch test 2026-10-07). A string where an array belongs was read character by
// character (expect "Your todos" became 10 one-letter assertions, all held); expectAbsent as a string was
// ignored, so an attack spec could never find the attack; a misspelled "expected" left a flow with no
// assertion at all; start as a full URL failed as "Is the app running?". Catch them before any run.
const FIELDS = ["name", "start", "base", "goal", "inputs", "expectUrl", "expect", "expectState", "expectSeen", "expectAbsent", "expectGone",
  "control", "kind", "redact", "storageState", "maxSteps", "neverClick", "minConfidence", "dialog", "navTimeout", "maxTimeMs", "done",
  "allowServerErrors"];
function specProblems(f) {
  const out = [];
  for (const k of Object.keys(f)) if (!FIELDS.includes(k)) {
    const s = { timeout: "navTimeout or maxTimeMs", url: "start or expectUrl", value: "inputs", values: "inputs", steps: "maxSteps" }[k] ?? closest(k, FIELDS);
    out.push(s ? `unknown field "${k}" (did you mean "${s}"?)` : `unknown field "${k}"`);
  }
  const strs = (k) => { if (f[k] != null && !(Array.isArray(f[k]) && f[k].every((x) => typeof x === "string"))) out.push(`"${k}" must be an array of strings, e.g. ${k}: ["Order placed"]`); };
  strs("expect"); strs("expectSeen"); strs("expectAbsent"); strs("expectGone");
  for (const k of ["neverClick", "redact"]) if (f[k] != null && !(Array.isArray(f[k]) && f[k].every((x) => typeof x === "string" || x instanceof RegExp)))
    out.push(`"${k}" must be an array of strings or RegExps`);
  if (f.expectState != null && !(Array.isArray(f.expectState) && f.expectState.every((x) => x && typeof x === "object" && !Array.isArray(x))))
    out.push(`"expectState" must be an array of objects, e.g. expectState: [{ role: "combobox", name: "Plan", value: "Pro" }]`);
  if (f.expectUrl != null && !(typeof f.expectUrl === "string" || f.expectUrl instanceof RegExp)) out.push(`"expectUrl" must be a string or a RegExp`);
  if (f.inputs != null && (typeof f.inputs !== "object" || Array.isArray(f.inputs))) out.push(`"inputs" must be an object of label: value pairs`);
  for (const k of ["start", "control"]) if (f[k] != null && !(typeof f[k] === "string" && f[k].startsWith("/")))
    out.push(`"${k}" must be a path that starts with "/" (put the origin in --base or "base"), got ${JSON.stringify(f[k])}`);
  if (typeof f.goal !== "string") out.push(`"goal" must be a string`);
  // numbers and enums (wave-2 test W1: navTimeout "30s" surfaced as "UNREACHABLE ... Is the app running?")
  const num = (k, ok, what) => { if (f[k] != null && !(typeof f[k] === "number" && ok(f[k]))) out.push(`"${k}" must be ${what}, got ${JSON.stringify(f[k])}`); };
  num("maxSteps", (v) => Number.isInteger(v) && v > 0, "a whole number above 0");
  num("navTimeout", (v) => v > 0, "a number of milliseconds");
  num("maxTimeMs", (v) => v > 0, "a number of milliseconds");
  num("minConfidence", (v) => v >= 0 && v <= 1, "a number from 0 to 1");
  if (f.dialog != null && !["accept", "dismiss"].includes(f.dialog)) out.push(`"dialog" must be "accept" or "dismiss"`);
  if (f.kind != null && typeof f.kind !== "string") out.push(`"kind" must be a string`);
  if (typeof f.expectUrl === "string") {
    try { new RegExp(f.expectUrl); } catch (e) { out.push(`"expectUrl" is not a valid regex: ${e.message.replace(/^Invalid regular expression: /, "")}`); }
    // "?" before "name=" is a regex quantifier: "/login?welcome=1" never matches /login?welcome=1
    if (/[^\\]\?[\w-]+=/.test(f.expectUrl)) out.push(`"expectUrl" is a regex: escape "?" as "\\?" (got ${JSON.stringify(f.expectUrl)})`);
  }
  for (const w of Array.isArray(f.expectState) ? f.expectState : [])
    for (const b of ["checked", "selected", "expanded"]) if (w && w[b] != null && typeof w[b] !== "boolean") out.push(`"expectState" ${b} must be true or false, got ${JSON.stringify(w[b])}`);
  if (["expectUrl", "expect", "expectState", "expectSeen", "expectAbsent", "expectGone"].every((k) => f[k] == null || (Array.isArray(f[k]) && !f[k].length)))
    out.push(`no assertion: add expectUrl, expect, expectState, expectSeen, expectAbsent or expectGone (code decides pass or fail from them)`);
  return out;
}
async function loadFlows(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`spec file not found: ${file}\nA spec exports an array of flows: https://github.com/dmoka/quicke2e/blob/main/AGENTS.md#write-a-spec`);
  let m;
  try { m = await import(pathToFileURL(abs).href); }
  catch (e) {
    const ts = e?.code === "ERR_UNKNOWN_FILE_EXTENSION" && /\.[cm]?ts$/.test(file);
    die(`cannot load ${file}: ${stripAnsi(e.message || e).split("\n")[0]}`
      + (ts ? `\nTypeScript specs need Node 22.18+ (or NODE_OPTIONS=--experimental-strip-types). Or name the file .mjs.` : "")
      + (/Unexpected token 'export'|module is not defined/.test(String(e.message)) ? `\nUse the .mjs extension for an ESM spec (export default [...]).` : "")); }
  const v = m.default ?? m.flows ?? m.FLOWS;
  if (v == null) die(`${file} has no default export. Use: export default [{ name, goal, ... }]`);
  const flows = Array.isArray(v) ? v : [v];
  if (!flows.length) die(`${file} exports no flows. Use: export default [{ name, goal, ... }]`);
  const bad = flows.filter((f) => !f || !f.name || !f.goal);
  if (bad.length) die(`${file}: every flow needs "name" and "goal" (${bad.length} without them).`);
  // storageState: a path is read relative to the working folder, else to the spec file; a missing file is
  // named here (launch test 2026-10-07: it surfaced as "UNREACHABLE ... Is the app running?").
  for (const f of flows) if (typeof f.storageState === "string" && !fs.existsSync(f.storageState)) {
    const near = path.resolve(path.dirname(abs), f.storageState);
    if (fs.existsSync(near)) { Object.defineProperty(f, "storageStateSpec", { value: f.storageState, enumerable: false }); f.storageState = near; }
    else die(`${file}: ${f.name}: storageState file not found: ${path.resolve(f.storageState)}${near !== path.resolve(f.storageState) ? ` (or ${near})` : ""}. Save one with the login recipe in SKILL.md.`);
  }
  const only = opt("--only");
  // --only a,b runs several flows (wave-2 test W2: a second --only replaced the first)
  const want = only ? String(only).split(",").map((x) => x.trim()).filter(Boolean) : null;
  const picked = want ? flows.filter((f) => want.includes(f.name)) : flows;
  const missingNames = want ? want.filter((n) => !flows.some((f) => f.name === n)) : [];
  if (!picked.length || missingNames.length) die(`no flow named "${missingNames[0] ?? only}" in ${file}. Flows: ${flows.map((f) => f.name).join(", ")}`);
  // compared as file names (Windows and macOS file systems ignore case; "a/b" and "a:b" both become "a-b")
  const fkey = (n) => fileName(n).toLowerCase();
  const dup = [...new Set(flows.map((f) => f.name).filter((n, i, all) => all.findIndex((m) => fkey(m) === fkey(n)) !== i))];
  // Only the flows that will run are checked: with --only, a broken neighbour does not block the run.
  const problems = [...(dup.length && !only ? [`  duplicate flow names: ${dup.join(", ")} (names must be unique: --only, --emit and traces use them)`] : []),
    ...picked.flatMap((f) => specProblems(f).map((p) => `  ${f.name}: ${p}`))];
  if (problems.length) die(`${file}: ${problems.length} problem${problems.length > 1 ? "s" : ""} in the spec\n${problems.join("\n")}\nFields: https://github.com/dmoka/quicke2e#reference`);
  return picked;
}

// Fail before the first page load when the engine cannot answer.
async function preflightEngine(engine) {
  if (!["jev", "vercel", "local"].includes(engine)) die(`unknown engine "${engine}": use jev, vercel or local.`);
  if (engine === "jev" && !process.env.OPENROUTER_API_KEY)
    die("Set OPENROUTER_API_KEY for the jev engine (https://openrouter.ai/keys), or use --engine local.");
  if (engine === "vercel" && !process.env.AI_GATEWAY_API_KEY) die("Set AI_GATEWAY_API_KEY for the vercel engine.");
  // PERF: open the TLS connection to the engine while the browser starts; the first decision reuses it.
  // An OPTIONS request without credentials: no page data, no cost (a HEAD answer closes the connection).
  const host = { jev: "https://openrouter.ai/api/alpha/decisions", vercel: "https://ai-gateway.vercel.sh/v1/evaluate" }[engine];
  if (host) fetch(host, { method: "OPTIONS", signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => {});
  if (engine === "local") {
    const url = process.env.LOCAL_URL || "http://127.0.0.1:8822";
    const ok = await fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    if (!ok) die(`The local engine does not answer at ${url}. Start it from a clone of https://github.com/dmoka/quicke2e: python local-engine/server.py (see local-engine/README.md), or set LOCAL_URL.`);
  }
}

// A spec whose assertion already holds on the start page proves nothing (README finding #4).
// With `control`, loading the start URL IS the attack (another user's order), so the check loads the
// control page instead: a page where the app says yes. There the assertion must be false.
async function weak(flow, base, browser) {
  const at = flow.control || flow.start || "/";
  const ctx = await browser.newContext({ ...(flow.storageState ? { storageState: flow.storageState } : {}) });
  if (flow.expectSeen?.length) await ctx.addInitScript("window.__jevSeen = [];");
  const page = await ctx.newPage();
  const netQuiet = trackNetwork(page);
  try {
    await page.goto(base.replace(/\/$/, "") + at, { waitUntil: "domcontentloaded", ...(navTimeout || flow.navTimeout ? { timeout: flow.navTimeout ?? navTimeout } : {}) });
    await netQuiet(); await settle(page);
    const snap = await page.evaluate(`(${SNAPSHOT})()`);
    // On the control page (the app says yes) every expectAbsent text must BE there: that proves the
    // success marker is real and its wording right (wave-2 test W4).
    const markerMissing = flow.control && flow.expectAbsent?.length
      ? (await Promise.all(flow.expectAbsent.map(async (x) => (await absentSeen(page, { expectAbsent: [x] }, { loose: true })) ? null : x))).find(Boolean) ?? null : null;
    return { at, weak: await checkGoal(page, flow, snap), absent: flow.control ? null : await absentSeen(page, flow, { loose: true }), markerMissing };
  } finally { await ctx.close(); }
}

// One line per reason a run failed: the assertions that did not hold, a submit the run held back,
// actions that failed, required fields left empty, a loop.
function why(rec) {
  const lines = [];
  // The run threw before the app could be judged: the error line says why; app reasons would mislead.
  if (["ERROR", "ENGINE_ERROR"].includes(rec.outcome)) return lines;
  if (rec.startStatus) lines.push(`the start page answered HTTP ${rec.startStatus}${[401, 403].includes(rec.startStatus) ? ": it needs a login (storageState) or basic-auth credentials in the base URL" : ""}`);
  for (const a of rec.assertions || []) if (!a.held) lines.push(`not met: ${a.kind} ${JSON.stringify(a.value)}${a.actual != null ? ` (was ${JSON.stringify(a.actual)})` : ""}`);
  if (rec.loop) lines.push(`loop: ${rec.loop.op} "${rec.loop.label}" ran ${rec.loop.times}x on an unchanged page; stopped before the next one`);
  for (const h of rec.heldBack || []) lines.push(h.key
    ? `held back: "${h.label}" until "${h.waitingFor}" is filled (spec key "${h.key}")`
    : `held back: "${h.label}" until "${h.waitingFor}" is set; the spec has no key for it: add "${String(h.waitingFor).toLowerCase()}": "<value>" to inputs`);
  if (rec.lowConfidence) lines.push(`low confidence: the engine's picks stayed under ${rec.minConfidence} (best ${rec.lowConfidence.confidence} for ${rec.lowConfidence.op} "${rec.lowConfidence.label}")`);
  if (rec.failedActions?.length) lines.push(`actions that failed: ${rec.failedActions.map((f) => `${f.op} "${f.label}"`).join(", ")}`);
  for (const e of rec.pageErrors || []) lines.push(`page says: "${e}"`);
  for (const o of rec.unmatchedOptions || []) lines.push(`inputs.${o.key} "${o.value}" matches no option of "${o.field}" (${o.options.join(", ")})`);
  if (rec.unkeyedFields?.length) lines.push(`fields with no spec value: ${rec.unkeyedFields.map((x) => `"${x}"`).join(", ")} (add a key named like the field label to inputs)`);
  if (rec.unusedInputs?.length) lines.push(`spec keys never used: ${rec.unusedInputs.join(", ")} (no field label contains the key)`);
  if (rec.networkErrors?.length) lines.push(`network: ${rec.networkErrorCount} request(s) failed (${rec.networkErrors.join(", ")}): did the app stop?`);
  if (rec.coveredBy) lines.push(`covered: "${rec.coveredBy.label}" could not be clicked; "${rec.coveredBy.by}" lies over it (a cookie banner or popup? name it in the goal: "Accept the cookies, then ...")`);
  if (rec.neverHidden?.length) lines.push(`neverClick hid: ${rec.neverHidden.map((l) => `"${l}"`).join(", ")} (the engine could not pick it; if the app's refusal comes from that click, remove it from neverClick)`);
  if (rec.emptyRequired?.length) lines.push(`required fields still empty: ${rec.emptyRequired.map((x) => `"${x}"`).join(", ")}`);
  return lines;
}

if (cmd === "discover") {
  let base = positional[0];
  if (base && !/^https?:\/\//.test(base)) base = "http://" + base;
  // Git Bash (MSYS) rewrites "/admin" to "C:/Program Files/Git/admin" (platform test W7)
  if ((opt("--start") || "").split(",").some((x) => /^[A-Za-z]:[\\/]/.test(x)))
    die(`--start got a Windows path (${opt("--start")}): Git Bash turned "/..." into a file path. Run with MSYS_NO_PATHCONV=1, or from PowerShell or cmd.`);   // "127.0.0.1:9100" works like in run
  const { discover } = await import("../src/discover.mjs");
  const { parseRedactArg } = await import("../src/redact.mjs");
  let inputs = {};
  if (opt("--inputs")) try { inputs = JSON.parse(fs.readFileSync(opt("--inputs"), "utf8")); }
    catch (e) { die(`--inputs ${opt("--inputs")}: ${e.code === "ENOENT" ? "file not found" : "not valid JSON (" + e.message + ")"}`); }
  const dbrowser = await launch();
  const map = await discover({ base, browser: dbrowser, start: (opt("--start", "/")).split(","), mode: flag("--safe") ? "safe" : "full",
    allowRemote: flag("--i-own-this-data"), reset: opt("--reset"), storageState: opt("--storage"), inputs,
    maxPages: Number(opt("--max-pages", 40)), log: (m) => out("  " + m),
    redact: (many["--redact"] || []).map(parseRedactArg) });
  await dbrowser.close();
  const file = opt("-o", "quicke2e.map.json");
  // An app that is down gives 0 pages: say so, and keep the map file that is there (launch test 2026-10-07).
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (!map.pages.length) { out(`UNREACHABLE: no page loaded from ${base}. Is the app running? ${fs.existsSync(file) ? file + " was not changed." : ""}`); process.exit(1); }
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
  out(`\n${map.pages.length} pages, ${map.edges.length} edges, ${map.pages.reduce((n, p) => n + p.forms.length, 0)} forms in ${(map.ms / 1000).toFixed(1)}s -> ${file}`);
  process.exit(0);
}

// run / check
const file = positional[0];
const flows = await loadFlows(file);
if (/\.(spec\.)?[jt]s$/.test(opt("--emit") || "")) die(`--emit takes a folder (one <flow>.spec.ts per passing flow), got ${opt("--emit")}`);
let base = opt("--base", process.env.APP_BASE || "http://localhost:3000");
if (!/^https?:\/\//i.test(base)) base = "http://" + base;   // "127.0.0.1:9200" works, as in discover
// Launch test 2026-10-07: with no base, a run drove an unrelated app on :3000. Say which app is driven.
if (!opt("--base") && !process.env.APP_BASE && flows.some((f) => !f.base)) out(`note: no --base or APP_BASE: using ${base}`);
// A flow name becomes a file name (--trace, --emit): "auth/login" must not point into a missing folder.
function fileName(name) { return String(name).replace(/[\x00-\x1f\/\\:*?"<>|]+/g, "-").slice(0, 100); }   // control chars, length: Windows
const engine = opt("--engine", "jev");
const runs = Number(opt("--runs", 1));
if (!(Number.isInteger(runs) && runs >= 1)) die(`--runs needs a whole number of at least 1.`);
const minConfidence = opt("--min-confidence") != null ? Number(opt("--min-confidence")) : undefined;
const navTimeout = opt("--nav-timeout") != null ? Number(opt("--nav-timeout")) : undefined;
if (navTimeout != null && !(navTimeout > 0)) die("--nav-timeout needs a number of milliseconds.");
if (minConfidence != null && !(minConfidence >= 0 && minConfidence <= 1)) die("--min-confidence needs a number between 0 and 1.");
if (cmd === "run") await preflightEngine(engine);
let map = null;
if (opt("--map")) try { map = JSON.parse(fs.readFileSync(opt("--map"), "utf8")); }
  catch (e) { die(`--map ${opt("--map")}: ${e.code === "ENOENT" ? "file not found (make one with: quicke2e discover <baseUrl>)" : "not valid JSON (" + e.message + ")"}`); }
const browser = await launch();
let failed = 0, keyRejected = false;
const all = [];
// A flow that never ran still has the fields AGENTS.md documents (assertions, kind), so agents can read
// every record the same way (launch test 2026-10-07: r.assertions.filter threw on WEAK_ASSERTION).
const skipped = (flow, outcome, error) => ({ flow: flow.name, ...(flow.kind ? { kind: flow.kind } : {}),
  base: String(flow.base || base).replace(/^(https?:\/\/)[^\/@\s]+@/i, "$1"), engine, outcome, passed: false, error,
  finalUrl: null, steps: [], assertions: [], wallMs: 0, cost: 0 });
const { weakSecretKeys } = await import("../src/secret.mjs");
for (const flow of flows) {
  if (keyRejected) break;
  const fbase = flow.base || base;
  const weakKeys = weakSecretKeys(flow.inputs);
  if (weakKeys.length) out(`note: ${flow.name}: ${weakKeys.join(", ")} ${weakKeys.length > 1 ? "are" : "is a"} weak secret${weakKeys.length > 1 ? "s" : ""}`
    + ` (short or a common word). It is kept out of the goal, but the page may echo it to the engine.`);
  // An app that is not running is the most common first failure: say so in one line, not a stack trace.
  const unreachableMsg = (e) => `${fbase.replace(/\/$/, "")}${flow.control || flow.start || "/"} (${stripAnsi(e.message || e).split("\n")[0].replace(/^page\.goto: /, "")}). Is the app running?`;
  // Prints the WEAK_ASSERTION / ABSENT_ON_START line; true when the flow must not run.
  const weakStop = (w) => {
    if (w.markerMissing) {
      const msg = `"${w.markerMissing}" is not on the control page ${w.at}: expectAbsent must name the text the app shows when it says yes`;
      out(`WEAK_ASSERTION  ${flow.name}: ${msg}`);
      if (cmd === "check" || !flag("--allow-weak")) { all.push(skipped(flow, "WEAK_ASSERTION", msg)); failed++; return true; }
    }
    if (!(w.weak || w.absent)) return false;
    const msg = w.absent ? `"${w.absent}" is already visible on ${w.at}. expectAbsent must name a state only success reaches.`
      : flow.control ? `the assertion is also true on the control page ${w.at}, so it cannot tell a refusal from a success.`
      : `the assertion is already true on ${w.at} before any work.`;
    out(`${w.absent ? "ABSENT_ON_START" : "WEAK_ASSERTION "} ${flow.name}: ${msg}`);
    if (cmd === "check" || !flag("--allow-weak")) { all.push(skipped(flow, w.absent ? "ABSENT_ON_START" : "WEAK_ASSERTION", msg)); failed++; return true; }
    return false;
  };
  // PERF: `run` checks the start page inside the first run's own page load (runOnce startCheck), which
  // saves weak()'s extra browser context and page load. `check`, and a flow with a `control` page
  // (a different URL), still load it separately.
  const separate = cmd === "check" || flow.control;
  if (separate) {
    let w;
    try { w = await weak(flow, fbase, browser); }
    catch (e) { const msg = unreachableMsg(e); out(`UNREACHABLE     ${flow.name}: ${msg}`); all.push(skipped(flow, "UNREACHABLE", msg)); failed++; continue; }
    if (weakStop(w)) continue;
    if (cmd === "check") { out(`ok              ${flow.name}`); all.push({ ...skipped(flow, "OK", null), passed: true }); continue; }
  }
  for (let k = 0; k < runs; k++) {
    const trace = opt("--trace") ? path.join(opt("--trace"), `${fileName(flow.name)}-${Date.now()}-${process.pid}.json`) : undefined;
    if (trace) fs.mkdirSync(opt("--trace"), { recursive: true });
    if (opt("--reset")) {
      const { execSync } = await import("node:child_process");
      try { execSync(opt("--reset"), { stdio: "ignore", shell: true }); }
      catch (e) { out(`RESET_FAILED    ${flow.name}: "${opt("--reset")}" exited with ${e.status}`); all.push(skipped(flow, "RESET_FAILED", `reset exited with ${e.status}`)); failed++; continue; }
    }
    const rec = await runOnce({ flow, engine, browser, base: fbase, trace, ...(map ? { map } : {}),
      ...(navTimeout ? { navTimeout } : {}),
      ...(minConfidence != null ? { minConfidence } : {}), ...(opt("--video") ? { video: opt("--video") } : {}),
      ...(opt("--emit") ? { locate: true } : {}), ...(!separate && k === 0 ? { startCheck: weakStop } : {}) });
    if (rec.startCheck) break;   // weakStop already printed and recorded it
    if (!separate && k === 0 && rec.unreachable) {
      const msg = unreachableMsg({ message: rec.unreachable });
      out(`UNREACHABLE     ${flow.name}: ${msg}`); all.push(skipped(flow, "UNREACHABLE", msg)); failed++; break;
    }
    if (rec.error) rec.error = stripAnsi(rec.error);
    all.push(rec);
    if (!rec.passed) failed++;
    out(`${rec.passed ? "PASS" : "FAIL"}  ${flow.name.padEnd(28)} ${String(rec.steps.length).padStart(2)} steps  `
      + `${(rec.wallMs / 1000).toFixed(1).padStart(5)}s  $${rec.cost.toFixed(5)}  ${rec.outcome}`
      + (rec.absentSeen ? `  saw ${JSON.stringify(rec.absentSeen)}` : "") + (rec.httpStatus ? `  HTTP ${rec.httpStatus}${rec.apiError ? ` (${rec.apiError.method} ${rec.apiError.path})` : ""}` : "") + (flow.kind ? `  (${flow.kind})` : "")
      + (rec.route?.hops?.length ? `  via map -> ${rec.route.pattern}` : "") + (rec.error ? `  ${rec.error}` : ""));
    if (!rec.passed) for (const l of why(rec)) out(`      ${l}`);
    // A pass with a step that could not be done is still a pass (code checks the assertions), but say so:
    // a file input that could not take its file passed with no attachment (launch test 2026-10-07).
    if (rec.passed) { const bad = [...new Set(rec.steps.filter((x) => x.stale).map((x) => `${x.op} "${x.label}"`))];
      if (bad.length) out(`      note: actions that failed on the way: ${bad.join(", ")}`); }
    // A pass that never used a spec value: the assertions may hold before the goal is done (wave-2 W3:
    // an "only spaces" attack passed without typing its value).
    if (rec.passed && rec.unusedInputs?.length) out(`      note: spec keys never used: ${rec.unusedInputs.join(", ")}. Check that the assertions prove the goal.`);
    // A rejected key fails every flow the same way: stop once, with the fix, instead of N identical FAILs.
    if (rec.outcome === "ENGINE_ERROR" && [401, 403].includes(rec.engineStatus)) {
      out(`stopped: the engine rejected the API key (HTTP ${rec.engineStatus}). Check ${engine === "vercel" ? "AI_GATEWAY_API_KEY" : "OPENROUTER_API_KEY"}.`);
      keyRejected = true; break;
    }
    for (const x of rec.slowSteps || []) out(`      slow: ${x.op} "${x.label}" took ${(x.ms / 1000).toFixed(1)} s`);
    if (rec.passed && opt("--emit")) {
      const { generate } = await import("../codegen/codegen.mjs");
      fs.mkdirSync(opt("--emit"), { recursive: true });
      const f = path.join(opt("--emit"), `${fileName(flow.name)}.spec.ts`);
      // forward slashes: Playwright reads the argument as a regex, and "e2e\x.spec.ts" matched nothing on Windows
      const fx = f.split(path.sep).join("/");
      const { isSecretKey } = await import("../src/secret.mjs");
      const envs = Object.keys(flow.inputs || {}).filter(isSecretKey).map((k) => `${flow.name}_${k}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
      try { fs.writeFileSync(f, generate(rec, flow).code); out(`      emitted ${fx}  (run: npx playwright test ${fx}; needs @playwright/test${envs.length ? `; set ${envs.join(", ")} (skipped without it, fails with CI set)` : ""})`); }
      catch (e) { out(`      not emitted: ${e.message}`); }
    }
  }
}
await browser.close();
// One summary line for a suite (launch test: 45 runs ended with no total).
if (cmd === "run" && all.length > 1) {
  const ran = all.filter((r) => r.wallMs > 0), cost = all.reduce((n, r) => n + (r.cost || 0), 0);
  out(`\n${all.filter((r) => r.passed).length} passed, ${all.filter((r) => !r.passed).length} failed  $${cost.toFixed(5)}  ${(ran.reduce((n, r) => n + r.wallMs, 0) / 1000).toFixed(1)}s`);
}
// Exit only after stdout has flushed: a pipe is written asynchronously on macOS and Linux, and
// process.exit() cut --json at 64 KB (platform test W7: 70 runs, "Unterminated string in JSON").
// exit 3: every failure was the engine's (timeout, 429/5xx), not the app's: CI can retry instead of
// reporting a regression (wave-2 test W2)
const engineOnly = failed && all.filter((r) => !r.passed).every((r) => r.outcome === "ENGINE_ERROR");
const code = keyRejected ? 2 : engineOnly ? 3 : failed ? 1 : 0;
if (flag("--json")) process.stdout.write(hideCreds(JSON.stringify(all)) + "\n", () => process.exit(code));
else process.exit(code);
