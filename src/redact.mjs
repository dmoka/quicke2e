// Declared redaction, shared by the loop (every snapshot) and discover (the map on disk).
//   redact: [".backup-code", "#card-picker", /recovery code \S+/i]
// Strings are CSS selectors, RegExps are text patterns. Applied AT THE SOURCE, before any label,
// title, criterion, trace or map entry is built from the page.
//
// Selectors: every matching element -- in the document, open shadow roots and same-origin iframes --
// gives up its text; that text is then cut out of every page-derived string (the label of a button
// that CONTAINS it, a name resolved through aria-labelledby, option labels), and candidates inside a
// match are renamed outright. The cut is separator-flexible ("EEEE-5555-6666" also matches
// "EEEE 5555 6666"); whole-token for ordinary texts, substring for long letter+digit codes; and only
// for texts of 4+ letters/digits: a 2-character match ("42") cut every "42" on the page, prices
// included (audit r9). A short match (a 3-digit CVC) is still renamed as an element; its text is
// just not hunted elsewhere.
// Regexes: applied to raw labels, titles and URLs. Text outside any element (the page title) can
// only be declared this way -- a selector cannot know that text is sensitive.

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function textPatterns(texts) {
  const out = [];
  for (const t of new Set(texts)) {
    const chars = [...t].filter((c) => /[A-Za-z0-9]/.test(c));
    if (chars.length < 4) continue;
    const body = chars.map(esc).join("[\\s\\-./:]*");
    // A long text mixing letters and digits ("AB12CD34") cannot collide with ordinary words, so it
    // is cut as a SUBSTRING, even glued to other text ("Code:AB12CD34x", audit r10). Shorter or
    // single-class texts keep word boundaries -- that is what keeps "42" out of "€42" and "4217".
    const strong = chars.length >= 8 && /[A-Za-z]/.test(chars.join("")) && /\d/.test(chars.join(""));
    out.push(new RegExp(strong ? body : `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi"));
  }
  return out;
}

export async function buildRedactor(page, redact = []) {
  const sels = redact.filter((x) => typeof x === "string");
  const res = redact.filter((x) => x instanceof RegExp)
    .map((r) => new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g"));
  let texts = [], inside = new Set();
  if (sels.length) {
    const r = await page.evaluate((q) => {
      const found = [], nodes = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
          if (el.matches(q)) found.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === "IFRAME") { let d = null; try { d = el.contentDocument; } catch {} if (d) walk(d); }
        }
      };
      walk(document);
      const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      for (const el of found) for (const n of [el, ...el.querySelectorAll("[data-jev-node]")])
        if (n.getAttribute("data-jev-node")) nodes.push(n.getAttribute("data-jev-node"));
      // a <select>'s text is all its options joined, so each option is collected on its own too
      const texts = found.flatMap((el) => [text(el), ...[...el.querySelectorAll("option")].map(text)]);
      return { texts, nodes };
    }, sels.join(",")).catch(() => ({ texts: [], nodes: [] }));
    texts = r.texts; inside = new Set(r.nodes);
  }
  const pats = [...textPatterns(texts), ...res];
  const cut = (t) => (t == null ? t : pats.reduce((x, re) => x.replace(re, "<redacted>"), String(t)));
  return {
    active: pats.length > 0 || inside.size > 0,
    cut,
    url: (u) => (u == null ? u : res.reduce((x, re) => x.replace(re, "<redacted>"), String(u))),
    isInside: (node) => inside.has(node),
  };
}

// Apply a redactor to a snapshot in place.
export function redactSnapshot(snap, r) {
  if (!r.active) return;
  snap.title = r.cut(snap.title);
  snap.text = r.cut(snap.text);
  for (const a of snap.actions) {
    if (r.isInside(a.node) || r.isInside(a.selectNode)) {
      a.label = "<redacted>"; if (a.optionLabel) a.optionLabel = "<redacted>";
      if (a.kind === "state" || a.kind === "fill") a.value = "<redacted>";
    }
    a.label = r.cut(a.label); if (a.optionLabel) a.optionLabel = r.cut(a.optionLabel);
    if (a.selectLabel) a.selectLabel = r.cut(a.selectLabel);
    if (typeof a.value === "string") a.value = r.cut(a.value);
  }
}

// Parse CLI --redact values: "/pattern/flags" is a RegExp, anything else a CSS selector.
export function parseRedactArg(v) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(v);
  return m ? new RegExp(m[1], m[2]) : v;
}
