// discover: crawl an app once and write a MAP -- pages, the edges between them, and each page's
// forms. No model is involved here; this is plain Playwright plus the same in-page snapshot the
// loop uses, so the map describes exactly what the loop will later be offered.
//
// Two modes (docs/DECISIONS.md #5):
//   full -- follows links, clicks buttons/tabs/menus, opens dropdowns, AND submits forms with
//           spec inputs or deterministic defaults. Default on localhost only.
//   safe -- follows links, opens menus/dialogs/dropdowns to read them, never submits a form and
//           never clicks a control whose name looks final or destructive.
// A non-local host in full mode needs allowRemote (CLI: --i-own-this-data). Logout is never
// clicked in either mode: it would end the crawl's own session.
import { execSync } from "node:child_process";
import { scrub } from "./secret.mjs";
import { buildRedactor, redactSnapshot } from "./redact.mjs";
import { chromium, SNAPSHOT, settle, act, keyFor, norm } from "./loop.mjs";

const DESTRUCTIVE = /\b(delete|remove|destroy|refund|cancel|pay|purchase|buy|checkout|place order|confirm|submit|send|archive|deactivate|unsubscribe|revoke|reset|drop|book|save|create|update)\b/i;
const LOGOUT = /\b(log ?out|sign ?out)\b/i;
const FIELD_ROLES = new Set(["textbox", "password", "combobox", "checkbox", "radio", "switch", "spinbutton", "searchbox"]);
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/;

import { pattern } from "./discover-pattern.mjs";
export { pattern };

// Runs AFTER SNAPSHOT, so every candidate already carries its data-jev-node stamp.
const PAGEINFO = () => {
  const t = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
  const headings = [...document.querySelectorAll("h1,h2")].map(t).filter(Boolean).slice(0, 6);
  const links = [...document.querySelectorAll("a[href][data-jev-node]")].map((a) => ({
    node: a.getAttribute("data-jev-node"), href: a.href, text: t(a).slice(0, 60) }));
  const forms = [...document.querySelectorAll("form")].map((f, i) => {
    const nodes = [...f.querySelectorAll("[data-jev-node]")].map((e) => e.getAttribute("data-jev-node"));
    const sub = f.querySelector("button[type=submit],input[type=submit],button:not([type])");
    return { i, name: f.getAttribute("aria-label") || f.getAttribute("name") || t(f.querySelector("h1,h2,h3,legend")) || "",
      nodes, submit: sub?.getAttribute("data-jev-node") || null,
      required: [...f.querySelectorAll("[required],[aria-required=true]")].map((e) => e.getAttribute("data-jev-node")).filter(Boolean) };
  });
  return { headings, links, forms };
};

// Deterministic crawl values. Not a model: a field with no spec value gets a fixed, obviously
// synthetic value so the form can be submitted and the page behind it discovered.
function defaultFor(label, role) {
  const l = (label || "").toLowerCase();
  if (role === "password" || /password|passphrase/.test(l)) return "Quicke2e-123!";
  if (/e-?mail/.test(l)) return "quicke2e@example.com";
  if (/phone|tel/.test(l)) return "+15555550100";
  if (/qty|quantity|number|amount|count|tickets?\b|seats?/.test(l)) return "1";
  if (/url|website/.test(l)) return "https://example.com";
  if (/date/.test(l)) return "2030-01-01";
  if (/code|coupon|promo|discount/.test(l)) return "";
  if (/search|filter/.test(l)) return "";
  return "quicke2e";
}

async function snap(page, redact = []) {
  await settle(page);
  let s;
  try { s = await page.evaluate(`(${SNAPSHOT})()`); }
  catch { await page.waitForTimeout(150); s = await page.evaluate(`(${SNAPSHOT})()`); }
  // declared redaction applies to the map on disk too (audit r9)
  if (redact.length) { const r = await buildRedactor(page, redact); redactSnapshot(s, r); s.redactor = r; }
  return s;
}

export async function discover({ base, start = ["/"], mode = "full", allowRemote = false, reset,
  storageState, inputs = {}, redact = [], maxPages = 40, perPattern = 2, maxProbes = 20, browser: shared,
  log = () => {} } = {}) {
  base = base.replace(/\/$/, "");
  const host = new URL(base).hostname;
  if (mode === "full" && !LOCAL.test(host) && !allowRemote)
    throw new Error(`full crawl on non-local host ${host} refused: it submits forms and changes data. `
      + `Use mode "safe", or pass --i-own-this-data if this is a throwaway environment.`);
  if (reset) { log(`reset: ${reset}`); execSync(reset, { stdio: "ignore" }); }

  const t0 = performance.now();
  const browser = shared || await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    ...(storageState ? { storageState } : {}) });
  const page = await context.newPage();
  const origin = new URL(base).origin;
  const pages = new Map();          // pattern -> page record
  const edges = [];
  const edgeKey = new Set();
  const queue = start.map((s) => base + s);
  const seenUrl = new Set();
  const addEdge = (e) => {
    const k = `${e.fromUrl}|${e.toUrl}|${e.via.op}|${e.via.label}`;
    if (edgeKey.has(k)) return; edgeKey.add(k); edges.push(e);
  };
  const enqueue = (u) => {
    let url; try { url = new URL(u); } catch { return; }
    if (url.origin !== origin) return;
    url.hash = "";
    const s = url.toString();
    if (seenUrl.has(s) || queue.includes(s)) return;
    const p = pattern(s);
    const known = pages.get(p);
    if (known && known.urls.length >= perPattern) return;
    queue.push(s);
  };
  const goto = async (u) => { await page.goto(u, { waitUntil: "domcontentloaded" }); return snap(page, redact); };

  while (queue.length && pages.size < maxPages) {
    const url = queue.shift();
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    const p = pattern(url);
    if (pages.get(p)?.urls.length >= perPattern) continue;
    let s;
    try { s = await goto(url); } catch (e) { log(`skip ${url}: ${e.message.slice(0, 80)}`); continue; }
    const landed = page.url();
    if (landed !== url) {           // a redirect (auth wall, trailing slash, default tab)
      addEdge({ from: p, fromUrl: url, to: pattern(landed), toUrl: landed, via: { op: "redirect", role: null, label: null } });
      enqueue(landed); continue;
    }
    const info = await page.evaluate(PAGEINFO);
    if (s.redactor) {
      info.headings = info.headings.map(s.redactor.cut);
      for (const l of info.links) { l.text = s.redactor.cut(l.text); l.href = s.redactor.url(l.href); }
    }
    const byNode = new Map();
    for (const a of s.actions) if (!byNode.has(a.node) || a.kind === "fill") byNode.set(a.node, a);
    const rec = pages.get(p) || { pattern: p, urls: [], title: s.title, headings: info.headings,
      forms: [], reveals: [], counts: {} };
    rec.urls.push(url);
    pages.set(p, rec);
    const first = rec.urls.length === 1;   // forms/probes only on the first instance of a pattern
    log(`page ${p}  (${url.replace(origin, "")})`);

    // 1. links: edges for free, read off href, no click needed
    for (const l of info.links) {
      if (LOGOUT.test(l.text)) continue;
      // SAFE mode: a GET link can still mutate (/items/3/delete). Not followed when its text or URL
      // names a destructive verb. Best effort -- the README says: safe is a guard, not a guarantee.
      if (mode !== "full" && (DESTRUCTIVE.test(l.text) || DESTRUCTIVE.test(decodeURIComponent(new URL(l.href, url).pathname).replace(/[-_/]/g, " ")))) continue;
      const a = byNode.get(l.node);
      if (!/^https?:/.test(l.href) || new URL(l.href).origin !== origin) continue;
      addEdge({ from: p, fromUrl: url, to: pattern(l.href), toUrl: l.href.replace(/#.*$/, ""),
        via: { op: "link", role: "link", label: a?.label || l.text } });
      enqueue(l.href);
    }
    if (!first) continue;

    // 2. forms: fields, options, the submit control
    const inForm = new Set();
    for (const f of info.forms) {
      const fields = [];
      for (const n of f.nodes) {
        inForm.add(n);
        const a = byNode.get(n); if (!a) continue;
        if (n === f.submit) continue;
        if (!FIELD_ROLES.has(a.role)) continue;
        const opts = s.actions.filter((x) => x.node === n && x.kind === "select").map((x) => x.label);
        fields.push({ role: a.role, label: a.label, node: n, required: f.required.includes(n),
          ...(opts.length ? { options: opts.slice(0, 20) } : {}) });
      }
      const sub = f.submit && byNode.get(f.submit);
      rec.forms.push({ name: f.name, fields, submit: sub ? { role: sub.role, label: sub.label, node: f.submit } : null });
    }
    rec.counts = { links: info.links.length, controls: byNode.size, forms: info.forms.length };

    // 3. comboboxes (inside forms too): open once, read the options, close
    for (const f of rec.forms) for (const fld of f.fields) {
      if (fld.role !== "combobox" || fld.options) continue;
      try {
        await act(page, { node: fld.node, role: "combobox", label: fld.label }, (loc, t) => loc.click({ timeout: t }));
        const after = await snap(page, redact);
        const opts = after.actions.filter((x) => x.popup && (x.role === "option" || x.role === "menuitem")).map((x) => x.label);
        if (opts.length) fld.options = [...new Set(opts)].slice(0, 20);
        await page.keyboard.press("Escape");
      } catch {}
    }

    // 4. probe non-link, non-form clickables: does it navigate, open something, or nothing?
    // SAFE mode is STRUCTURAL, not a word list (audit C1: 7/7 mutating controls fired, the name regex
    // is English-only): it probes only controls that declare they open something -- aria-haspopup,
    // aria-expanded, a tab, a combobox. Never a plain button, a switch, or a submit.
    const opener = (a) => a.haspopup || a.expanded !== undefined || a.role === "tab" || a.role === "combobox";
    const probes = [...byNode.values()].filter((a) => a.kind === "click" && !a.popup && a.role !== "link"
      && !inForm.has(a.node) && ["button", "tab", "menuitem", "combobox", "switch"].includes(a.role)
      && !LOGOUT.test(a.label) && (mode === "full" || (opener(a) && a.role !== "switch" && !a.submit)))
      .slice(0, maxProbes);
    for (const a of probes) {
      try {
        if (page.url() !== url) await goto(url);
        const before = new Set((await snap(page, redact)).actions.map((x) => x.label));
        await act(page, a, (loc, t) => loc.click({ timeout: t }));
        await page.waitForURL((u) => u.toString() !== url, { timeout: 800 }).catch(() => {});
        if (page.url() !== url) {
          addEdge({ from: p, fromUrl: url, to: pattern(page.url()), toUrl: page.url(),
            via: { op: "click", role: a.role, label: a.label } });
          enqueue(page.url());
          continue;
        }
        const after = await snap(page, redact);
        const fresh = [...new Set(after.actions.map((x) => x.label))].filter((l) => !before.has(l));
        if (fresh.length) rec.reveals.push({ via: { role: a.role, label: a.label }, items: fresh.slice(0, 15) });
        await page.keyboard.press("Escape");
      } catch {}
    }

    // 5. full mode: submit each form once to find the page behind it
    if (mode !== "full") continue;
    for (const f of rec.forms) {
      if (!f.submit || LOGOUT.test(f.submit.label)) continue;
      try {
        await goto(url);
        for (const fld of f.fields) {
          const act1 = { node: fld.node, role: fld.role, label: fld.label };
          if (fld.role === "textbox" || fld.role === "password") {
            const k = keyFor(fld.label, inputs, fld.role);
            const v = k !== null ? inputs[k] : defaultFor(fld.label, fld.role);
            if (v) await act(page, act1, (loc, t) => loc.fill(String(v), { timeout: t }));
          } else if (fld.role === "checkbox" && fld.required) {
            await act(page, act1, (loc, t) => loc.check({ timeout: t }));
          } else if (fld.role === "combobox" && fld.options?.length) {
            const want = fld.options.find((o) => !/^(select|choose|pick)\b/i.test(o)) || fld.options[0];
            const native = s.actions.some((x) => x.node === fld.node && x.kind === "select");
            if (native) await act(page, act1, (loc, t) => loc.selectOption({ label: want }, { timeout: t }));
            else {
              await act(page, act1, (loc, t) => loc.click({ timeout: t }));
              await page.getByRole("option", { name: want, exact: true }).first().click({ timeout: 1500 });
            }
          }
        }
        const beforeText = norm(await page.evaluate(() => document.body.innerText));
        await act(page, f.submit, (loc, t) => loc.click({ timeout: t }));
        await page.waitForURL((u) => u.toString() !== url, { timeout: 3000 }).catch(() => {});
        await settle(page);
        if (page.url() !== url) {
          addEdge({ from: p, fromUrl: url, to: pattern(page.url()), toUrl: page.url(),
            via: { op: "submit", role: f.submit.role, label: f.submit.label, form: f.name } });
          f.result = { navigates: pattern(page.url()) };
          enqueue(page.url());
        } else {
          const text = norm(await page.evaluate(() => document.body.innerText));
          f.result = { stays: true, message: text.replace(beforeText, "").slice(0, 160) || null };
        }
      } catch (e) { f.result = { error: String(e.message || e).slice(0, 120) }; }
    }
  }
  for (const r of pages.values()) for (const f of r.forms) {
    for (const fld of f.fields) delete fld.node;
    if (f.submit) delete f.submit.node;
  }

  await context.close();
  if (!shared) await browser.close();
  // SECURITY (audit): the map on disk is scrubbed of secret spec values (a GET form's toUrl).
  return scrub({ version: 1, base, mode, createdAt: new Date().toISOString(),
    ms: Math.round(performance.now() - t0), pages: [...pages.values()], edges,
    unvisited: queue.slice(0, 50) }, inputs);
}
