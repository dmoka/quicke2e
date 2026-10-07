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
(root) => {
  const out = [];
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "OPTGROUP", "DATALIST", "HEAD"]);
  // A sighted user's view: not opacity 0, not visibility hidden, not a zero-size clipping box
  // (a collapsed panel, an sr-only span), not scrolled off the page's top/left edge, not font-size 0.
  // (audit r7: all four false-passed "Payment confirmed" while "Payment failed" was on screen.)
  const shown = (el) => {
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute && el.hasAttribute("hidden")) return false;
    const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    // display:contents has no box, so checkVisibility() is false for it; its children are what shows.
    // Read it first (launch test 2026-10-07: SvelteKit wraps the whole body in <div style="display:
    // contents">, and every default SvelteKit page read as empty text).
    if (cs.display === "contents") return true;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    if (parseFloat(cs.fontSize) === 0) return false;
    const r = el.getBoundingClientRect();
    const sx = (el.ownerDocument.defaultView || window).scrollX, sy = (el.ownerDocument.defaultView || window).scrollY;
    const clips = cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
    // Off the page's top/left edge only for a box that clips its content: a 0x0 positioned pane at x=0
    // (Leaflet, Google Maps) holds visible popups, and pruning it made expectAbsent pass falsely (wave-2
    // test W5). Unclipped content is judged per text rect below (textShown).
    if (clips && (r.right + sx <= 0 || r.bottom + sy <= 0)) return false;
    if (clips && (r.width <= 1 || r.height <= 1)) return false;
    return true;
  };
  const inline = (el) => {
    const d = (el.ownerDocument.defaultView || window).getComputedStyle(el).display;
    // only plain inline boxes join without a space ("€1<span>21</span>" = "€121"); inline-block,
    // inline-flex and inline-grid are separate boxes: buttons side by side read "Rename Duplicate Delete",
    // not "RenameDuplicateDelete" (with case-insensitive matching that contained "duplicated": a false
    // ABSENT_SEEN, launch regression 2026-10-07)
    return d === "inline" || d === "contents";
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
  // TEXT-LEVEL VISIBILITY (launch test 2026-10-07: "Payment confirmed" in a transform:scale(0) box
  // false-passed while "Payment failed" was on screen; a drawer off the right edge, a clipped carousel
  // slide, color:transparent and clip-path:inset(50%) also counted). A text node counts only when one of
  // its line boxes is larger than 1x1 px and lies inside every clipping ancestor and inside the page
  // (the viewport, for a fixed subtree). The clip box is passed down the walk, so it is computed once
  // per element.
  const win = window, de = document.documentElement;
  const noScrollX = /hidden|clip/.test(getComputedStyle(de).overflowX + getComputedStyle(document.body || de).overflowX);
  const noScrollY = /hidden|clip/.test(getComputedStyle(de).overflowY + getComputedStyle(document.body || de).overflowY);
  const pageBox = { l: -win.scrollX, t: -win.scrollY,
    r: (noScrollX ? win.innerWidth : Math.max(de.scrollWidth, win.innerWidth)) - win.scrollX,
    b: (noScrollY ? win.innerHeight : Math.max(de.scrollHeight, win.innerHeight)) - win.scrollY };
  const viewBox = { l: 0, t: 0, r: win.innerWidth, b: win.innerHeight };
  const cut = (a, r) => ({ l: Math.max(a.l, r.left ?? r.l), t: Math.max(a.t, r.top ?? r.t), r: Math.min(a.r, r.right ?? r.r), b: Math.min(a.b, r.bottom ?? r.b) });
  const seen = (b) => b.r - b.l > 1 && b.b - b.t > 1;
  // alpha 0 only: rgba(r, g, b, 0) or rgb(r g b / 0) -- never rgb(0, 0, 0), which is black
  const clear = (c) => /^transparent$|^rgba\([^,]+,[^,]+,[^,]+,\s*0(\.0+)?\s*\)$|\/\s*0(\.0+)?\s*\)$/.test(c.trim());
  const textShown = (node, clip) => {
    if (!node.data.trim()) return true;
    const el = node.parentElement;
    if (el && clear(getComputedStyle(el).color)) return false;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1 && seen(cut(clip, r))) return true;
    return false;
  };
  const walk = (node, clip = pageBox) => {
    if (node.nodeType === 3) { if (node.parentElement?.ownerDocument !== document || textShown(node, clip)) out.push(transform(node.data, node.parentElement)); return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName) || !shown(el)) return;
    if (el.ownerDocument === document) {
      const cs = getComputedStyle(el);
      if (cs.contentVisibility === "hidden") return;
      if (/inset\(\s*(50|100)%|circle\(\s*0/.test(cs.clipPath)) return;
      if (cs.position === "fixed") clip = viewBox;
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clip = cut(clip, el.getBoundingClientRect());
    }
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
    else for (const k of kids(el)) walk(k, clip);
    if (block) out.push(" ");
  };
  // root: one element (the expectSeen recorder reads an inserted node with the same rules)
  if (root || document.body) walk(root || document.body);
  // Zero-width characters are KEPT: stripping them made the decoy "Access<U+200B> code accepted"
  // byte-equal to the expected "Access code accepted" -- a false pass (fixtures/aria-label.html).
  return out.join("").replace(/\s+/g, " ").trim();
}
