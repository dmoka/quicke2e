// Verified locators for the emitted Playwright spec (v0.4, Round 2).
//
// Measured in the 2026-10-04 new-user test: 3 of 7 (toolshop) and 3 of 9 (saucedemo) emitted specs
// replayed. Causes: a name shared by six "Add to cart" buttons (strict-mode violation), our role
// vocabulary ("textbox") against the real ARIA role ("spinbutton"), and our accessible name against
// Playwright's ("Thor Hammer A B C D E" vs "Thor Hammer Compare CO₂: A B C D E $11.14").
//
// So the locator is not GUESSED at codegen time from the trace; it is built and VERIFIED on the live
// page, before the action, while the element exists: a candidate wins only when it matches exactly
// one element AND that element is the one the run is about to act on. Candidates, in order:
//   1. getByRole(role, { name, exact }) with Playwright's OWN role and name (from ariaSnapshot)
//   2. that, scoped to the nearest row/listitem/article/card holding the element, filtered by a text
//      only that container has (the product name next to "Add to cart")
//   3. getByLabel / getByPlaceholder / getByTestId
//   4. the role locator with .nth(i): position on the page -- deterministic for the same data, last
// Returns { code, how } where code starts with "page." , or null (element in an iframe, gone, or
// nothing unique was found).

const q = (s) => JSON.stringify(String(s));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "Pay €109.39": a price in a name breaks the replay on any price change; match the stable prefix.
const PRICED = /^(.*?\S)\s*(?:[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?[€$£]).*$/;
const CONTAINER_ROLES = ["listitem", "row", "article", "gridcell", "cell", "group", "region"];

function parseAria(yaml) {
  const first = String(yaml || "").split("\n")[0];
  const m = /^- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(first);
  return m ? { role: m[1], name: m[2] != null ? m[2].replace(/\\"/g, '"') : "" } : null;
}

// Build a Playwright locator from the same code string we will emit, so verification and the spec
// can never disagree.
function build(page, code) {
  // eslint-disable-next-line no-new-func
  return new Function("page", `return ${code};`)(page);
}

async function uniqueAndSame(page, code, handle) {
  try {
    const loc = build(page, code);
    if ((await loc.count()) !== 1) return false;
    return await loc.evaluate((el, h) => el === h, handle);
  } catch { return false; }
}

export async function verifiedLocator(page, selector) {
  const target = page.locator(selector).first();
  let handle;
  try { if (!(await target.count())) return null; handle = await target.elementHandle({ timeout: 500 }); }
  catch { return null; }
  if (!handle) return null;
  try {
    const aria = parseAria(await target.ariaSnapshot({ timeout: 500 }).catch(() => ""));
    const tries = [];
    if (aria?.role && aria.name) {
      const priced = PRICED.exec(aria.name);
      const nameArg = priced ? `{ name: new RegExp(${q("^" + escapeRe(priced[1]))}) }` : `{ name: ${q(aria.name)}, exact: true }`;
      const byRole = `page.getByRole(${q(aria.role)}, ${nameArg})`;
      tries.push([byRole, "role"]);
      // 2. scoped to the container that holds exactly this match
      const scope = await target.evaluate((el, roles) => {
        const roleOf = (n) => n.getAttribute("role") || ({ LI: "listitem", TR: "row", ARTICLE: "article", TD: "cell" })[n.tagName] || null;
        for (let n = el.parentElement, depth = 0; n && depth < 8; n = n.parentElement, depth++) {
          const r = roleOf(n);
          if (!r || !roles.includes(r)) continue;
          const own = (n.innerText || "").split("\n").map((t) => t.trim()).filter((t) => t.length >= 3 && t.length <= 60);
          return { role: r, texts: own.slice(0, 6) };
        }
        return null;
      }, CONTAINER_ROLES).catch(() => null);
      if (scope) for (const t of scope.texts)
        tries.push([`page.getByRole(${q(scope.role)}).filter({ hasText: ${q(t)} }).getByRole(${q(aria.role)}, ${nameArg})`, "scoped"]);
    }
    // 3. label / placeholder / test id
    const attrs = await target.evaluate((el) => ({ label: el.labels?.[0]?.innerText?.trim() || null,
      ph: el.getAttribute("placeholder"), tid: el.getAttribute("data-testid") || el.getAttribute("data-test") })).catch(() => ({}));
    if (attrs.label) tries.push([`page.getByLabel(${q(attrs.label)}, { exact: true })`, "label"]);
    if (attrs.ph) tries.push([`page.getByPlaceholder(${q(attrs.ph)}, { exact: true })`, "placeholder"]);
    if (attrs.tid) tries.push([`page.locator(${q(`[data-testid="${attrs.tid}"],[data-test="${attrs.tid}"]`)})`, "testid"]);
    // 3b. a control with a role but no accessible name (antd's slider handle): the role alone, when unique
    const unnamed = aria?.role && !aria.name && aria.role !== "generic" ? `page.getByRole(${q(aria.role)})` : null;
    if (unnamed) tries.push([unnamed, "role"]);
    for (const [code, how] of tries) if (await uniqueAndSame(page, code, handle)) return { code, how };
    // 4. position among the role matches
    if ((aria?.role && aria.name) || unnamed) {
      const all = build(page, aria.name ? tries[0][0] : unnamed);
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < n && i < 50; i++) {
        const same = await all.nth(i).evaluate((el, h) => el === h, handle).catch(() => false);
        if (same) return { code: `${aria.name ? tries[0][0] : unnamed}.nth(${i})`, how: "nth" };
      }
    }
    return null;
  } finally { await handle.dispose().catch(() => {}); }
}

export { parseAria };
