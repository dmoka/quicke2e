#!/usr/bin/env node
// quicke2e CLI.
//   quicke2e discover <baseUrl> [--start /,/admin] [--safe] [--i-own-this-data] [--reset "<cmd>"]
//                                [--inputs inputs.json] [--storage state.json] [-o quicke2e.map.json]
//                                [--redact ".css-selector" --redact "/regex/i" ...] [--headed|--headless]
//   quicke2e run <spec.mjs> [--base url] [--engine jev|local|vercel] [--map quicke2e.map.json]
//                            [--runs N] [--emit dir] [--trace dir] [--video dir] [--headed|--headless] [--allow-weak] [--only name]
//   quicke2e check <spec.mjs> [--base url]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, runOnce, SNAPSHOT, settle, checkGoal, absentSeen } from "../src/loop.mjs";
import { discover } from "../src/discover.mjs";
import { parseRedactArg } from "../src/redact.mjs";

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes(name);
const FLAGS = new Set(["--safe", "--i-own-this-data", "--headed", "--headless", "--allow-weak", "--json"]);
const positional = argv.filter((a, i) => !a.startsWith("-") && !(i > 0 && argv[i - 1].startsWith("-") && !FLAGS.has(argv[i - 1])));
const out = (s = "") => process.stdout.write(s + "\n");
// Headed when a person runs it (interactive terminal, a display available); headless in CI, with no
// display, or when the output is piped. --headed / --headless force either.
const headless = flag("--headless") ? true : flag("--headed") ? false
  : Boolean(process.env.CI) || !process.stdout.isTTY
    || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

async function loadFlows(file) {
  const m = await import(pathToFileURL(path.resolve(file)).href);
  const v = m.default ?? m.flows ?? m.FLOWS;
  const flows = Array.isArray(v) ? v : [v];
  const only = opt("--only");
  return only ? flows.filter((f) => f.name === only) : flows;
}

// A spec whose assertion already holds on the start page proves nothing (README finding #4).
// With `control`, loading the start URL IS the attack (another user's order), so the check loads the
// control page instead: a page where the app says yes. There the assertion must be false.
async function weak(flow, base, browser) {
  const at = flow.control || flow.start || "/";
  const ctx = await browser.newContext({ ...(flow.storageState ? { storageState: flow.storageState } : {}) });
  if (flow.expectSeen?.length) await ctx.addInitScript("window.__jevSeen = [];");
  const page = await ctx.newPage();
  try {
    await page.goto(base.replace(/\/$/, "") + at, { waitUntil: "domcontentloaded" });
    await settle(page);
    const snap = await page.evaluate(`(${SNAPSHOT})()`);
    return { at, weak: await checkGoal(page, flow, snap), absent: flow.control ? null : await absentSeen(page, flow) };
  } finally { await ctx.close(); }
}

const usage = () => { out(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 7).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(2); };

if (cmd === "discover") {
  const base = positional[0]; if (!base) usage();
  const inputs = opt("--inputs") ? JSON.parse(fs.readFileSync(opt("--inputs"), "utf8")) : {};
  const dbrowser = await chromium.launch({ headless });
  const map = await discover({ base, browser: dbrowser, start: (opt("--start", "/")).split(","), mode: flag("--safe") ? "safe" : "full",
    allowRemote: flag("--i-own-this-data"), reset: opt("--reset"), storageState: opt("--storage"), inputs,
    maxPages: Number(opt("--max-pages", 40)), log: (m) => out("  " + m),
    redact: argv.flatMap((a, i) => (a === "--redact" ? [argv[i + 1]] : [])).map(parseRedactArg) });
  await dbrowser.close();
  const file = opt("-o", "quicke2e.map.json");
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
  out(`\n${map.pages.length} pages, ${map.edges.length} edges, ${map.pages.reduce((n, p) => n + p.forms.length, 0)} forms in ${(map.ms / 1000).toFixed(1)}s -> ${file}`);
  process.exit(0);
}

if (cmd === "run" || cmd === "check") {
  const file = positional[0]; if (!file) usage();
  const flows = await loadFlows(file);
  const base = opt("--base", process.env.APP_BASE || "http://localhost:3000");
  const engine = opt("--engine", "jev");
  const runs = Number(opt("--runs", 1));
  const map = opt("--map") ? JSON.parse(fs.readFileSync(opt("--map"), "utf8")) : null;
  const browser = await chromium.launch({ headless });
  let failed = 0;
  const all = [];
  const { weakSecretKeys } = await import("../src/secret.mjs");
  for (const flow of flows) {
    const fbase = flow.base || base;
    const weakKeys = weakSecretKeys(flow.inputs);
    if (weakKeys.length) out(`note: ${flow.name}: ${weakKeys.join(", ")} ${weakKeys.length > 1 ? "are" : "is a"} weak secret${weakKeys.length > 1 ? "s" : ""}`
      + ` (short or a common word). It is kept out of the goal, but the page may echo it to the engine.`);
    // An app that is not running is the most common first failure: say so in one line, not a stack trace.
    let w;
    try { w = await weak(flow, fbase, browser); }
    catch (e) {
      out(`UNREACHABLE     ${flow.name}: ${fbase.replace(/\/$/, "")}${flow.control || flow.start || "/"} (${String(e.message || e).split("\n")[0].replace(/^page\.goto: /, "")}). Is the app running?`);
      failed++; continue;
    }
    if (w.weak || w.absent) {
      out(w.absent ? `ABSENT_ON_START ${flow.name}: "${w.absent}" is already visible on ${w.at}. expectAbsent must name a state only success reaches.`
        : flow.control ? `WEAK_ASSERTION  ${flow.name}: the assertion is also true on the control page ${w.at}, so it cannot tell a refusal from a success.`
        : `WEAK_ASSERTION  ${flow.name}: the assertion is already true on ${w.at} before any work.`);
      if (cmd === "check" || !flag("--allow-weak")) { failed++; continue; }
    } else if (cmd === "check") { out(`ok              ${flow.name}`); continue; }
    for (let k = 0; k < runs; k++) {
      const trace = opt("--trace") ? path.join(opt("--trace"), `${flow.name}-${Date.now()}.json`) : undefined;
      if (trace) fs.mkdirSync(opt("--trace"), { recursive: true });
      const rec = await runOnce({ flow, engine, browser, base: fbase, trace, ...(map ? { map } : {}),
        ...(opt("--video") ? { video: opt("--video") } : {}) });
      all.push(rec);
      if (!rec.passed) failed++;
      out(`${rec.passed ? "PASS" : "FAIL"}  ${flow.name.padEnd(28)} ${String(rec.steps.length).padStart(2)} steps  `
        + `${(rec.wallMs / 1000).toFixed(1).padStart(5)}s  $${rec.cost.toFixed(5)}  ${rec.outcome}`
        + (rec.absentSeen ? `  saw ${JSON.stringify(rec.absentSeen)}` : "") + (rec.httpStatus ? `  HTTP ${rec.httpStatus}` : "") + (flow.kind ? `  (${flow.kind})` : "")
        + (rec.route?.pattern ? `  via map -> ${rec.route.pattern}` : "") + (rec.error ? `  ${rec.error}` : ""));
      if (rec.passed && opt("--emit")) {
        const { generate } = await import("../codegen/codegen.mjs");
        fs.mkdirSync(opt("--emit"), { recursive: true });
        const f = path.join(opt("--emit"), `${flow.name}.spec.ts`);
        try { fs.writeFileSync(f, generate(rec, flow).code); out(`      emitted ${f}`); }
        catch (e) { out(`      not emitted: ${e.message}`); }
      }
    }
  }
  await browser.close();
  if (flag("--json")) out(JSON.stringify(all));
  process.exit(failed ? 1 : 0);
}

usage();
