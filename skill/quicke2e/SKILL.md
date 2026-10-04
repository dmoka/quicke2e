---
name: quicke2e
description: Invent and run exploratory browser test cases for a web app with quicke2e. Maps the app, reads its source for business rules, writes goal-based specs with deterministic assertions, runs them with a small decision model (hosted Jev or a local model), and reports findings. Use when the user says "quicke2e", "explore my app", "find UI bugs", "write browser test cases", or wants adversarial end-to-end checks without writing selectors.
---

# quicke2e — invent the cases, let Jev drive, let code judge

Division of labour. Do not blur it:
- **You (the big model)** invent the cases and write the spec files. Once, offline.
- **Jev** drives the browser for each spec. Cheap, fast, many times. It only ever picks one of the options the tool offers.
- **Code** decides pass or fail. Never you, never Jev.

## 1. Map the app

Ask for the base URL if you do not have it. Then:

```bash
npx quicke2e discover http://localhost:3000 --start / -o quicke2e.map.json
```

- Full crawl is the default on localhost: it submits forms. Use a throwaway database (`--reset "<cmd>"` to restore seed data).
- Any other host: use `--safe`, unless the user confirms the data is disposable (`--i-own-this-data`).
- Read the map: pages, edges, forms, fields, options, and what each form submit led to.

**Pages behind a login.** Save a logged-in browser state once, then use it for the crawl and every flow:

```js
// login.mjs: `node login.mjs` writes auth.json (credentials from env, never in the spec)
import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage();
await p.goto("http://localhost:3000/sign-in");
await p.getByLabel("Email").fill(process.env.TEST_EMAIL);
await p.getByLabel("Password").fill(process.env.TEST_PASSWORD);
await p.getByRole("button", { name: /sign in/i }).click();
await p.waitForURL((u) => !u.pathname.includes("sign-in"));
await p.context().storageState({ path: "auth.json" }); await b.close();
```

- Crawl with it: `npx quicke2e discover http://localhost:3000 --storage auth.json`. Without it, the map has only the signed-out pages.
- In each flow that needs the login: `storageState: "auth.json"`. One file per role (`customer.json`, `admin.json`).
- Re-run `login.mjs` after every database reset: a reseed deletes the sessions, and a stale `auth.json` sends every run to the sign-in page.

## 2. Read the rules in the source

The map shows WHERE things are. The source shows WHAT MUST BE TRUE. Read, in this order:
domain/business logic (pricing, limits, windows, permissions, state machines), validation schemas,
API/route handlers, seed data (real names, codes, dates you can use as inputs), README/PRD.
List every rule as one line: `rule — file:line`.

## 3. Invent the cases

For each form and each rule, write cases in three kinds:
1. **Happy path** — the main job of the page works.
2. **Boundary** — the edge of a rule: last valid day, max quantity, code at its limit.
3. **Refusal** — the rule must say no: expired window, sold out, wrong code, a started event, a user without the role.

Prefer the cases a scripted suite does not have. Check the existing tests first and say which rules they skip.

## 4. Write the spec

One file, `quicke2e.spec.mjs`, exporting an array:

```js
export default [
  {
    name: "refund-refused-after-start",
    start: "/orders",
    maxSteps: 14,
    inputs: { email: "buyer@example.com" },          // every typed value comes from here
    goal: "Open the order for the concert that already started and request a refund",
    expectUrl: "/orders/\\d+$",                        // THE ASSERTION
    expect: ["Refunds close when the event starts"],   // THE ASSERTION
    neverClick: ["Confirm refund*"],                   // a refusal test must not complete the action
  },
];
```

Rules for the assertion — the assertion IS the test:
- The run stops on the first snapshot where all assertions hold. Assert the page after the LAST action (after a submit, the page the submit leads to), or the run stops before it.
- Assert only what is true AFTER the work: a URL that cannot exist before, text that did not exist before, or a control state via `expectState: [{ role, name, value | checked | selected }]`.
- `expect` is text a sighted user sees. It ignores form controls (a value the test typed or chose is not a result) and hidden text. To check a chosen option or a field's value, use `expectState`. For a toast that disappears, use `expectSeen`.
- Never assert a label, a button text, or a word that is on the page anyway.
- For a refusal, assert the refusal text AND that the success state is absent (use a URL that only the refusal page has, or text only the refusal shows).
- **Every refusal case gets `neverClick` for its success action** (`"Pay*"`, `"Place order*"`, `"Delete*"`). If the app wrongly accepts, or the browser blocks the form first, the run then fails without buying, paying or deleting. Measured: a refusal case without it placed a real order.
- Browser validation (`min`, `max`, `required`, `type=email`) blocks a submit before the app sees it, and its bubble is not page text. Read these attributes in the source before you write a refusal case for them; such a rule is usually tested at a lower level.
- A dropdown takes its value from `inputs` too: key = words from its label, value = the option's visible text.
- Field keys in `inputs` must match the field label ("email" matches "Email"). Labels that share a substring ("Email" and "Billing email") get the same value: give such fields distinct keys or avoid the case.

If the page shows sensitive data the engine must not see (recovery codes, saved cards, personal
data), declare it in the spec: `redact: [".backup-code", "#saved-cards", /recovery code \S+/i]`
(CSS selectors and text patterns). Nothing is guessed automatically. Secret spec inputs (password,
api key, card number, token, …) are always kept out.

**Data between specs.** A spec that changes data (an order, a cancelled event) changes what the next spec sees. Order the specs so they do not collide, or restore seed data before each `run --only <name>`, then re-create `auth.json`.

**Not a quicke2e case:** an authorization check whose expected end state is the start page itself (open `/admin` as a customer, expect "Admins only"). `check` rejects it as `WEAK_ASSERTION`, because nothing has to happen. Write it as a plain Playwright test or an API test.

## 5. Check, then run

```bash
npx quicke2e check quicke2e.spec.mjs --base http://localhost:3000     # rejects WEAK_ASSERTION specs
npx quicke2e run quicke2e.spec.mjs --base http://localhost:3000 --map quicke2e.map.json --runs 3
```

A `WEAK_ASSERTION` means the assertion already holds on the start page: rewrite the assertion, never add `--allow-weak` to make it go away.

## 6. Report

For each failing spec: is it an APP bug (the rule in the source is violated) or a SPEC/TOOL problem (the run never reached the place)? Decide from the reasons first: the lines under each FAIL (or `--json` fields `assertions`, `heldBack`, `loop`, `emptyRequired`) say which assertion did not hold, which submit was held back for which field, and which action repeated. Then read the trace (`--trace runs/`): each step lists what the engine was offered (`offered`). The outcome: `DONE_VERIFIED` = pass; `MAX_STEPS`/`MODEL_BLOCKED`/`LOOP` = the run did not get there; a wrong final page with the success text visible = the app broke a rule.

- **Never edit a spec to make it pass.** A red refusal case is the finding.
- For each app bug: the rule (file:line), the spec name, what happened. Suggest the lowest-level test that would catch it.
- For a flow that must stay green, emit a Playwright spec from a passing run: `--emit e2e/generated/`.
