// A+ : src/snapshot.js extended. Diff against src/snapshot.js, and nothing else:
//   1. DEEP WALK. Candidates are collected in document order through OPEN shadow roots and
//      SAME-ORIGIN iframes (contentDocument), instead of document.querySelectorAll(SEL).
//   2. ROOT-SCOPED NAMES. aria-labelledby / label[for] resolve in el.getRootNode(), not document,
//      so a label inside the same shadow root (Shoelace) or iframe document is found.
//   3. PER-DOCUMENT STYLE. getComputedStyle from the element's own window (iframes).
//   4. NATIVE <select>: one `select` action PER OPTION with a distinct node, so compact() cannot
//      dedupe them to the placeholder; the <select> itself is the act target (selectNode).
//   5. HIDDEN CHECKBOX INPUT: a checkbox/radio <input> that fails visible() (opacity 0, 0x0 --
//      Element Plus, Shoelace, antd) but whose <label> is visible is offered ONCE, stamped on the
//      label (the thing a user clicks), with the input's name and checked state.
//   8. SLOTTED TEXT. Inside a shadow root, innerText does not follow <slot> into the host's light
//      DOM, so a Shoelace <button part=base><slot> read as "button". Text is read through slots.
//   7. <input type=submit|button|reset> is named by its value (accname spec; src/ fell through to
//      the name/id attribute, so a legacy "Create project" button was offered as "save"), and a
//      <select> is never named by its own innerText (that is every option, concatenated).
//   6. Stamps carry a per-snapshot generation, so a stale stamp from an earlier pass never collides.
() => {
  const ZW = /[​-‍﻿]/g;
  const strip = (v) => (v || "").replace(ZW, "").replace(/\s+/g, " ").trim();
  const cs = (el) => (el.ownerDocument.defaultView || window).getComputedStyle(el);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = cs(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    if (el.closest("[hidden],[aria-hidden='true'],[data-state='inactive']")) return false;
    // FIX (v1): an element can have a box and still be invisible (fixtures/negative.html):
    // an ancestor at opacity 0, a zero-size overflow:hidden wrapper, or positioned off-screen.
    // Form controls are exempt from the opacity rule: Element Plus renders its real combobox input
    // inside an opacity-0 wrapper and the user clicks the wrapper (bake-off re-run, vue-ep T2 0/5).
    const control = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.getAttribute("role") === "combobox";
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: !control, visibilityProperty: true })) return false;
    if (r.right <= 0 || r.bottom <= 0) return false;
    for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
      const ps = cs(p);
      if (ps.overflow === "visible" && ps.overflowX === "visible" && ps.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      if (pr.width < 1 || pr.height < 1) return false;
    }
    return true;
  };

  // ---- popup detection: unchanged from src/snapshot.js (top document) ----
  const bodyChildren = [...document.body.children].filter((el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE");
  const hasBox = (el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const shown = (el) => { const s = cs(el); return s.display !== "none" && s.visibility !== "hidden"; };
  const floats = (el) => { const p = cs(el).position; return p === "fixed" || p === "absolute"; };
  const OVERLAY_ROLE = "[role=dialog],[role=alertdialog],[role=listbox],[role=menu],[role=tooltip]";
  const OVERLAY_IN = (el) => [el, ...el.querySelectorAll(OVERLAY_ROLE)].some((n) => n.matches(OVERLAY_ROLE) && shown(n));
  const CONTROLLED = (el) => [...document.querySelectorAll('[aria-expanded="true"][aria-controls]')]
    .some((t) => { const c = document.getElementById(t.getAttribute("aria-controls")); return c && el.contains(c) && !el.contains(t); });
  const EXPANDED_OUTSIDE = (el) => [...document.querySelectorAll('[aria-expanded="true"]')].some((n) => !el.contains(n));
  const popupRoots = bodyChildren.filter((el) => {
    if (!shown(el)) return false;
    if (!(hasBox(el) || [...el.querySelectorAll("*")].some(hasBox))) return false;
    const kid = [...el.children].find((c) => shown(c) && hasBox(c));
    if (floats(el) || (kid && floats(kid))) return OVERLAY_IN(el) || CONTROLLED(el);
    if (!el.matches(OVERLAY_ROLE) || !hasBox(el)) return false;
    return EXPANDED_OUTSIDE(el);
  });
  // v0.4: an autocomplete's suggestion list usually sits INSIDE the form, not at the body level, so it
  // never counted as an open popup and its options were mixed with every other field (demoqa Subjects:
  // the run clicked "Sports" under the open menu). A visible listbox counts as open while a combobox on
  // the page reports aria-expanded="true"; an always-visible list does not.
  const comboOpen = [...document.querySelectorAll('[role=combobox][aria-expanded="true"], input[aria-expanded="true"]')].length > 0;
  const openLists = comboOpen ? [...document.querySelectorAll("[role=listbox]")].filter((l) => shown(l) && hasBox(l)
    && l.querySelector("[role=option]")) : [];
  const inPopup = (el) => popupRoots.some((p) => p.contains(el)) || openLists.some((l) => l.contains(el));

  // 2. root-scoped lookups
  // 8. text through <slot>s (flat tree), used wherever a shadow-root element's innerText is read
  const flat = (node) => {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1) return "";
    if (node.tagName === "SLOT") { const as = node.assignedNodes({ flatten: true });
      return (as.length ? as : [...node.childNodes]).map(flat).join(" "); }
    if (node.tagName === "STYLE" || node.tagName === "SCRIPT") return "";
    const kids = node.shadowRoot ? [...node.shadowRoot.childNodes] : [...node.childNodes];
    return kids.map(flat).join(" ");
  };
  const textOf = (el) => strip(el.getRootNode() instanceof ShadowRoot ? flat(el) : el.innerText);
  const byId = (el, id) => { const r = el.getRootNode(); return (r.getElementById ? r.getElementById(id) : null) || el.ownerDocument.getElementById(id); };
  const labelFor = (el) => el.id ? el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`) : null;
  // The caption of an unlabelled control: text that comes BEFORE it in the same container (an earlier
  // sibling of the control or of one of its first 3 ancestors). Not an ancestor's whole text: on
  // demoqa that gave the page heading "Slider" to the readout box next to the slider.
  const nearbyText = (el) => {
    for (let n = el, d = 0; n && d < 3; n = n.parentElement, d++) {
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        if (/^H[1-3]$/.test(p.tagName)) return "";
        // Another control (or a <label>) comes first: the text before it is ITS caption, never ours
        // (fixtures/sec-contenteditable: an unlabelled box took the "Site name" input's label).
        if (p.matches("input, select, textarea, button, label, [contenteditable=true]")
            || p.querySelector("input, select, textarea, button, label, [contenteditable=true]")) return "";
        const line = String(p.innerText || "").split("\n").map(strip).find((t) => t.length >= 2 && t.length <= 40);
        if (line) return line;
        if (strip(p.innerText)) break;
      }
    }
    return "";
  };
  const accName = (el) => {
    const role = el.getAttribute("role");
    let l = strip(el.getAttribute("aria-label"));
    if (!l) {
      const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      l = strip(ids.map((id) => { const t = byId(el, id); return t ? textOf(t) : ""; }).join(" "));
    }
    if (!l) { const lab = labelFor(el); if (lab) l = textOf(lab); }
    if (!l) { const wrap = el.closest("label"); if (wrap) l = textOf(wrap); }
    if (!l && el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) l = strip(el.value);
    if (!l) l = strip(el.getAttribute("placeholder"));
    const valueBearing = role === "combobox" || role === "listbox" || role === "spinbutton";
    // SECURITY (audit S1): an editable element's text is its CONTENT, never its name.
    if (!l && !valueBearing && !el.isContentEditable && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) l = textOf(el);
    if (!l) l = strip(el.getAttribute("title"));
    // v0.4: the visible caption next to the control comes before its name/id attribute. A react-select
    // input's id is "react-select-3-input"; the engine was offered that and clicked the wrong
    // combobox 11x (demoqa). The caption is the first short text line of a close ancestor.
    if (!l) l = nearbyText(el);
    if (!l) {
      const n = el.getAttribute("name") || el.getAttribute("id") || el.getAttribute("type") || "";
      const generated = /\d/.test(n) && /[-_]/.test(n);   // react-select-3-input, mui-12, :r5:
      if (!generated && !/^[_:]?[rR][_:]|^[_:]r|^_R_/.test(n)) l = strip(n);
    }
    return l.slice(0, 80) || "(unlabeled)";
  };

  const selectionOf = (el) => {
    if (el.tagName === "SELECT") return strip(el.selectedOptions?.[0]?.label || "");
    if (typeof el.value === "string" && strip(el.value)) return strip(el.value);
    const own = strip(el.innerText);
    if (own) return own;
    const name = accName(el);
    let node = el, r0 = el.getBoundingClientRect();
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      const r = node.getBoundingClientRect();
      if (r.height > r0.height * 2.5) break;
      if (node.querySelectorAll("input,textarea,select,button,a[href],[role=combobox]").length > 1) break;
      const t = strip(node.innerText);
      if (t && t !== name) return t;
    }
    return "";
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      if (t === "password") return "password";
      if (t === "range") return "slider";   // v0.4: its real ARIA role; a readout textbox next to it is a different field
      return "textbox";
    }
    return tag;
  };

  const SEL = [
    "input:not([type=hidden])", "textarea", "select", "button", "a[href]",
    "[role=button]", "[role=tab]", "[role=link]", "[role=checkbox]", "[role=switch]",
    "[role=option]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]",
    "[role=combobox]", "[role=radio]",
    "[contenteditable='']", "[contenteditable=true]",
  ].join(",");

  // 1. deep walk in document order: light DOM, then a host's shadow root at the host's position,
  //    then a same-origin iframe's document at the iframe's position.
  const found = [];
  const walk = (root) => {
    const tw = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      if (el.matches(SEL)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === "IFRAME") {
        let d = null; try { d = el.contentDocument; } catch {}
        if (d && d.body && visible(el)) walk(d.body);
      }
    }
  };
  walk(document.body);

  // v1: which form does a control belong to, and does this button SUBMIT it? compact() uses this
  // to hold back a form's submit while a field the spec names in that same form is still unset.
  const formList = [];
  const formOf = (el) => { const f = el.form || el.closest("form"); if (!f) return -1;
    let i = formList.indexOf(f); if (i < 0) { formList.push(f); i = formList.length - 1; } return i; };
  const submits = (el) => {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "BUTTON") return formOf(el) >= 0 && (t === "submit" || t === "");
    return el.tagName === "INPUT" && t === "submit";
  };

  const actions = [];
  const gen = Math.random().toString(36).slice(2, 6);
  let n = 0;
  const stampedNow = new WeakSet();
  const nodeEls = new Map();
  const stamp = (el) => { const node = `${gen}n${n++}`; el.setAttribute("data-jev-node", node); stampedNow.add(el); nodeEls.set(node, el); return node; };
  const proxied = new WeakSet();

  for (const el of found) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (!visible(el)) {
      // 5. hidden checkbox/radio input operated through its visible label
      if (tag === "input" && (type === "checkbox" || type === "radio") && !el.disabled) {
        const lab = el.closest("label") || labelFor(el);
        if (lab && visible(lab) && !proxied.has(lab)) {
          proxied.add(lab);
          const node = stamp(lab);
          actions.push({ id: `click:${node}`, kind: "click", node, label: accName(el), role: type, tag: "label",
            popup: inPopup(lab), value: "", checked: el.checked, proxy: true });
        }
      }
      continue;
    }
    if (el.disabled) continue;
    const role = roleOf(el);
    const node = stamp(el);
    const label = accName(el);
    const popup = inPopup(el);
    const form = formOf(el);

    if (tag === "select") {
      // 4. one action per option, distinct node; act target = the <select>
      [...el.options].forEach((opt, i) => actions.push({ id: `select:${node}:${i}`, kind: "select", node: `${node}#${i}`,
        selectNode: node, selectLabel: label, optionLabel: opt.label || opt.value,
        label: `${label}: ${opt.label || opt.value}`, value: opt.value, current_value: el.value, role: "option", popup, form }));
      actions.push({ id: `state:${node}`, kind: "state", node, label, role, tag, popup,
        value: strip(el.selectedOptions?.[0]?.label || el.value || "") });
      continue;
    }
    const editable = (tag === "input" && !["checkbox", "radio", "submit", "button"].includes(type))
      || tag === "textarea" || el.isContentEditable;
    if (editable && role !== "combobox")
      actions.push({ id: `fill:${node}`, kind: "fill", node, label, role, tag, popup, form, itype: type,
        value: strip(el.value ?? el.innerText ?? ""),
        secret: type === "password" || new RegExp("__SECRET_SRC__", "i").test(`${label} ${el.name || ""} ${el.getAttribute("autocomplete") || ""}`) });
    if (tag === "label") proxied.add(el);
    actions.push({ id: `click:${node}`, kind: "click", node, label, role, tag, popup, form,
      ...(submits(el) ? { submit: true } : {}),
      value: role === "combobox" ? selectionOf(el).slice(0, 40) : strip(typeof el.value === "string" ? el.value : ""),
      ...(el.getAttribute("aria-selected") !== null ? { selected: el.getAttribute("aria-selected") === "true" } : {}),
      ...(el.getAttribute("aria-expanded") !== null ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
      ...(el.getAttribute("aria-haspopup") && el.getAttribute("aria-haspopup") !== "false" ? { haspopup: true } : {}),
      ...(el.getAttribute("aria-checked") !== null ? { checked: el.getAttribute("aria-checked") === "true" }
        : typeof el.checked === "boolean" && ["checkbox", "radio"].includes(type) ? { checked: el.checked } : {}) });
  }

  for (const root of popupRoots) {
    const alreadyCovered = actions.some((a) => a.popup && root.querySelector(`[data-jev-node="${a.node}"]`));
    if (alreadyCovered) continue;
    for (const el of root.querySelectorAll("*")) {
      if (!visible(el)) continue;
      if (stampedNow.has(el)) continue;
      const txt = strip(el.innerText);
      if (!txt || txt.length > 60) continue;
      if ([...el.children].some((c) => visible(c) && strip(c.innerText) === txt)) continue;
      if ([...el.children].filter((c) => visible(c) && strip(c.innerText)).length > 1) continue;
      const node = stamp(el);
      actions.push({ id: `click:${node}`, kind: "click", node, label: txt, role: "option", tag: el.tagName.toLowerCase(), popup: true, value: "" });
    }
  }

  // v0.4 HOVER: an element whose container holds HIDDEN text (a figure caption, a tooltip) reveals it
  // on hover. Offered only for that pattern; the label carries the hidden text so the engine can tell
  // the avatars apart (the-internet /hovers was BLOCKED from step 1 in 0.3.0).
  const hidden = (el) => { const cs = getComputedStyle(el); return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0; };
  let hovers = 0;
  for (const img of document.querySelectorAll("img, figure, [aria-describedby]")) {
    if (hovers >= 12 || !visible(img) || stampedNow.has(img)) continue;
    const box = img.closest("figure, li, div") || img.parentElement;
    if (!box) continue;
    const tip = [...box.querySelectorAll("*")].find((e) => e !== img && !e.contains(img) && hidden(e) && strip(e.textContent).length >= 2);
    if (!tip) continue;
    const node = stamp(img);
    hovers++;
    const base = strip(img.getAttribute("alt") || accName(img));
    actions.push({ id: `hover:${node}`, kind: "hover", node, label: `${base || "element"} · ${strip(tip.textContent).slice(0, 40)}`, role: "img", tag: img.tagName.toLowerCase(), value: "" });
  }

  // v0.4 DRAG: source -> target pairs, only between elements that look draggable and drop zones.
  const dragSrc = [...document.querySelectorAll("[draggable=true], [id*=drag i], [class*=draggable i]")]
    .filter((e) => visible(e) && !/drop/i.test(e.id + " " + e.className)).slice(0, 3);
  // Tabs, links and buttons are never drop zones (demoqa: the tab "droppableExample-tab-simple" was
  // picked over the real #droppable box).
  const dropDst = [...document.querySelectorAll("[id*=drop i], [class*=droppable i], [class*=dropzone i], [class*=drop-box i]")]
    .filter((e) => visible(e) && !e.matches("a, button, [role=tab], [role=button], [role=link], [role=tablist], nav *")
      && !dragSrc.some((d) => d === e || e.contains(d) || d.contains(e)))
    .filter((e, i, all) => !all.some((o) => o !== e && e.contains(o)))   // innermost zone only
    .slice(0, 4);
  for (const src of dragSrc) for (const dst of dropDst) {
    const sNode = src.getAttribute("data-jev-node") || stamp(src), dNode = dst.getAttribute("data-jev-node") || stamp(dst);
    const name = (e) => strip(accName(e)).slice(0, 30) || e.id || e.tagName.toLowerCase();
    actions.push({ id: `drag:${sNode}>${dNode}`, kind: "drag", node: sNode, targetNode: dNode,
      label: `${name(src)} -> ${name(dst)}`, role: "drag", tag: src.tagName.toLowerCase(), value: "" });
  }

  // v0.4: CONTEXT FOR IDENTICAL NAMES. Six "Add to cart" buttons are six identical options for the
  // engine, and their trace labels cannot say which product was added (saucedemo). Each clickable that
  // shares its role+name gets the first text line of the largest ancestor holding only it (the card):
  // "Add to cart · Sauce Labs Backpack". The original name stays in baseLabel for role lookups.
  const groups = new Map();
  for (const a of actions) {
    if (a.kind !== "click" || !["button", "link", "menuitem", "tab"].includes(a.role)) continue;
    const k = a.role + "|" + a.label;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  for (const list of groups.values()) {
    if (list.length < 2 || list.length > 40) continue;
    const els = list.map((a) => nodeEls.get(a.node));
    if (els.some((e) => !e)) continue;
    const ctx = els.map((el) => {
      let card = null;
      for (let p = el.parentElement, d = 0; p && d < 8; p = p.parentElement, d++) {
        if (els.some((o) => o !== el && p.contains(o))) break;
        card = p;
      }
      if (!card) return "";
      return String(card.innerText || "").split("\n").map(strip).find((t) => t && t !== list[0].label && t.length >= 2 && t.length <= 50) || "";
    });
    if (ctx.some((c) => !c) || new Set(ctx).size !== ctx.length) continue;
    list.forEach((a, i) => { a.baseLabel = a.label; a.label = `${a.label} · ${ctx[i]}`; });
  }

  const text = strip((document.body && document.body.innerText) || "").slice(0, 1200);
  return { url: location.href, title: document.title, text, actions };
}
