// One fixture per confirmed defect. `want` is what a CORRECT implementation must produce.
// `grade` gets the loop's record, the page's own truth log, and every option set the loop
// offered the model (via proxy.mjs), so a verdict can never pass without the work happening.

const has = (t, truth, type) => t.some((e) => e.truth === truth && (!type || e.type === type));
const val = (t, truth) => { const m = t.filter((e) => e.truth === truth && e.value); return m.length ? m[m.length - 1].value : null; };
const typedInto = (t) => [...new Set(t.filter((e) => e.type === "input").map((e) => e.truth))];
const clicked = (t) => [...new Set(t.filter((e) => e.type === "click").map((e) => e.truth))];
const opsAt = (call, op) => (call?.criteria || []).filter((k) => k.startsWith(op + ":"));
const hatch = (call) => ["WAIT", "DONE", "BLOCKED"].filter((k) => (call?.criteria || []).includes(k));

export const FIXTURES = [
  {
    id: "table-pagination", defect: "1 budget starvation", kind: "flow", want: "pass",
    flow: { name: "table-pagination", start: "/table.html", maxSteps: 8,
      goal: "Open page 2 of the creators list.",
      done: "Page 2 of the creators list is open.",
      expectUrl: "table2\\.html", expect: ["Page 2 of 2"] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [], criteriaText: {} };
      const offered = Object.values(c.criteriaText || {}).some((v) => /Next page/.test(v));
      const links = (c.elements || []).filter((e) => e.r === "link").length;
      return { ok: rec.passed && has(truth, "next", "click"),
        note: `step1 sent ${c.criteria.length} opts, model saw ${c.seen}${c.truncated ? " (TRUNCATED to 52)" : ""}, ${links} links, Next page ${offered ? "OFFERED" : "MISSING"}, hatch=[${hatch(c).join(",") || "NONE"}]` };
    },
  },
  {
    // The counterweight to table-pagination. Any ranking change must pass BOTH: this one
    // breaks when links are promoted, that one breaks when they are not.
    id: "form-heavy", defect: "1b form starved by promoted links", kind: "flow", want: "pass",
    flow: { name: "form-heavy", start: "/form-heavy.html", maxSteps: 12,
      inputs: { name: "QuarterPush" },
      goal: "Create a campaign named QuarterPush and save it. The dropdowns are optional.",
      done: "The campaign QuarterPush has been created.",
      expectUrl: "done\\.html\\?Name=QuarterPush", expect: ["Name: QuarterPush"] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [], criteriaText: {}, elements: [] };
      const saveOffered = Object.values(c.criteriaText || {}).some((v) => /Create campaign/.test(v));
      const links = (c.elements || []).filter((e) => e.r === "link").length;
      const combos = clicked(truth).filter((x) => x.startsWith("cb-")).length;
      return { ok: rec.passed && val(truth, "name") === "QuarterPush" && clicked(truth).includes("save"),
        note: `step1 offered ${c.criteria.length} opts, ${links}/30 links, Create campaign ${saveOffered ? "OFFERED" : "MISSING"}; opened ${combos} optional dropdowns` };
    },
  },
  {
    id: "native-select", defect: "2 native <select>", kind: "flow", want: "pass",
    flow: { name: "native-select", start: "/select.html", maxSteps: 10,
      inputs: { team: "Acme", plan: "Growth" },
      goal: "Set the team name to Acme, choose the Growth plan, and save the subscription.",
      done: "The subscription is saved with the Growth plan.",
      expectUrl: "done\\.html\\?Team=Acme&Plan=Growth", expect: ["Plan: Growth"] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [], criteriaText: {} };
      const sel = opsAt(c, "SELECT").map((k) => c.criteriaText[k]);
      const ops = rec.steps.map((s) => s.op);
      return { ok: rec.passed && val(truth, "plan") === "Growth",
        note: `SELECT opts offered: ${sel.length} [${sel.map((s) => (s || "").split(" ").slice(2, -1).join(" ")).join("|")}]; ops=${ops.join(",")}` };
    },
  },
  {
    id: "modal-long-list", defect: "3 truncated list eats the escape hatch", kind: "flow", want: "pass",
    flow: { name: "modal-long-list", start: "/modal-list.html?open=1", maxSteps: 12,
      inputs: { country: "Zimbabwe" },
      goal: "Choose Zimbabwe as the country and save the address.",
      done: "The address is saved with Zimbabwe as the country.",
      expectUrl: "done\\.html\\?Country=Zimbabwe", expect: ["Country: Zimbabwe"] },
    grade({ rec, truth, calls }) {
      const open = calls.filter((c) => (c.elements || []).some((e) => e.r === "option"));
      const worst = open.length ? open[0] : null;
      return { ok: rec.passed && has(truth, "opt-Zimbabwe", "click"),
        note: worst
          ? `list open on ${open.length}/${calls.length} steps; first open step offered ${worst.criteria.length} opts, ${(worst.elements || []).filter((e) => e.r === "option").length}/60 options, escape hatch=[${hatch(worst).join(",") || "NONE"}]`
          : "listbox never opened" };
    },
  },
  {
    id: "menuitem-sidebar", defect: "3b menuitem nav strips the escape hatch", kind: "flow", want: "pass",
    flow: { name: "menuitem-sidebar", start: "/menu-sidebar.html", maxSteps: 10,
      inputs: { title: "AutumnDrop" },
      goal: "Set the order title to AutumnDrop and save the order.",
      done: "The order is saved with the title AutumnDrop.",
      expectUrl: "done\\.html\\?Title=AutumnDrop", expect: ["Title: AutumnDrop"] },
    grade({ rec, truth, calls }) {
      const onPage = calls.filter((c) => /menu-sidebar/.test(c.url || ""));
      const stripped = onPage.filter((c) => hatch(c).length === 0).length;
      return { ok: rec.passed && val(truth, "title") === "AutumnDrop",
        note: `escape hatch stripped on ${stripped}/${onPage.length} steps of a page with no menu open` };
    },
  },
  {
    id: "ambiguous-collide", defect: "4a substring label collision", kind: "flow", want: "pass",
    flow: { name: "ambiguous-collide", start: "/ambiguous.html", maxSteps: 10,
      inputs: { name: "Zed" },
      goal: "Create a contact whose last name is Zed. Leave every other field empty.",
      done: "The contact is saved with last name Zed and no other field set.",
      expectUrl: "done\\.html\\?First=&Middle=&Last=Zed&Company=", expect: ["Last: Zed"] },
    grade({ rec, truth }) {
      const t = typedInto(truth);
      return { ok: rec.passed && t.length === 1 && t[0] === "last",
        note: `typed into [${t.join(",") || "nothing"}]` };
    },
  },
  {
    id: "ambiguous-nomatch", defect: "4b key absent from every label", kind: "flow", want: "pass",
    flow: { name: "ambiguous-nomatch", start: "/ambiguous.html", maxSteps: 10,
      inputs: { surname: "Amelia" },
      goal: "Create a contact whose last name is Amelia.",
      done: "The contact is saved with last name Amelia.",
      expectUrl: "done\\.html\\?First=&Middle=&Last=Amelia&Company=", expect: ["Last: Amelia"] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [] };
      return { ok: rec.passed && val(truth, "last") === "Amelia",
        note: `step1 offered ${opsAt(c, "TYPE_TEXT").length} TYPE_TEXT of 4 fields` };
    },
  },
  {
    id: "aria-labelledby", defect: "5 aria-labelledby blind + ZWSP false PASS", kind: "flow", want: "pass",
    // Content-only assertion on purpose: this is the spec shape README finding #4 warns about,
    // and the decoy prose normalises to it only because norm() strips U+200B.
    flow: { name: "aria-labelledby", start: "/aria-label.html", maxSteps: 10,
      inputs: { code: "ABC123" },
      goal: "Redeem the access code ABC123.",
      done: "The access code ABC123 has been redeemed.",
      expect: ["Access code accepted: ABC123"] },
    grade({ rec, truth }) {
      const t = typedInto(truth);
      const real = val(truth, "code") === "ABC123" && /redeem-done/.test(rec.finalUrl);
      return { ok: rec.passed && real,
        note: rec.passed && !real ? `FALSE PASS at ${rec.outcome} — typed into [${t.join(",") || "nothing"}], url ${new URL(rec.finalUrl).pathname}`
                                  : `typed into [${t.join(",") || "nothing"}]` };
    },
  },
  {
    id: "ordinal-carryover", defect: "6 `filled` keyed on per-snapshot ordinal", kind: "flow", want: "pass",
    flow: { name: "ordinal-carryover", start: "/ordinal-a.html", maxSteps: 12,
      inputs: { company: "Acme", project: "Falcon" },
      goal: "Enter the company Acme, continue, then enter the project Falcon and finish.",
      done: "Both steps are complete and the project Falcon is saved.",
      expectUrl: "done\\.html\\?Project=Falcon", expect: ["Project: Falcon"] },
    grade({ rec, truth, calls }) {
      const onB = calls.filter((c) => /ordinal-b/.test(c.url || ""));
      const offered = onB.length ? opsAt(onB[0], "TYPE_TEXT").length : -1;
      return { ok: rec.passed && val(truth, "project") === "Falcon",
        note: `page-2 step offered ${offered} TYPE_TEXT (Project is the only field)` };
    },
  },
  {
    id: "login-base", defect: "8 rename pair (baseline)", kind: "flow", want: "pass",
    flow: { name: "login-base", start: "/login.html", maxSteps: 10,
      inputs: { email: "member@example.test", password: "Demo-Pass-42!" },
      goal: "Log in as member@example.test with password Demo-Pass-42!",
      done: "The dashboard is visible and no sign-in form remains.",
      expectUrl: "login-done\\.html", expect: ["Signed in as member@example.test"] },
    grade: gradeLogin,
  },
  {
    id: "login-mutated", defect: "8 rename pair (mutated)", kind: "flow", want: "pass",
    flow: { name: "login-mutated", start: "/login.mutated.html", maxSteps: 10,
      inputs: { email: "member@example.test", password: "Demo-Pass-42!" },
      goal: "Log in as member@example.test with password Demo-Pass-42!",
      done: "The dashboard is visible and no sign-in form remains.",
      expectUrl: "login-done\\.html", expect: ["Signed in as member@example.test"] },
    grade: gradeLogin,
  },

  // ---- AUDIT 2026-09-24: new failure cases. `want: "pass"` = what a correct tool must do. ----
  {
    id: "shadow-form", defect: "A1 open shadow root is invisible", kind: "flow", want: "pass",
    flow: { name: "shadow-form", start: "/shadow-form.html", maxSteps: 8,
      inputs: { email: "nova@example.test" },
      goal: "Subscribe nova@example.test to the newsletter.",
      done: "nova@example.test is subscribed.",
      expectUrl: "done\\.html\\?Email=nova%40example\\.test", expect: ["Email: nova@example.test"] },
    grade({ rec, calls }) {
      const c = calls[0] || { criteria: [] };
      return { ok: rec.passed, note: `step1 offered [${c.criteria.join(",")}]; ops=${rec.steps.map((s) => s.op).join(",")}` };
    },
  },
  {
    id: "iframe-form", defect: "A2 same-origin iframe is invisible", kind: "flow", want: "pass",
    flow: { name: "iframe-form", start: "/iframe-form.html", maxSteps: 8,
      inputs: { holder: "Ada Lovelace" },
      goal: "Set the card holder to Ada Lovelace and save billing.",
      done: "Billing is saved with card holder Ada Lovelace.",
      expectUrl: "done\\.html\\?Holder=Ada\\+Lovelace", expect: ["Holder: Ada Lovelace"] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [] };
      return { ok: rec.passed && val(truth, "holder") === "Ada Lovelace",
        note: `step1 offered [${c.criteria.join(",")}]; ops=${rec.steps.map((s) => s.op).join(",")}` };
    },
  },
  {
    id: "label-shadow", defect: "A3 spec key shadowed by an earlier key", kind: "flow", want: "pass",
    flow: { name: "label-shadow", start: "/label-shadow.html", maxSteps: 10,
      inputs: { name: "Ada Lovelace", username: "ada99" },
      goal: "Create a profile with name Ada Lovelace and username ada99. Leave Display name empty.",
      done: "The profile is created with name Ada Lovelace and username ada99.",
      expectUrl: "done\\.html\\?Name=Ada\\+Lovelace&Username=ada99&Display=$", expect: ["Username: ada99"] },
    grade({ rec, truth }) {
      const got = { name: val(truth, "name"), username: val(truth, "username"), display: val(truth, "display") };
      return { ok: rec.passed && got.username === "ada99" && !got.display,
        note: `typed name=${got.name} username=${got.username} display=${got.display}; final ${new URL(rec.finalUrl).search}` };
    },
  },
  {
    id: "late-enable", defect: "A4 submit disabled until async check", kind: "flow", want: "pass",
    flow: { name: "late-enable", start: "/late-enable.html", maxSteps: 10,
      inputs: { "workspace url": "acme-labs" },
      goal: "Create a workspace at the URL acme-labs.",
      done: "The workspace acme-labs is created.",
      expectUrl: "done\\.html\\?Slug=acme-labs", expect: ["Slug: acme-labs"] },
    grade({ rec, truth }) {
      return { ok: rec.passed && val(truth, "slug") === "acme-labs",
        note: `ops=${rec.steps.map((s) => s.op + (s.label ? "(" + s.label + ")" : "")).join(",")}` };
    },
  },
  {
    id: "toast-transient", defect: "A5 success shown only by a 300 ms toast", kind: "flow", want: "pass",
    flow: { name: "toast-transient", start: "/toast.html", maxSteps: 8,
      goal: "Turn on the weekly digest and save the settings.",
      done: "The settings are saved with the weekly digest on.",
      // A 300 ms toast is asserted with expectSeen (recorded the moment it appears). With `expect` it
      // only ever passed by timing luck: a DONE answer's extra check happened to land on the toast.
      expectSeen: ["Settings saved: weekly digest on"] },
    grade({ rec, truth }) {
      const saves = truth.filter((e) => e.truth === "save" && e.type === "click").length;
      return { ok: rec.passed && saves === 1,
        note: `save clicked ${saves}x; ops=${rec.steps.map((s) => s.op + (s.label ? "(" + s.label + ")" : "")).join(",")}; outcome ${rec.outcome}` };
    },
  },
  {
    id: "long-thread", defect: "A6 button starvation on a long page", kind: "flow", want: "pass",
    flow: { name: "long-thread", start: "/long-thread.html", maxSteps: 8,
      inputs: { reply: "Shipped on our side too." },
      goal: "Post the reply 'Shipped on our side too.' to the thread.",
      done: "The reply is posted.",
      expectUrl: "done\\.html\\?Reply=Shipped", expect: ["Reply: Shipped on our side too."] },
    grade({ rec, truth, calls }) {
      const c = calls[0] || { criteria: [], criteriaText: {} };
      const post = Object.values(c.criteriaText || {}).some((v) => /Post reply/.test(v));
      return { ok: rec.passed && has(truth, "post", "click"),
        note: `step1 ${c.criteria.length} opts, Post reply ${post ? "OFFERED" : "MISSING"}; outcome ${rec.outcome}` };
    },
  },
  {
    id: "secret-field", defect: "A7 SECURITY: non-password secret sent as v", kind: "flow", want: "pass",
    flow: { name: "secret-field", start: "/secret-field.html", maxSteps: 8,
      inputs: { "api key": "sk-live-NEWKEY-0001", password: "correct-horse" },
      goal: "Replace the API key with the new key, confirm with the password, and save the key.",
      done: "The new API key is saved.",
      expectUrl: "done\\.html\\?Key=sk-live-NEWKEY-0001&Pw=correct-horse", expect: ["Key: sk-live-NEWKEY-0001"] },
    grade({ rec, calls }) {
      const sent = JSON.stringify(calls.map((c) => c.elements));
      const leaks = (sent.match(/OLDSECRET[^"]*/g) || []);
      return { ok: rec.passed && leaks.length === 0,
        note: `${leaks.length} secret values sent to the model: [${[...new Set(leaks)].join(" | ")}]; verdict ${rec.passed}` };
    },
  },

  // ---- AUDIT 2026-09-24, round 2: can ANY secret or typed value reach the engine payload? ----
  // ok = the marker never appears in any request body sent to the engine. Verdict is noted only.
  secLeak("sec-contenteditable", "S1 unlabelled contenteditable: content becomes the label", {
    start: "/sec-contenteditable.html", inputs: { "site name": "Depot" },
    goal: "Set the site name to Depot and save the site.", done: "The site Depot is saved.",
    expectUrl: "done\\.html\\?Site=Depot" }, /SECRETCE/),
  secLeak("sec-echo", "S2 typed value echoed into a button label", {
    start: "/sec-echo.html", inputs: { "recovery code": "RC-TYPED-5521" },
    goal: "Enter the recovery code and verify it.", done: "The recovery code is verified.",
    expectUrl: "done\\.html\\?Code=RC-TYPED-5521" }, /RC-TYPED/),
  secLeak("sec-title", "S3 typed value echoed into document.title", {
    start: "/sec-title.html", inputs: { "social security number": "078-05-TYPED" },
    goal: "Look up the customer by social security number.", done: "The lookup ran.",
    expectUrl: "done\\.html\\?Ssn=078-05-TYPED" }, /05-TYPED/),
  secLeak("sec-path-token", "S4 reset token in the URL path", {
    start: "/reset-SECRETPATHTOKEN9f2c.html", inputs: { "new password": "N3w-Passw0rd" },
    goal: "Set a new password.", done: "The new password is set.",
    expectUrl: "done\\.html\\?Np=" }, /SECRETPATHTOKEN|N3w-Passw0rd/),
  secLeak("sec-combobox", "S5 value of an input[role=combobox]", {
    start: "/sec-combobox.html", inputs: { memo: "rent" },
    goal: "Write the memo rent and send the transfer.", done: "The transfer is sent.",
    expectUrl: "done\\.html\\?Acct=SECRETCOMBO-991&Memo=rent" }, /SECRETCOMBO/),
  secLeak("sec-goal-pwd", "S6 secret in the goal under a key the regex misses (pwd)", {
    start: "/login.html", inputs: { email: "member@example.test", pwd: "Demo-Pass-42!" },
    goal: "Log in as member@example.test with password Demo-Pass-42!",
    done: "The dashboard is visible.", expectUrl: "login-done\\.html" }, /Demo-Pass-42/),
  secLeak("sec-done-string", "S7 secret in the unredacted `done` criterion", {
    start: "/login.html", inputs: { email: "member@example.test", password: "Demo-Pass-42!" },
    goal: "Log in as member@example.test with password Demo-Pass-42!",
    done: "Signed in as member@example.test using Demo-Pass-42!", expectUrl: "login-done\\.html" }, /Demo-Pass-42/),

  // ---- AUDIT round 3 ----
  secLeak("sec-transform", "R1 secret echoed upper-cased / URL-encoded", {
    start: "/sec-transform.html", inputs: { password: "Hunter2!Vault" },
    goal: "Unlock the vault.", done: "The vault is unlocked.", expectUrl: "done\\.html\\?Pw=" }, /HUNTER2|Hunter2%21|Hunter2!Vault/),
  secLeak("sec-truncate", "R2 long secret echoed, label cut at 44 chars", {
    start: "/sec-truncate.html", inputs: { "api key": "sk-live-TRUNC-0123456789abcdef0123456789" },
    goal: "Rotate the API key.", done: "The API key is rotated.", expectUrl: "done\\.html\\?K=sk-live" }, /TRUNC/),
  secLeak("sec-whitespace", "R3 secret with a double space, echoed collapsed", {
    start: "/sec-whitespace.html", inputs: { passphrase: "correct  horse  battery" },
    goal: "Set the passphrase and save it.", done: "The passphrase is saved.", expectUrl: "done\\.html\\?P=correct" }, /horse battery|correct  horse/),
  // Page content reaches the engine by design; a spec DECLARES what must not (loop.mjs, secret.mjs).
  // This is the declared form: the owner names the recovery/backup code wording and the card picker.
  secLeak("sec-shown", "R5 page-shown secrets, declared with redact", {
    start: "/sec-shown.html", inputs: { nickname: "home" },
    redact: [/recovery code \S+/i, /backup codes \S+/i, "#f-card"],
    goal: "Set the nickname to home and save the settings.", done: "Settings saved.", expectUrl: "done\\.html\\?Card=.*Nick=home" }, /SHOWN\d/),
  secLeak("sec-getlogin", "R8 GET form: password in the URL query (payload check)", {
    start: "/sec-getlogin.html", inputs: { username: "ada", password: "GetQuery-Secret-88" },
    goal: "Log in as ada.", done: "Logged in.", expectUrl: "done\\.html\\?User=ada" }, /GetQuery-Secret/),

  secLeak("sec-grouped", "R6 card number echoed grouped (dashes/spaces) and as last-4", {
    start: "/sec-grouped.html", inputs: { "card number": "4111222233336789" },
    goal: "Pay with the card.", done: "Paid.", expectUrl: "done\\.html\\?C=4111" }, /4111.?2222|2222.?3333|ending 6789/),

  // ---- AUDIT final round (e3b7fb1) ----
  secLeak("sec-truncate-short", "R2b 11-char secret echoed at char 36, cut to 8", {
    start: "/sec-truncate2.html", inputs: { "signing token": "k9Q!v7Zp2Lx" },
    goal: "Save the signing token.", done: "Saved.", expectUrl: "done\\.html\\?K=k9Q" }, /k9Q!v7Zp|k9Q%21v7/),
  secLeak("sec-truncate-long", "R2c 16-char secret echoed at char 36, cut to 8 (< 12-char head)", {
    start: "/sec-truncate2.html", inputs: { "signing token": "Zq8$Lm2#Wt6!Rv4%" },
    goal: "Save the signing token.", done: "Saved.", expectUrl: "done\\.html\\?K=Zq8" }, /Zq8\$Lm2#|Zq8%24Lm2/),
  fpScrub("fp-password", "FP1 password 'password' scrubs the label Password", {
    start: "/fp-login.html", inputs: { username: "ada", password: "password" },
    goal: "Sign in as ada.", done: "Signed in.", expectUrl: "done\\.html\\?User=ada&Pw=password$" }),
  fpScrub("fp-admin", "FP2 password 'admin' scrubs the Admin / Administrators links", {
    start: "/fp-login.html", inputs: { username: "ada", password: "admin" }, maxSteps: 8,
    goal: "Open the Administrators page from the top navigation.", done: "The Administrators page is open.",
    expectUrl: "nav=administrators" }),

  secLeak("sec-weak-echo", "W1 (class b, documented) weak secret 'letmein1' echoed upper-cased into the title", {
    start: "/sec-transform.html", inputs: { password: "letmein1" },
    goal: "Unlock the vault.", done: "Unlocked.", expectUrl: "done\\.html\\?Pw=" }, /LETMEIN1|letmein1/),

  // ---- AUDIT r7 (3d08539): data minimisation, weak-echo detection, card parts, tournament, seen-text ----
  // Declared form (page content reaches the engine by design): the owner names the wording around
  // their codes; the spaced, letters-only, 5-digit and date-shaped shapes must all stay on the page.
  secLeak("min-spaced-code", "M1 hard code shapes (spaced, 5-digit, letters-only, date-shaped), declared with redact", {
    start: "/min-spaced-code.html", inputs: { nickname: "home" },
    redact: [/(backup code|recovery key|PIN|licence key)\s+[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?/gi],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Nick=home" },
    /4821 9930|QWXZ PLMK|48213|2031-45-67/),
  flowOk("min-orders", "M2 break: newest order = highest number, all numbers redacted", {
    start: "/min-orders.html", goal: "Open the most recent order. The most recent order has the highest order number.",
    done: "The most recent order is open.", expectUrl: "order=100249" }),
  flowOk("min-versions", "M3 break: newest version, all versions redacted", {
    start: "/min-versions.html", goal: "Install the newest version.", done: "The newest version is installing.", expectUrl: "v=10\\.11\\.3" }),
  flowOk("min-sku", "M4 break: goal names SKU WX100187, page writes WX-100187 (120 rows, tournament)", {
    start: "/min-sku.html", maxSteps: 4, goal: "Add the widget with SKU WX100187 to the cart.", done: "It is added.", expectUrl: "sku=WX-100187" }),
  flowOk("tourn-similar", "T1 150 near-identical links across heats", {
    start: "/tourn-similar.html", maxSteps: 4, goal: "Add Widget 150 to the cart.", done: "Widget 150 is added.", expectUrl: "w=150$" }),
  flowOk("weak-later-page", "W2 FP: weak password 'admin' first seen after typing; Admin link scrubbed", {
    start: "/weak-login.html", maxSteps: 8, inputs: { username: "ada", password: "admin" },
    goal: "Sign in as ada, then open the Admin page.", done: "The Admin page is open.", expectUrl: "nav=admin" }),
  secLeak("weak-seen-before", "W3 leak: weak password 'summer' is also a page word before typing", {
    start: "/weak-seen-before.html", inputs: { password: "summer" },
    goal: "Unlock.", done: "Unlocked.", expectUrl: "done\\.html\\?Pw=" }, /with summer/),
  flowOk("card-year", "C3 FP: card ending 2026 rewrites the year in '2026 report'", {
    start: "/card-year.html", maxSteps: 6, inputs: { "card number": "4000123412342026" },
    goal: "Enter the card number, then open the newest report.", done: "The newest report is open.", expectUrl: "y=2026" }),
  falsePass("seen-opacity", "V1 success text at opacity:0", "/seen-hidden.html?mode=opacity"),
  falsePass("seen-collapsed", "V2 success text in a height:0 overflow:hidden panel", "/seen-hidden.html?mode=collapsed"),
  falsePass("seen-offscreen", "V3 success text positioned off-screen", "/seen-hidden.html?mode=offscreen"),
  falsePass("seen-fontzero", "V4 success text at font-size:0", "/seen-hidden.html?mode=fontzero"),
  { id: "seen-typed", defect: "V5 expect satisfied by the loop's own typing (Save is broken)", kind: "flow", want: "fail",
    flow: { name: "seen-typed", start: "/seen-typed.html", maxSteps: 5, inputs: { "campaign name": "QuarterPush" },
      goal: "Create a campaign named QuarterPush.", done: "The campaign QuarterPush is created.", expect: ["QuarterPush"] },
    grade({ rec }) { return { ok: !rec.passed, note: rec.passed ? `FALSE PASS (${rec.outcome}, ${rec.steps.map((s) => s.op).join(",")})` : `correctly failed ${rec.outcome}` }; } },

  // ---- AUDIT r8 (8bf3b9c): the declared `redact` contract ----
  secLeak("redact-selector", "D1 redact:['.backup-code'] -- span inside a button, aria-labelledby, title, shadow root", {
    // A selector covers the elements it matches. document.title is not an element, so the owner
    // declares the title's code with a regex -- a selector alone cannot know that text is sensitive.
    start: "/redact-selector.html", inputs: { nickname: "home" }, redact: [".backup-code", /^Codes \S+/],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Nick=home" },
    /AAAA-4821|BBBB-7777|CCCC-5678|DDDD-2222/),
  secLeak("redact-anchored", "D2 anchored regex matches the element label but not the criteria text", {
    start: "/sec-shown.html", inputs: { nickname: "home" },
    redact: [/^Copy recovery code .*$/, /^Download backup codes .*$/],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Card=.*Nick=home" },
    /SHOWN1|SHOWN2/),
  secLeak("redact-click-regex", "D3 regex-redacted target the goal must click", {
    start: "/redact-click.html", redact: [/ZZ-\d{4}-\d{4}/],
    goal: "Confirm the device with the code.", done: "Confirmed.", expectUrl: "ok=1" }, /ZZ-4821/),
  secLeak("redact-click-css", "D4 selector-redacted target the goal must click", {
    start: "/redact-click.html", redact: [".backup-code"],
    goal: "Confirm the device with the code.", done: "Confirmed.", expectUrl: "ok=1" }, /ZZ-4821/),

  // ---- AUDIT r9: source-level redaction ----
  secLeak("redact2", "D5 redact:['.bc'] -- text-transform, same-origin iframe, differently formatted copy", {
    start: "/redact2.html", inputs: { nickname: "home" }, redact: [".bc"],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Nick=home" },
    /AAAA-4821|aaaa-4821|CCCC-9999|EEEE.5555/),
  flowOk("redact-short", "D6 FP: a 2-char redacted text is cut out of other labels", {
    start: "/redact-short.html", redact: [".bc"], goal: "Open order 4217.", done: "Order 4217 is open.", expectUrl: "order=4217" }),

  // Documented contract (README): a matched text under 4 characters hides its own element only; its
  // copies elsewhere are declared with a pattern. This fixture checks that recipe.
  secLeak("redact3-short", "D7 3-char .bc text copied into another label (declared with a pattern)", {
    start: "/redact3.html", inputs: { nickname: "home" }, redact: [".bc", /security code \d{3}/i],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Nick=home" }, /\b737\b/),
  secLeak("redact3-glued", "D8 .bc text glued to other characters elsewhere", {
    start: "/redact3.html", inputs: { nickname: "home" }, redact: [".bc"],
    goal: "Set the nickname to home and save the settings.", done: "Saved.", expectUrl: "done\\.html\\?Nick=home" }, /AB12CD34/i),

  // ---- attack mode: the app must refuse, and the success state must stay absent ----
  attack("attack-code-refused", "A1 an expired code in odd casing is refused and the total is unchanged",
    "/attack-code.html", "pass"),
  attack("attack-code-accepted", "A1b refusal text shown, but the discount applied anyway: expect alone is a FALSE PASS",
    "/attack-code.html?bug=1", "fail"),
  { id: "attack-order-refused", defect: "A2 another user's order by URL: the load is the attack (control, step 0)", kind: "flow", want: "pass",
    flow: { name: "attack-order-refused", kind: "attack", start: "/attack-order.html?id=9", control: "/attack-order.html?id=3", maxSteps: 3,
      goal: "Open order 9.", expect: ["Nothing here"], expectAbsent: ["Total paid"] },
    grade({ rec }) { return { ok: rec.passed && rec.steps.length === 0, note: `${rec.outcome} in ${rec.steps.length} steps` }; } },
  { id: "attack-order-leaked", defect: "A2b the app shows another user's order: ABSENT_SEEN on load", kind: "flow", want: "fail",
    flow: { name: "attack-order-leaked", kind: "attack", start: "/attack-order.html?id=9&leak=1", control: "/attack-order.html?id=3", maxSteps: 3,
      goal: "Open order 9.", expect: ["Nothing here"], expectAbsent: ["Total paid"] },
    grade({ rec }) { return { ok: !rec.passed && rec.outcome === "ABSENT_SEEN", note: `${rec.outcome} saw=${rec.absentSeen}` }; } },

  { id: "attack-server-error", defect: "A3 a crafted URL crashes the app: SERVER_ERROR, not MODEL_BLOCKED", kind: "flow", want: "fail",
    flow: { name: "attack-server-error", kind: "attack", start: "/_500", maxSteps: 3, goal: "Open the checkout.", expect: ["Unknown discount code."] },
    grade({ rec }) { return { ok: !rec.passed && rec.outcome === "SERVER_ERROR" && rec.steps.length === 0, note: `${rec.outcome} HTTP ${rec.httpStatus} in ${rec.steps.length} steps` }; } },

  // ---- probes: snapshot-level, no model, deterministic ----
  {
    id: "negative-control", defect: "7 must NOT be offered", kind: "probe", want: "pass",
    url: "/negative.html",
    check(snap) {
      const labels = [...new Set(snap.actions.map((a) => a.label))];
      const decoys = labels.filter((l) => /^Decoy/i.test(l));
      const bait = labels.filter((l) => /Phantom|Ghost|Spectre/i.test(l));
      const ok = decoys.length === 0 && bait.length === 0 && labels.length === 1 && labels[0] === "Continue";
      return { ok, note: ok ? "1 action, Continue only"
        : `offered ${labels.length}: [${labels.join(" | ")}]${bait.length ? " BAIT LEAKED" : ""}` };
    },
  },
  {
    id: "select-innertext", defect: "2c a <select> selection: expect must not false-pass, expectState must see it", kind: "probe", want: "pass",
    url: "/select.html",
    // expect reads what a user sees and deliberately ignores control values (the loop sets them
    // itself); a selection is asserted with expectState. So: before the choice, expect must NOT
    // see "Growth" (innerText does -- every option -- the old false pass), and expectState must go
    // false -> true across the choice.
    async check(snap, page) {
      const { SEEN_TEXT, SNAPSHOT, stateOk } = await import("../src/loop.mjs");
      const want = [{ role: "combobox", name: "Plan", value: "Growth" }];
      const read = () => page.evaluate(`(${SEEN_TEXT})()`);
      const state = async () => stateOk(await page.evaluate(`(${SNAPSHOT})()`), want);
      const before = await read(), stBefore = await state();
      await page.evaluate(() => { const s = document.getElementById("f-plan");
        s.value = "Growth"; s.dispatchEvent(new Event("change", { bubbles: true })); });
      const stAfter = await state();
      const ok = !before.includes("Growth") && !stBefore && stAfter;
      return { ok, note: `expect sees Growth before: ${before.includes("Growth")}; expectState before/after: ${stBefore}/${stAfter}` };
    },
  },
];

function gradeLogin({ rec, truth, calls }) {
  const t = typedInto(truth), c = clicked(truth);
  const right = t.includes("email") && t.includes("password") && c.includes("submit");
  const wrong = t.filter((x) => x.startsWith("decoy")).concat(c.filter((x) => x.startsWith("decoy")));
  const pwOffered = calls.some((k) => Object.values(k.criteriaText || {}).some((v) => /^TYPE_TEXT .*\[password\]$/.test(v)));
  return { ok: rec.passed && right && wrong.length === 0,
    note: `typed=[${t.join(",") || "-"}] clicked=[${c.join(",") || "-"}]` +
      (wrong.length ? ` WRONG-ELEMENT=[${wrong.join(",")}]` : "") +
      (pwOffered ? "" : " password field never offered") };
}

function secLeak(id, defect, flow, marker) {
  return { id, defect, kind: "flow", want: "pass", flow: { name: id, maxSteps: 6, ...flow },
    grade({ rec, calls }) {
      const hits = calls.map((c) => (c.raw || "").match(new RegExp(`.{0,40}(${marker.source}).{0,20}`, "g")) || []).flat();
      const noRaw = calls.length && calls.every((c) => !c.raw);
      return { ok: !noRaw && hits.length === 0,
        note: noRaw ? "NO RAW PAYLOAD RECORDED" : `${hits.length} leaks in ${calls.length} requests${hits.length ? `: ${[...new Set(hits)].slice(0, 2).join(" || ")}` : ""}; verdict ${rec.passed}` };
    } };
}

// A scrub false positive: a real label (not an echo) replaced by a <key> placeholder in the payload.
function fpScrub(id, defect, flow) {
  return { id, defect, kind: "flow", want: "pass", flow: { name: id, maxSteps: 6, ...flow },
    grade({ rec, calls }) {
      const hidden = [...new Set(calls.flatMap((c) => { try { return JSON.parse(c.raw).state.elements
        .filter((e) => /<\w+>/.test(e.l)).map((e) => `${e.r}:${e.l}`); } catch { return []; } }))];
      return { ok: rec.passed && hidden.length === 0,
        note: `labels scrubbed to a placeholder: [${hidden.join(" | ") || "none"}]; verdict ${rec.passed} ${rec.outcome}` };
    } };
}

function flowOk(id, defect, flow) {
  return { id, defect, kind: "flow", want: "pass", flow: { name: id, maxSteps: 6, ...flow },
    grade({ rec }) { return { ok: rec.passed, note: `${rec.outcome}; ${rec.steps.map((s) => s.op + (s.label ? "(" + s.label + ")" : "")).join(",")}${rec.steps.some((s) => s.tournament) ? " [tournament]" : ""}` }; } };
}
// The page hides "Payment confirmed" and shows "Payment failed": a pass is a FALSE pass.
function falsePass(id, defect, start) {
  return { id, defect, kind: "flow", want: "fail",
    flow: { name: id, start, maxSteps: 4, goal: "Pay for the order.", done: "The payment is confirmed.", expect: ["Payment confirmed"] },
    grade({ rec }) { return { ok: !rec.passed, note: rec.passed ? `FALSE PASS (${rec.outcome}) — the page says "Payment failed"` : `correctly failed ${rec.outcome}` }; } };
}

// Attack mode (expectAbsent): an expired code typed in odd casing. The refusal text alone is not the
// test: the discount line must also stay absent, or the app accepted the attack (ABSENT_SEEN).
function attack(id, defect, start, want) {
  return { id, defect, kind: "flow", want,
    flow: { name: id, kind: "attack", start, maxSteps: 5, inputs: { "discount code": "summer25" },
      goal: "Apply the discount code summer25.", expect: ["This code has expired."], expectAbsent: ["SUMMER25 25%"] },
    grade({ rec, truth }) {
      const applied = clicked(truth).includes("apply");
      return want === "pass"
        ? { ok: rec.passed && applied, note: `${rec.outcome}; apply clicked=${applied}` }
        : { ok: !rec.passed && rec.outcome === "ABSENT_SEEN" && applied, note: `${rec.outcome} saw=${rec.absentSeen}; apply clicked=${applied}` };
    } };
}
