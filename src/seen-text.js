// Injected into the page. The text a USER perceives, which is what `expect` asserts against.
//
// document.body.innerText is not that: a closed <select> contributes EVERY option, so
// expect:["Growth"] is true before anything is chosen (fixtures/select.html), and Radix's
// visually-hidden native <select> put every client's name on a page nobody had touched. It also
// cannot see a typed input value, and it does not enter shadow roots or iframes.
//
// Rules: text a sighted user sees, in the flat tree (shadow roots through their slots, same-origin
// iframes); form controls contribute nothing (assert them with expectState); hidden, aria-hidden,
// transparent, clipped-to-nothing and off-page text is skipped; spaces around block boxes only, so
// "€1<span>21</span>" stays "€121".
() => {
  const out = [];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "OPTGROUP", "DATALIST", "HEAD"]);
  // A sighted user's view: not opacity 0, not visibility hidden, not a zero-size clipping box
  // (a collapsed panel, an sr-only span), not scrolled off the page's top/left edge, not font-size 0.
  // (audit r7: all four false-passed "Payment confirmed" while "Payment failed" was on screen.)
  const shown = (el) => {
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute && el.hasAttribute("hidden")) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (parseFloat(cs.fontSize) === 0) return false;
    if (cs.display === "contents") return true;
    const r = el.getBoundingClientRect();
    const sx = (el.ownerDocument.defaultView || window).scrollX, sy = (el.ownerDocument.defaultView || window).scrollY;
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
    const clips = cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
    if (clips && (r.width <= 1 || r.height <= 1)) return false;
    return true;
  };
  const inline = (el) => {
    const d = (el.ownerDocument.defaultView || window).getComputedStyle(el).display;
    return d.startsWith("inline") || d === "contents";
  };
  const kids = (el) => el.tagName === "SLOT"
    ? (el.assignedNodes({ flatten: true }).length ? el.assignedNodes({ flatten: true }) : [...el.childNodes])
    : el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
  // CSS text-transform is part of what a user sees ("EVENT"), as innerText also reflects.
  const transform = (text, el) => {
    const tt = el ? (el.ownerDocument.defaultView || window).getComputedStyle(el).textTransform : "none";
    if (tt === "uppercase") return text.toUpperCase();
    if (tt === "lowercase") return text.toLowerCase();
    if (tt === "capitalize") return text.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
    return text;
  };
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(transform(node.data, node.parentElement)); return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName) || !shown(el)) return;
    const tag = el.tagName;
    // Form controls contribute NOTHING. A control's value is not a RESULT of the work -- the loop
    // typed or chose it itself (audit r7: expect "QuarterPush" matched our own typed input while
    // Save did nothing), and a <select>'s option list was the original false pass. Assert a
    // control's state with expectState: [{ role, name, value }].
    if (tag === "SELECT" || tag === "TEXTAREA" || tag === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["submit", "button", "reset"].includes(t)) out.push(" " + el.value + " ");   // a button's caption is text
      return;
    }
    const block = !inline(el);
    if (block) out.push(" ");
    if (tag === "IFRAME") { let d = null; try { d = el.contentDocument; } catch {} if (d?.body) walk(d.body); }
    else for (const k of kids(el)) walk(k);
    if (block) out.push(" ");
  };
  if (document.body) walk(document.body);
  // Zero-width characters are KEPT: stripping them made the decoy "Access<U+200B> code accepted"
  // byte-equal to the expected "Access code accepted" -- a false pass (fixtures/aria-label.html).
  return out.join("").replace(/\s+/g, " ").trim();
}
