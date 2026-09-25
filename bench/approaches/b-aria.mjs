// B : Playwright's AI aria snapshot -> options. page.ariaSnapshotJSON({mode:"ai"}) (Playwright
// 1.63) returns the accessibility tree with [ref=eN] handles, walks open shadow roots, and inlines
// same-origin <iframe>s (refs f1eN). Act: page.locator("aria-ref=<ref>"), then the src/ role chain.
//
// Mapping rules (all deterministic, all from the tree):
//   - actionable roles below -> one action; nodes under an ariaHidden subtree are skipped (a modal
//     MUI/Radix listbox hides the app, which is exactly "its options are the only legal moves").
//   - `generic` with cursor=pointer, its own text, and no actionable descendant -> a click action
//     (antd renders visible option rows as plain divs; the role=option nodes are a 0x0 mirror).
//   - a checkbox/radio with NO ref (Shoelace: the <input> is not actionable) -> acted through the
//     nearest ancestor that has a ref and cursor=pointer (its <label part=base>).
//   - a combobox with option children is a native <select> -> one SELECT per option.
//   - option/menuitem under a listbox/menu that is not a native select -> popup (drops WAIT/DONE).
//   - textbox: ONE extra evaluate per textbox reads type + name attr. The tree has no input type,
//     so without it a password is indistinguishable and its value is in the tree as plain text.
import { roleFallback, viaLabel } from "../lib/core.mjs";

const ACTION_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "spinbutton"]);
const FILL = new Set(["textbox", "searchbox", "spinbutton"]);
const nodeText = (n) => n.name || n.text || (n.children || []).map((c) => (typeof c === "string" ? c : c.role === "text" ? c.text : "")).join(" ").trim();
const deepText = (n) => [n.name, n.text, ...(n.children || []).map((c) => (typeof c === "string" ? c : deepText(c)))].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
const hasActionable = (n) => (n.children || []).some((c) => typeof c === "object" && ((ACTION_ROLES.has(c.role) && c.ref) || hasActionable(c)));

export async function snapshotB(page) {
  const tree = await page.ariaSnapshotJSON({ mode: "ai" });
  const actions = [];
  const walk = (n, anc) => {
    if (typeof n !== "object" || !n) return;
    if (n.ariaHidden) return;
    const role = n.role;
    const up = [...anc, n];
    const inCombo = anc.some((a) => a.role === "combobox");
    if (ACTION_ROLES.has(role) && !n.disabled) {
      let ref = n.ref, proxy = false;
      if (!ref && (role === "checkbox" || role === "radio")) {
        const host = [...anc].reverse().find((a) => a.ref && a.cursor === "pointer");
        if (host) { ref = host.ref; proxy = true; }
      }
      const label = (n.name || (FILL.has(role) || role === "combobox" ? "" : nodeText(n) || deepText(n)) || "").slice(0, 80);
      if (role === "combobox" && (n.children || []).some((c) => c.role === "option")) {
        // native <select>: options are children of the combobox and carry no ref of their own
        const opts = n.children.filter((c) => c.role === "option");
        const cur = opts.find((o) => o.selected);
        opts.forEach((o, i) => { const ol = nodeText(o);
          if (ref) actions.push({ kind: "select", node: `${ref}#${i}`, selectNode: ref, ref, selectLabel: label, optionLabel: ol,
            label: `${label}: ${ol}`, value: i === 0 && /choose|select|--/i.test(ol) ? "" : ol, current_value: cur ? nodeText(cur) : "", role: "option", popup: false }); });
        actions.push({ kind: "state", node: ref, label, role, value: cur ? nodeText(cur) : "" });
      } else if (ref && !(inCombo && role === "option")) {
        const popup = (role === "option" || role.startsWith("menuitem")) && anc.some((a) => a.role === "listbox" || a.role === "menu");
        const value = role === "combobox" ? (n.text || "") : FILL.has(role) ? (n.text || "") : "";
        const base = { node: ref, ref, label: label || "(unlabeled)", role, popup, value, proxy,
          ...(n.checked !== undefined ? { checked: n.checked === true } : role === "checkbox" || role === "radio" ? { checked: false } : {}),
          ...(n.expanded !== undefined ? { expanded: n.expanded } : {}), ...(n.selected !== undefined ? { selected: n.selected } : {}) };
        if (FILL.has(role)) actions.push({ ...base, kind: "fill" });
        actions.push({ ...base, kind: "click" });
      }
    } else if (role === "generic" && n.ref && n.cursor === "pointer" && (n.name || n.text) && !hasActionable(n)) {
      const t = (n.name || n.text).slice(0, 60);
      const popup = false;
      actions.push({ kind: "click", node: n.ref, ref: n.ref, label: t, role: "clickable", popup, value: "" });
    }
    for (const c of n.children || []) walk(c, up);
  };
  for (const n of Array.isArray(tree) ? tree : [tree]) walk(n, []);
  // enrichment, one evaluate each: textboxes (input type, so a password is known) and any
  // unlabeled node (the name attribute, which is A's last-resort name too)
  const info = new Map();
  for (const a of actions) {
    const unl = a.label === "(unlabeled)" || a.selectLabel === "";
    if (a.kind !== "fill" && !unl) continue;
    if (!info.has(a.ref)) info.set(a.ref, await page.locator(`aria-ref=${a.ref}`).evaluate((el) =>
      ({ type: (el.type || "").toLowerCase(), name: el.getAttribute("name") || "" }), null, { timeout: 500 }).catch(() => null));
    const i = info.get(a.ref); if (!i) continue;
    if (a.kind === "fill" && i.type === "password") { a.role = "password"; a.secret = true; }
    if (a.label === "(unlabeled)" && i.name) a.label = i.name;
    if (a.selectLabel === "" && i.name) { a.selectLabel = i.name; a.label = `${i.name}: ${a.optionLabel}`; }
  }
  for (const a of actions) if (a.kind === "click" && a.role === "textbox") {
    const f = actions.find((x) => x.kind === "fill" && x.node === a.node); if (f) { a.role = f.role; a.label = f.label; a.secret = f.secret; }
  }
  return { url: page.url(), title: await page.title(), text: "", actions };
}

export async function actB(page, action, fn) {
  const loc = page.locator(`aria-ref=${action.ref ?? action.node}`);
  try { await fn(loc, 1200); return action.proxy ? "ref-host" : "ref"; } catch {}
  if (action.role === "checkbox" || action.role === "radio") { try { return await viaLabel(page, loc, fn); } catch {} }
  for (const f of page.frames()) { try { return await roleFallback(f, action, fn); } catch {} }
  throw new Error("unresolvable");
}

export default { name: "B", selectFix: true, snapshot: snapshotB, act: actB };
