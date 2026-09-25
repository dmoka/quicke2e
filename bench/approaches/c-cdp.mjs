// C : Chromium's accessibility tree over CDP. Accessibility.getFullAXTree per frame (Page.getFrameTree
// lists same-origin iframes; the AX tree already includes open shadow DOM). Act: the node is mapped
// back LAZILY -- only the one node the model chose -- via DOM.resolveNode(backendNodeId) +
// Runtime.callFunctionOn(setAttribute), then located by that stamp in whichever frame holds it.
// (The README's 8.6x measured stamping EVERY actionable node; lazy mapping is one round trip.)
import { roleFallback, viaLabel } from "../lib/core.mjs";

const ACTION_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
  "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "spinbutton", "MenuListOption"]);
const FILL = new Set(["textbox", "searchbox", "spinbutton"]);
const sessions = new WeakMap();
async function cdp(page) {
  let s = sessions.get(page);
  if (!s) { s = await page.context().newCDPSession(page); await s.send("DOM.enable"); await s.send("Accessibility.enable"); sessions.set(page, s); }
  return s;
}
const prop = (n, k) => n.properties?.find((p) => p.name === k)?.value?.value;

export async function snapshotC(page) {
  const s = await cdp(page);
  const { frameTree } = await s.send("Page.getFrameTree");
  const frameIds = []; const collect = (ft) => { frameIds.push(ft.frame.id); (ft.childFrames || []).forEach(collect); }; collect(frameTree);
  const actions = [];
  for (const frameId of frameIds) {
    let nodes;
    try { ({ nodes } = await s.send("Accessibility.getFullAXTree", { frameId })); } catch { continue; }
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    // getFullAXTree is not in document order; walk childIds depth-first from the root so ranking
    // ties break by document order exactly as in A.
    const ordered = [], root = nodes.find((n) => !n.parentId);
    const dfs = (n) => { if (!n) return; ordered.push(n); (n.childIds || []).forEach((id) => dfs(byId.get(id))); };
    dfs(root);
    const anc = (n) => { const out = []; let p = n.parentId && byId.get(n.parentId); while (p) { out.push(p); p = p.parentId && byId.get(p.parentId); } return out; };
    for (const n of ordered) {
      if (n.ignored) continue;
      const role = n.role?.value; if (!ACTION_ROLES.has(role)) continue;
      if (prop(n, "disabled") || prop(n, "hidden")) continue;
      const a = anc(n);
      const name = String(n.name?.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const node = `c${n.backendDOMNodeId}`;
      const base = { node, backendId: n.backendDOMNodeId, label: name || "(unlabeled)", role, value: String(n.value?.value ?? ""),
        ...(prop(n, "checked") !== undefined ? { checked: prop(n, "checked") === "true" || prop(n, "checked") === true } : {}),
        ...(prop(n, "expanded") !== undefined ? { expanded: !!prop(n, "expanded") } : {}),
        ...(prop(n, "selected") !== undefined ? { selected: !!prop(n, "selected") } : {}) };
      if (role === "MenuListOption" || (role === "option" && a.some((x) => x.role?.value === "combobox"))) {
        // native <select> option: SELECT on the owning combobox
        const combo = a.find((x) => x.role?.value === "combobox");
        if (!combo) continue;
        const cl = String(combo.name?.value || "").trim(), cur = String(combo.value?.value ?? "");
        actions.push({ kind: "select", node: `${node}`, selectNode: `c${combo.backendDOMNodeId}`, backendId: combo.backendDOMNodeId,
          selectLabel: cl, optionLabel: name, label: `${cl}: ${name}`, role: "option",
          value: /^(choose|select|--)/i.test(name) ? "" : name, current_value: cur, popup: false });
        continue;
      }
      if (role === "combobox" && byId && (n.childIds || []).some((id) => ["MenuListPopup", "listbox"].includes(byId.get(id)?.role?.value) && byId.get(id)?.childIds?.length && !byId.get(id)?.ignored)) {
        actions.push({ ...base, kind: "state" }); continue;   // native select: its options carry the moves
      }
      const popup = (role === "option" || role.startsWith("menuitem")) && a.some((x) => ["listbox", "menu"].includes(x.role?.value));
      if (FILL.has(role)) actions.push({ ...base, kind: "fill", popup, secret: false });
      actions.push({ ...base, kind: "click", popup });
    }
  }
  // enrichment, same rule as B: textboxes (input type) and unlabeled nodes (name attribute),
  // one DOM.describeNode each
  const info = new Map();
  for (const a of actions) {
    const unl = a.label === "(unlabeled)" || a.selectLabel === "";
    if (a.kind !== "fill" && !unl) continue;
    if (!info.has(a.backendId)) info.set(a.backendId, await s.send("DOM.describeNode", { backendNodeId: a.backendId })
      .then(({ node }) => { const at = {}; for (let i = 0; i < (node.attributes || []).length; i += 2) at[node.attributes[i]] = node.attributes[i + 1]; return at; })
      .catch(() => null));
    const at = info.get(a.backendId); if (!at) continue;
    if (a.kind === "fill" && (at.type || "").toLowerCase() === "password") { a.role = "password"; a.secret = true; }
    if (a.label === "(unlabeled)" && at.name) a.label = at.name;
    if (a.selectLabel === "" && at.name) { a.selectLabel = at.name; a.label = `${at.name}: ${a.optionLabel}`; }
  }
  for (const a of actions) if (a.kind === "click" && a.role === "textbox") {
    const f = actions.find((x) => x.kind === "fill" && x.node === a.node); if (f) { a.role = f.role; a.label = f.label; a.secret = f.secret; }
  }
  return { url: page.url(), title: await page.title(), text: "", actions };
}

export async function actC(page, action, fn) {
  const s = await cdp(page);
  const tok = "x" + Math.random().toString(36).slice(2, 9);
  try {
    const { object } = await s.send("DOM.resolveNode", { backendNodeId: action.backendId });
    await s.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(t){this.setAttribute('data-jev-c',t)}", arguments: [{ value: tok }] });
    for (const f of page.frames()) {
      const loc = f.locator(`[data-jev-c="${tok}"]`);
      if (!(await loc.count().catch(() => 0))) continue;
      try { await fn(loc, 1200); return f === page.mainFrame() ? "backend" : "backend@frame"; } catch {}
      if (action.role === "checkbox" || action.role === "radio") { try { return await viaLabel(f, loc, fn); } catch {} }
      break;
    }
  } catch {}
  for (const f of page.frames()) { try { return await roleFallback(f, action, fn); } catch {} }
  throw new Error("unresolvable");
}

export default { name: "C", selectFix: true, snapshot: snapshotC, act: actC };
