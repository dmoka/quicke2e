// route: use a discovered MAP to get the loop to the right page before it starts deciding.
//
//   1. Jev picks the TARGET page pattern for the goal -- one typed choice over the map's pages.
//   2. If that pattern has ids (/events/:id), Jev picks the instance by the label of the link
//      that leads there ("Summer Jam") -- a second typed choice.
//   3. Code finds the route (BFS over the map's edges) and walks it by role + label. No model.
// The loop then runs as usual from the target page. The model never navigates blind; it only
// makes the local choices it is good at.
import { choose, settle, ARIA } from "./loop.mjs";

const RULES = "Pick the page this goal needs: the page that holds the form or control the goal " +
  "uses first, or the page the goal asks to reach. Pick STAY if the start page already has it.";
const MAX = 48;   // under the 52-letter ceiling, with room for STAY

function describe(p) {
  const bits = [p.pattern, p.headings?.[0] || p.title || ""];
  for (const f of p.forms || []) {
    const fields = f.fields.map((x) => x.label).slice(0, 5).join(", ");
    bits.push(`form ${f.submit?.label || f.name || ""}${fields ? ` (${fields})` : ""}`);
  }
  return bits.filter(Boolean).join(" | ").slice(0, 160);
}

// Cheap lexical prefilter when a map has more pages than the engine can take in one choice.
function prefilter(pages, goal) {
  if (pages.length <= MAX) return pages;
  const words = new Set(goal.toLowerCase().match(/[a-z]{3,}/g) || []);
  const score = (p) => (describe(p).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => words.has(w)).length;
  return [...pages].sort((a, b) => score(b) - score(a)).slice(0, MAX);
}

export async function pickTarget(map, goal, engine, startPattern, inputs, redact = []) {
  const pages = prefilter(map.pages, goal);
  const criteria = { STAY: `stay on the start page ${startPattern}` };
  pages.forEach((p, i) => { criteria[`PAGE:${i}`] = describe(p); });
  const state = { app: map.base.replace(/^https?:\/\//, ""), start: startPattern, pages: pages.length };
  const d = await choose({ state, criteria, goal, rules: RULES, engine, inputs, redact });
  const out = { cost: d.cost || 0, ms: d.ms, decisions: [{ choice: d.choice, confidence: d.confidence }] };
  if (d.choice === "STAY" || !String(d.choice).startsWith("PAGE:")) return { ...out, target: null };
  const page = pages[Number(d.choice.split(":")[1])];
  // One instance, or an id-free pattern: done.
  const into = map.edges.filter((e) => e.to === page.pattern && e.via.label);
  const byUrl = new Map();
  for (const e of into) if (!byUrl.has(e.toUrl)) byUrl.set(e.toUrl, e);
  if (!page.pattern.includes(":id") || byUrl.size <= 1)
    return { ...out, target: page.urls[0], pattern: page.pattern };
  const inst = [...byUrl.values()].slice(0, MAX);
  const c2 = {};
  inst.forEach((e, i) => { c2[`URL:${i}`] = `${e.via.label} -> ${new URL(e.toUrl).pathname}`; });
  const d2 = await choose({ state: { ...state, pattern: page.pattern }, criteria: c2, goal,
    rules: "Pick the item this goal is about.", engine, inputs, redact });
  out.cost += d2.cost || 0; out.ms += d2.ms;
  out.decisions.push({ choice: d2.choice, confidence: d2.confidence });
  const e = inst[Number(String(d2.choice).split(":")[1])] || inst[0];
  return { ...out, target: e.toUrl, pattern: page.pattern };
}

// Shortest walk over concrete URLs. Redirect edges are free hops.
export function findRoute(map, fromUrl, toUrl) {
  const strip = (u) => u.replace(/#.*$/, "");
  fromUrl = strip(fromUrl); toUrl = strip(toUrl);
  if (fromUrl === toUrl) return [];
  const prev = new Map([[fromUrl, null]]);
  const q = [fromUrl];
  while (q.length) {
    const u = q.shift();
    for (const e of map.edges) {
      if (strip(e.fromUrl) !== u || prev.has(strip(e.toUrl))) continue;
      if (e.via.op === "submit") continue;   // routing never submits a form: that is the test's job
      prev.set(strip(e.toUrl), e);
      if (strip(e.toUrl) === toUrl) {
        const path = [];
        for (let x = toUrl; prev.get(x); x = strip(prev.get(x).fromUrl)) path.unshift(prev.get(x));
        return path;
      }
      q.push(strip(e.toUrl));
    }
  }
  return null;
}

// Walk the route by role + label, like a user. Falls back to a direct goto if a hop fails.
export async function walk(page, route, target) {
  const hops = [];
  for (const e of route || []) {
    if (e.via.op === "redirect") continue;
    const before = page.url();
    try {
      const role = ARIA[e.via.role] || "link", name = e.via.label;
      try { await page.getByRole(role, { name, exact: true }).first().click({ timeout: 1500 }); }
      catch { await page.getByRole(role, { name }).first().click({ timeout: 1500 }); }
      await page.waitForURL((u) => u.toString() !== before, { timeout: 3000 }).catch(() => {});
      await settle(page);
      hops.push({ role, label: e.via.label, ok: true });
    } catch { hops.push({ role: e.via.role, label: e.via.label, ok: false }); break; }
  }
  return hops;
}
