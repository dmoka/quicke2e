#!/usr/bin/env node
// quicke2e CLI. Run `quicke2e --help` or `quicke2e <command> --help`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, runOnce, SNAPSHOT, settle, checkGoal } from "../src/loop.mjs";
import { discover } from "../src/discover.mjs";
import { parseRedactArg } from "../src/redact.mjs";

const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = (s = "") => process.stdout.write(s + "\n");
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
      "--video": "value", "--allow-weak": "bool", "--only": "value", "--json": "bool", "--min-confidence": "value" } },
  check: { args: "<spec.mjs>", about: "validate specs against the running app (no engine call)",
    flags: { "--base": "value", "--only": "value", "--json": "bool" } },
};
const HELP = {
  "--start": "comma-separated start paths (default /)", "--safe": "safe crawl: never submits a form",
  "--i-own-this-data": "allow a full crawl on a host other than localhost", "--reset": "command that restores seed data before the crawl",
  "--inputs": "JSON file with form values for the crawl", "--storage": "Playwright storage-state file (logged-in crawl)",
  "-o": "output map file (default quicke2e.map.json)", "--redact": "CSS selector or /regex/ the engine must never see (repeatable)",
  "--max-pages": "page limit (default 40)", "--base": "app base URL (default $APP_BASE, then http://localhost:3000)",
  "--engine": "jev (default, needs OPENROUTER_API_KEY) | vercel (AI_GATEWAY_API_KEY) | local (local-engine/server.py)",
  "--map": "map file from discover", "--runs": "runs per flow (default 1)", "--emit": "write a Playwright spec for each passing run",
  "--trace": "write a JSON trace per run", "--video": "save a WebM recording per run",
  "--allow-weak": "run a flow that failed the WEAK_ASSERTION check", "--only": "run only the flow with this name",
  "--json": "print all records as one JSON array on the last line of stdout",
  "--min-confidence": "an action the engine picks below this confidence is not executed (default 0.3; a flow's minConfidence overrides)",
  "--headed": "show the browser", "--headless": "hide the browser",
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
if (!raw.length || raw[0] === "--help" || raw[0] === "-h" || raw[0] === "help") { out(usageText()); process.exit(raw.length ? 0 : 2); }
const cmd = raw[0];
if (!COMMANDS[cmd]) {
  const s = closest(cmd, Object.keys(COMMANDS));
  die(`unknown command "${cmd}".${s ? ` Did you mean "${s}"?` : ""}\n\n${usageText()}`);
}
const known = { ...COMMANDS[cmd].flags, ...COMMON };
const opts = {}, many = {}, positional = [];
for (let i = 1; i < raw.length; i++) {
  const a = raw[i];
  if (!a.startsWith("-") || a === "-") { positional.push(a); continue; }
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

async function loadFlows(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`spec file not found: ${file}\nA spec exports an array of flows: https://github.com/dmoka/quicke2e/blob/main/AGENTS.md#write-a-spec`);
  let m;
  try { m = await import(pathToFileURL(abs).href); }
  catch (e) { die(`cannot load ${file}: ${stripAnsi(e.message || e).split("\n")[0]}`); }
  const v = m.default ?? m.flows ?? m.FLOWS;
  if (v == null) die(`${file} has no default export. Use: export default [{ name, goal, ... }]`);
  const flows = Array.isArray(v) ? v : [v];
  const bad = flows.filter((f) => !f || !f.name || !f.goal);
  if (bad.length) die(`${file}: every flow needs "name" and "goal" (${bad.length} without them).`);
  const only = opt("--only");
  const picked = only ? flows.filter((f) => f.name === only) : flows;
  if (!picked.length) die(`no flow named "${only}" in ${file}. Flows: ${flows.map((f) => f.name).join(", ")}`);
  return picked;
}

// Fail before the first page load when the engine cannot answer.
async function preflightEngine(engine) {
  if (!["jev", "vercel", "local"].includes(engine)) die(`unknown engine "${engine}": use jev, vercel or local.`);
  if (engine === "jev" && !process.env.OPENROUTER_API_KEY)
    die("Set OPENROUTER_API_KEY for the jev engine (https://openrouter.ai/keys), or use --engine local.");
  if (engine === "vercel" && !process.env.AI_GATEWAY_API_KEY) die("Set AI_GATEWAY_API_KEY for the vercel engine.");
  if (engine === "local") {
    const url = process.env.LOCAL_URL || "http://127.0.0.1:8822";
    const ok = await fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    if (!ok) die(`The local engine does not answer at ${url}. Start it: python local-engine/server.py (see local-engine/README.md), or set LOCAL_URL.`);
  }
}

// A spec whose assertion already holds on the start page proves nothing (README finding #4).
async function weak(flow, base, browser) {
  const ctx = await browser.newContext({ ...(flow.storageState ? { storageState: flow.storageState } : {}) });
  if (flow.expectSeen?.length) await ctx.addInitScript("window.__jevSeen = [];");
  const page = await ctx.newPage();
  try {
    await page.goto(base.replace(/\/$/, "") + (flow.start || "/"), { waitUntil: "domcontentloaded" });
    await settle(page);
    const snap = await page.evaluate(`(${SNAPSHOT})()`);
    return await checkGoal(page, flow, snap);
  } finally { await ctx.close(); }
}

// One line per reason a run failed: the assertions that did not hold, a submit the run held back,
// actions that failed, required fields left empty, a loop.
function why(rec) {
  const lines = [];
  for (const a of rec.assertions || []) if (!a.held) lines.push(`not met: ${a.kind} ${JSON.stringify(a.value)}${a.actual != null ? ` (was ${JSON.stringify(a.actual)})` : ""}`);
  if (rec.loop) lines.push(`loop: ${rec.loop.op} "${rec.loop.label}" ran ${rec.loop.times}x on an unchanged page; stopped before the next one`);
  for (const h of rec.heldBack || []) lines.push(h.key
    ? `held back: "${h.label}" until "${h.waitingFor}" is filled (spec key "${h.key}")`
    : `held back: "${h.label}" until "${h.waitingFor}" is set; the spec has no key for it: add "${String(h.waitingFor).toLowerCase()}": "<value>" to inputs`);
  if (rec.lowConfidence) lines.push(`low confidence: the engine's picks stayed under ${rec.minConfidence} (best ${rec.lowConfidence.confidence} for ${rec.lowConfidence.op} "${rec.lowConfidence.label}")`);
  if (rec.failedActions?.length) lines.push(`actions that failed: ${rec.failedActions.map((f) => `${f.op} "${f.label}"`).join(", ")}`);
  if (rec.emptyRequired?.length) lines.push(`required fields still empty: ${rec.emptyRequired.map((x) => `"${x}"`).join(", ")}`);
  return lines;
}

if (cmd === "discover") {
  const base = positional[0];
  const inputs = opt("--inputs") ? JSON.parse(fs.readFileSync(opt("--inputs"), "utf8")) : {};
  const dbrowser = await launch();
  const map = await discover({ base, browser: dbrowser, start: (opt("--start", "/")).split(","), mode: flag("--safe") ? "safe" : "full",
    allowRemote: flag("--i-own-this-data"), reset: opt("--reset"), storageState: opt("--storage"), inputs,
    maxPages: Number(opt("--max-pages", 40)), log: (m) => out("  " + m),
    redact: (many["--redact"] || []).map(parseRedactArg) });
  await dbrowser.close();
  const file = opt("-o", "quicke2e.map.json");
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
  out(`\n${map.pages.length} pages, ${map.edges.length} edges, ${map.pages.reduce((n, p) => n + p.forms.length, 0)} forms in ${(map.ms / 1000).toFixed(1)}s -> ${file}`);
  process.exit(0);
}

// run / check
const file = positional[0];
const flows = await loadFlows(file);
const base = opt("--base", process.env.APP_BASE || "http://localhost:3000");
const engine = opt("--engine", "jev");
const runs = Number(opt("--runs", 1));
if (!(runs >= 1)) die(`--runs needs a number of at least 1.`);
const minConfidence = opt("--min-confidence") != null ? Number(opt("--min-confidence")) : undefined;
if (minConfidence != null && !(minConfidence >= 0 && minConfidence <= 1)) die("--min-confidence needs a number between 0 and 1.");
if (cmd === "run") await preflightEngine(engine);
const map = opt("--map") ? JSON.parse(fs.readFileSync(opt("--map"), "utf8")) : null;
const browser = await launch();
let failed = 0;
const all = [];
const skipped = (flow, outcome, error) => ({ flow: flow.name, base: flow.base || base, engine, outcome, passed: false, error,
  finalUrl: null, steps: [], wallMs: 0, cost: 0 });
const { weakSecretKeys } = await import("../src/secret.mjs");
for (const flow of flows) {
  const fbase = flow.base || base;
  const weakKeys = weakSecretKeys(flow.inputs);
  if (weakKeys.length) out(`note: ${flow.name}: ${weakKeys.join(", ")} ${weakKeys.length > 1 ? "are" : "is a"} weak secret${weakKeys.length > 1 ? "s" : ""}`
    + ` (short or a common word). It is kept out of the goal, but the page may echo it to the engine.`);
  // An app that is not running is the most common first failure: say so in one line, not a stack trace.
  let isWeak;
  try { isWeak = await weak(flow, fbase, browser); }
  catch (e) {
    const msg = `${fbase.replace(/\/$/, "")}${flow.start || "/"} (${stripAnsi(e.message || e).split("\n")[0].replace(/^page\.goto: /, "")}). Is the app running?`;
    out(`UNREACHABLE     ${flow.name}: ${msg}`);
    all.push(skipped(flow, "UNREACHABLE", msg)); failed++; continue;
  }
  if (isWeak) {
    out(`WEAK_ASSERTION  ${flow.name}: the assertion is already true on ${flow.start || "/"} before any work.`);
    if (cmd === "check" || !flag("--allow-weak")) {
      all.push(skipped(flow, "WEAK_ASSERTION", `the assertion already holds on ${flow.start || "/"}`)); failed++; continue;
    }
  } else if (cmd === "check") { out(`ok              ${flow.name}`); all.push({ ...skipped(flow, "OK", null), passed: true }); continue; }
  for (let k = 0; k < runs; k++) {
    const trace = opt("--trace") ? path.join(opt("--trace"), `${flow.name}-${Date.now()}.json`) : undefined;
    if (trace) fs.mkdirSync(opt("--trace"), { recursive: true });
    const rec = await runOnce({ flow, engine, browser, base: fbase, trace, ...(map ? { map } : {}),
      ...(minConfidence != null ? { minConfidence } : {}), ...(opt("--video") ? { video: opt("--video") } : {}) });
    if (rec.error) rec.error = stripAnsi(rec.error);
    all.push(rec);
    if (!rec.passed) failed++;
    out(`${rec.passed ? "PASS" : "FAIL"}  ${flow.name.padEnd(28)} ${String(rec.steps.length).padStart(2)} steps  `
      + `${(rec.wallMs / 1000).toFixed(1).padStart(5)}s  $${rec.cost.toFixed(5)}  ${rec.outcome}`
      + (rec.route?.hops?.length ? `  via map -> ${rec.route.pattern}` : "") + (rec.error ? `  ${rec.error}` : ""));
    if (!rec.passed) for (const l of why(rec)) out(`      ${l}`);
    if (rec.passed && opt("--emit")) {
      const { generate } = await import("../codegen/codegen.mjs");
      fs.mkdirSync(opt("--emit"), { recursive: true });
      const f = path.join(opt("--emit"), `${flow.name}.spec.ts`);
      try { fs.writeFileSync(f, generate(rec, flow).code); out(`      emitted ${f}  (run: npx playwright test ${f}; needs @playwright/test)`); }
      catch (e) { out(`      not emitted: ${e.message}`); }
    }
  }
}
await browser.close();
if (flag("--json")) out(JSON.stringify(all));
process.exit(failed ? 1 : 0);
