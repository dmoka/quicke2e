// Model-free tests: they run anywhere (CI on Linux included), cost nothing, and cover every part
// of quicke2e that does not need a decision model. `node --test test/`
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startStatic } from "../fixtures/serve.mjs";
import { chromium, SNAPSHOT, settle } from "../src/loop.mjs";
import { discover, pattern } from "../src/discover.mjs";
import { findRoute } from "../src/route.mjs";
import { generate, locator } from "../codegen/codegen.mjs";

let srv, base, browser;
before(async () => {
  srv = await startStatic(0);
  base = `http://127.0.0.1:${srv.server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser.close(); await srv.close(); });

async function snapOf(path) {
  const page = await browser.newPage();
  await page.goto(base + path);
  await settle(page);
  const s = await page.evaluate(`(${SNAPSHOT})()`);
  await page.close();
  return s;
}

test("snapshot: hidden decoys are never offered", async () => {
  const s = await snapOf("/negative.html");
  const labels = s.actions.map((a) => a.label);
  for (const d of ["Decoy zero size wrapper", "Decoy opacity zero", "Decoy offscreen"])
    assert.ok(!labels.includes(d), `offered ${d}`);
});

test("snapshot: a native <select> gives one action per option, with its control", async () => {
  const s = await snapOf("/select.html");
  const opts = s.actions.filter((a) => a.kind === "select");
  assert.deepEqual(opts.map((a) => a.optionLabel).filter((l) => !/choose/i.test(l)), ["Starter", "Growth", "Scale"]);
  assert.ok(opts.every((a) => a.selectLabel === "Plan"));
});

test("snapshot: submit buttons are tagged with their form", async () => {
  const s = await snapOf("/select.html");
  const save = s.actions.find((a) => a.label === "Save subscription");
  assert.equal(save.submit, true);
  assert.equal(save.form, 0);
});

test("snapshot: a password value never reaches the model-facing fields", async () => {
  const page = await browser.newPage();
  await page.goto(base + "/login.html");
  await page.locator("input[type=password]").fill("hunter2");
  const s = await page.evaluate(`(${SNAPSHOT})()`);
  await page.close();
  const pw = s.actions.find((a) => a.kind === "fill" && a.role === "password");
  assert.equal(pw.secret, true);
});

test("pattern: ids become :id", () => {
  assert.equal(pattern("http://x/events/42/checkout"), "/events/:id/checkout");
  assert.equal(pattern("http://x/orders/3f2a9c1e-8b7d-4c2a-9e1f-0a1b2c3d4e5f"), "/orders/:id");
  assert.equal(pattern("http://x/events/midnight-arcade-neon-tour"), "/events/midnight-arcade-neon-tour");
});

test("discover: refuses a full crawl of a non-local host", async () => {
  await assert.rejects(discover({ base: "https://example.com", mode: "full", browser }), /refused/);
});

test("discover safe: maps pages and forms, never submits", async () => {
  const m = await discover({ base, start: ["/login.html", "/select.html", "/table.html"], mode: "safe", browser });
  const login = m.pages.find((p) => p.pattern === "/login.html");
  assert.ok(login.forms.some((f) => f.fields.some((x) => x.role === "password")));
  assert.ok(!login.forms.some((f) => f.fields.some((x) => /forgot/i.test(x.label))), "a link counted as a field");
  assert.equal(m.edges.filter((e) => e.via.op === "submit").length, 0);
  assert.ok(m.edges.some((e) => e.from === "/table.html" && e.to === "/table2.html"));
});

test("discover full: submits forms and records where they lead", async () => {
  const m = await discover({ base, start: ["/select.html"], mode: "full", browser });
  const sel = m.pages.find((p) => p.pattern === "/select.html");
  assert.equal(sel.forms[0].result?.navigates, "/done.html");
});

test("findRoute: shortest click route, never through a form submit", () => {
  const map = { edges: [
    { fromUrl: "http://a/", toUrl: "http://a/list", via: { op: "link", label: "List" } },
    { fromUrl: "http://a/list", toUrl: "http://a/item/1", via: { op: "link", label: "Item 1" } },
    { fromUrl: "http://a/", toUrl: "http://a/item/1", via: { op: "submit", label: "Go" } },
  ] };
  assert.deepEqual(findRoute(map, "http://a/", "http://a/item/1").map((e) => e.via.label), ["List", "Item 1"]);
  assert.equal(findRoute(map, "http://a/item/1", "http://a/"), null);
});

test("CLI check: a spec whose assertion already holds is WEAK_ASSERTION", async () => {
  const spec = "test/.weak.spec.mjs";
  fs.writeFileSync(spec, `export default [
    { name: "weak", start: "/login.html", goal: "Sign in", expect: ["Welcome back"] },
    { name: "fine", start: "/login.html", goal: "Sign in", expectUrl: "login-done" }];`);
  let out = "";
  // async: a sync child would block this process, which is also serving the fixture pages
  try { out = (await promisify(execFile)("node", ["bin/quicke2e.mjs", "check", spec, "--base", base])).stdout; }
  catch (e) { out = e.stdout; }
  fs.rmSync(spec);
  assert.match(out, /WEAK_ASSERTION\s+weak/);
  assert.match(out, /ok\s+fine/);
});

test("codegen: a price in a button name becomes a stable prefix", () => {
  assert.equal(locator({ role: "button", label: "Pay €121.54" }), 'page.getByRole("button", { name: new RegExp("^Pay") })');
});

test("codegen: refuses a failed run; emits spec inputs by key, never the value", () => {
  const flow = { name: "t", start: "/login.html", inputs: { email: "a@b.c" }, expectUrl: "done" };
  assert.throws(() => generate({ passed: false, outcome: "MAX_STEPS", steps: [] }, flow));
  const rec = { passed: true, outcome: "DONE_VERIFIED", engine: "jev", base, wallMs: 1, steps: [
    { n: 1, op: "TYPE_TEXT", label: "Email", role: "textbox", inputKey: "email", url: base + "/login.html" },
    { n: 2, op: "SELECT", label: "Growth in Plan", role: "option", option: "Growth", control: "Plan", url: base + "/login.html" }] };
  const { code } = generate(rec, flow);
  assert.match(code, /fill\(INPUTS\.email\)/);
  assert.match(code, /selectOption\(\{ label: "Growth" \}\)/);
});

import { compact, redactGoal } from "../src/loop.mjs";

test("security: no text-field content and no secret reaches the model payload", async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for=k>API key</label><input id=k value="sk-live-OLDSECRET-7f3a9c">
    <label for=n>Nickname</label><input id=n value="hunter2-OLDSECRET"><button>Save</button></form>`);
  const snap = await page.evaluate(`(${SNAPSHOT})()`);
  await page.close();
  const space = compact(snap, 30, new Set(), { nickname: "x" });
  const wire = JSON.stringify({ els: space.els, criteria: space.criteria, values: space.values });
  assert.ok(!wire.includes("OLDSECRET"), wire);
  assert.equal(snap.actions.find((a) => a.label === "API key" && a.kind === "fill").secret, true);
});

test("security: secret spec values are redacted from the goal", () => {
  assert.equal(redactGoal("Log in as a@b.c with Demo-Pass-42!", { email: "a@b.c", password: "Demo-Pass-42!" }),
    "Log in as a@b.c with <password>");
});

import { scrub } from "../src/secret.mjs";

test("security: fuzzy scrub catches re-cased, truncated, re-spaced and URL-encoded echoes", () => {
  const i = { password: "hunter2!vault", "api key": "sk-live-TRUNC-0123456789abcdef0123456789",
    passphrase: "correct  horse  battery", email: "a@b.c" };
  assert.deepEqual(scrub({ t: "Unlock HUNTER2!VAULT", b: "Rotate to sk-live-TRUNC-0123456789abcdef012",
    c: "say correct horse battery now", u: "?pw=hunter2%21vault&q=correct+horse+battery", e: "a@b.c stays" }, i),
  { t: "Unlock <password>", b: "Rotate to <api key>", c: "say <passphrase> now",
    u: "?pw=<password>&q=<passphrase>", e: "a@b.c stays" });
  assert.equal(scrub("Pay with 4111-2222-3333-6789", { "card number": "4111222233336789" }), "Pay with <card number>");
});

test("codegen: a spec key with a space emits valid bracket access; a secret key has no default", () => {
  const flow = { name: "t", start: "/", inputs: { "discount code": "WELCOME10", password: "Pw123456!" }, expectUrl: "x" };
  const rec = { passed: true, outcome: "DONE_VERIFIED", engine: "jev", base, wallMs: 1, steps: [
    { n: 1, op: "TYPE_TEXT", label: "Discount code", role: "textbox", inputKey: "discount code", url: base + "/" }] };
  const { code } = generate(rec, flow);
  assert.match(code, /fill\(INPUTS\["discount code"\]\)/);
  assert.ok(!code.includes("Pw123456!"));
  assert.match(code, /missing\("T_PASSWORD"\)/);
});

test("discover safe: a plain button and a switch are never clicked", async () => {
  const hits = [];
  const page = await browser.newPage();
  await page.exposeFunction("hit", (x) => hits.push(x));
  await page.close();
  const srv2 = (await import("node:http")).createServer((req, res) => {
    if (req.url.startsWith("/hit")) { hits.push(req.url); res.end(); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<main><button onclick="fetch('/hit-btn')">Archiver</button>
      <button role="switch" aria-checked="false" onclick="fetch('/hit-switch')">Notifications</button>
      <button aria-haspopup="menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Menu</button>
      <a href="/items/3/delete">Remove item</a></main>`);
  }).listen(0);
  await new Promise((r) => srv2.once("listening", r));
  await discover({ base: `http://127.0.0.1:${srv2.address().port}`, mode: "safe", browser });
  srv2.close();
  assert.deepEqual(hits, []);
});

test("security: a plain label that starts like a secret is not redacted (codegen stays exact)", () => {
  const inputs = { password: "Demo-Pass-42!" };
  assert.equal(scrub("Password", inputs), "Password");
  assert.equal(locator({ role: "password", label: "Password" }, { inputs }), 'page.getByRole("textbox", { name: "Password", exact: true })');
});

import { scrubSpecText, isStrong } from "../src/secret.mjs";

test("security: a weak secret never rewrites page words; it is still kept out of the spec text", () => {
  for (const pw of ["password", "admin", "test1234"]) assert.equal(isStrong(pw), false);
  const inputs = { password: "admin" };
  assert.equal(scrub("CLICK 3 Administrators [link]", inputs), "CLICK 3 Administrators [link]");
  assert.equal(scrub("Password", { password: "password" }), "Password");
  assert.equal(scrubSpecText("Log in with admin and open Administrators", inputs), "Log in with <password> and open Administrators");
});

test("security: a strong secret truncated to 8 characters is still scrubbed", () => {
  assert.equal(scrub("Rotate key k9Q!v7Zp", { "api key": "k9Q!v7Zp-x2" }), "Rotate key <api key>");
});

test("codegen: never emits an empty locator name", () => {
  assert.throws(() => locator({ role: "button", label: "Zq8$Lm2#Kp0!" }, { inputs: { password: "Zq8$Lm2#Kp0!" } }), /cannot emit/);
});

import { SEEN_TEXT } from "../src/loop.mjs";

test("expect reads what a sighted user sees; form controls contribute nothing", async () => {
  const page = await browser.newPage();
  await page.setContent(`<main><p>Total paid €1<span>21</span>.54</p><h3 style="text-transform:uppercase">Event</h3>
    <select id=s><option value="">Choose a plan…</option><option>Growth</option></select>
    <input id=t value="QuarterPush"><input type=password value="hunter2">
    <p style="display:none">Hidden A</p><p aria-hidden="true">Hidden B</p><p style="opacity:0">Hidden C</p>
    <div style="height:0;overflow:hidden"><p>Hidden D</p></div><p style="position:absolute;left:-10000px">Hidden E</p>
    <p style="font-size:0">Hidden F</p><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Hidden G</span>
    <div id=host></div><p>Access&#8203; code accepted</p></main>`);
  await page.evaluate(() => { const r = document.getElementById("host").attachShadow({ mode: "open" });
    r.innerHTML = "<p>From the shadow <slot></slot></p>"; });
  const read = () => page.evaluate(`(${SEEN_TEXT})()`);
  const t = await read();
  assert.match(t, /Total paid €121\.54/);
  assert.match(t, /EVENT/);
  assert.match(t, /From the shadow/);
  for (const bad of ["Growth", "QuarterPush", "hunter2", "Hidden", "Access code accepted"]) assert.ok(!t.includes(bad), `${bad} in: ${t}`);
  await page.selectOption("#s", { label: "Growth" });
  assert.ok(!(await read()).includes("Growth"), "a chosen option is state, not text");
  await page.close();
});

import { redactPatterns } from "../src/secret.mjs";

test("declared redaction: spec patterns replace page content before it leaves", () => {
  const out = redactPatterns({ l: ["Copy recovery code ABCD-EFGH-1234", "Order 100247"] }, [/recovery code \S+/i]);
  assert.deepEqual(out.l, ["Copy <redacted>", "Order 100247"]);
});

test("security: a card's last 4 are scrubbed in their masked display form only", () => {
  const i = { "card number": "4111222233336789" };
  assert.equal(scrub("Change card ending 6789", i), "Change card ending <card number>");
  assert.equal(scrub("Visa •••• 6789", i), "Visa •••• <card number>");
  const y = { "card number": "4111222233332026" };
  assert.equal(scrub("Open the 2026 report", y), "Open the 2026 report");
});

test("the fixture suite loads, and every fixture id is unique", async () => {
  const { FIXTURES } = await import("../fixtures/flows.mjs");
  const ids = FIXTURES.map((f) => f.id);
  assert.ok(ids.length > 30);
  assert.equal(new Set(ids).size, ids.length);
});

import { textPatterns } from "../src/redact.mjs";

test("redact text cut: whole tokens, separator-flexible, and never for texts under 4 characters", () => {
  const cut = (t, texts) => textPatterns(texts).reduce((x, re) => x.replace(re, "<redacted>"), t);
  assert.equal(cut("Copy code EEEE 5555 6666", ["EEEE-5555-6666"]), "Copy code <redacted>");
  assert.equal(cut("Order 4217 (€15), Order 3342, €42", ["42"]), "Order 4217 (€15), Order 3342, €42");
  assert.equal(cut("Apply Code:AB12CD34x and refAB12CD34 details", ["AB12CD34"]), "Apply Code:<redacted>x and ref<redacted> details");
  assert.equal(cut("Copy security code 737", ["737"]), "Copy security code 737");   // under 4: element-only, documented
});
