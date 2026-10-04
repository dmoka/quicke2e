# AGENTS.md

Instructions for AI coding agents. Part 1: use QuickE2E to test a web app. Part 2: change this repo.

## Part 1: test a web app with QuickE2E

### Setup

```bash
npm install -D quicke2e && npx playwright install chromium
export OPENROUTER_API_KEY=...   # engine "jev" (default). Engine "vercel" reads AI_GATEWAY_API_KEY.
```

The engine `local` needs no key: start `local-engine/server.py` (Apple Silicon only) and set `LOCAL_URL`
if it does not listen on `http://127.0.0.1:8822`.

In a checkout of this repo, run the CLI as `node bin/quicke2e.mjs` instead of `npx quicke2e`.

### Write a spec

A spec file exports an array of flows. One flow = one goal and its assertions.

```js
// quicke2e.spec.mjs
export default [{
  name: "book-with-code",                                   // unique; used by --only and in file names
  start: "/events/midnight-arcade-neon-tour",               // start path
  inputs: { name: "Alex Fan", email: "fan@example.com", "discount code": "WELCOME10" },
  goal: "Book tickets: continue to checkout, apply the discount code WELCOME10, enter the email and name, and pay.",
  expectUrl: "/orders/\\d+\\?placed=1",                     // regex on the final URL
  expect: ["Payment confirmed", "Total paid €109.39"],      // text a user sees on the final page
}];
```

Flow fields:

| field | required | format and matching |
|---|---|---|
| `name` | yes | string, unique in the file |
| `goal` | yes | the task in plain English |
| `start` | no | a path, appended to the base URL (default `/`). Not a full URL |
| `base` | no | base URL for this flow. Order: `base`, then `--base`, then `$APP_BASE`, then `http://localhost:3000` |
| `inputs` | no | `{ "<words from the field label>": "<value>" }` |
| `expectUrl` | no | a JavaScript regex string, tested against the **full** final URL, unanchored. Escape `.` and `?` |
| `expect` | no | array of strings. Each must appear in the text a user sees on the page, as a substring, case-sensitive, after whitespace is collapsed. Form control values do not count |
| `expectSeen` | no | like `expect`, but passes if the text appeared at any moment since the page loaded (toasts) |
| `expectState` | no | array of `{ role, name, value, selected, checked, expanded }`; every given key must match one control. `name` = the control's label (exact), `value` = substring |
| `expectAbsent` | no | array of strings that must NOT appear in the text a user sees (same matching as `expect`). When one appears, the run stops with outcome `ABSENT_SEEN` and fails |
| `control` | no | a path where the app says yes (the user's own order). The `WEAK_ASSERTION` check loads it instead of `start`, and the run checks the assertion on the start page before any step. Use it when loading `start` is the attack |
| `kind` | no | a label copied into the run record and the output line. Use `"attack"` for attack specs |
| `redact` | no | array of CSS selector strings and `RegExp` objects (`/recovery code \S+/i`) |
| `storageState` | no | Playwright storage state (object or file path), for a logged-in start |
| `maxSteps` | no | step limit, default 14 |

All given assertions must hold at the same time. The run checks them on every page snapshot and
**stops as soon as they all hold**, so the assertions must describe the state after the last action.

`expectState` roles: `textbox`, `password`, `combobox` (a native `<select>` or a custom dropdown trigger),
`checkbox`, `radio`, `switch`, `button`, `link`, `tab`, `option`, `menuitem`. For a `<select>`, `value`
is the visible text of the chosen option. `checked` applies to checkboxes, radios and switches;
`selected` reads `aria-selected` (options, tabs).

Rules:

0. **Assert the result of the final action.** If the flow ends with a submit, assert the page after the
   submit (`expectUrl` + `expect`). An assertion that already holds before the submit (the dropdown
   shows "Growth") stops the run before the submit is clicked. Use `expectState` only for state that
   stays on the final page.

1. **Every value the run types goes in `inputs`**, keyed by words from the field's label. The engine
   never writes text. When no key matches a label ("E-mail" for key `email`), the engine picks which
   key belongs in that field. A field with no key is left as it is. If the engine picks a field that
   needs a value the spec does not have, the run ends (outcome `NO_SPEC_VALUE`): add that value to `inputs`.
2. **Name every action the goal needs.** Write "apply the discount code WELCOME10", not "with the code
   WELCOME10": with the second wording the engine typed the code and never clicked Apply.
3. **Assert the end state, not the start state.** `check` rejects a spec whose assertions already hold
   on the start page (`WEAK_ASSERTION`).
4. **Use `expectSeen` for text that disappears** (toasts) and `expectState` for control state
   (checked, selected, disabled). `expect` reads only text a user sees, not form control values.
5. **Put content the engine must never see in `redact`** (CSS selectors or `/regex/` patterns).
   Secret-looking `inputs` values are scrubbed from engine requests automatically.

### Attack cases

**Attack: always think like an attacker too.** Every session, without being asked, also invents attack cases: think like an attacker, a chaos engineer and a senior QA engineer. Invent the cases a scripted suite never has, within what QuickE2E can execute:
- Abusive values typed into real fields: negative, zero and huge quantities, overlong and unicode strings, script tags, SQL-looking strings, extra spaces and odd casing on codes.
- Discount-code abuse: a used-up code again, a second code on top of the first, an expired or disabled code in odd casing.
- Another user's resource by URL: `start` is someone else's order, `control` is the user's own order.
- Crafted URLs in `start`: odd query values (`?qty=-3`), repeated parameters (`?code=A&code=B`), ids in another format (`/orders/0x2`).
- A closed window: an event that already started, a sold-out show.
- A finished flow submitted again through its URL.
- Required fields left empty or filled with garbage.

Every attack asserts two things. The app refuses: the refusal text or the error state the user sees goes in `expect`. The success state is absent: text that only success shows (the confirmation, the discount line, the refund line) goes in `expectAbsent`, never a label that is on the page at load. The refusal text alone is not enough, because an app can show the error and still apply the discount. When an `expectAbsent` text becomes visible, the run stops with outcome `ABSENT_SEEN`: the app accepted the attack. An error page (a 500) fails the run too, because the refusal text never appears.

```js
export default [
  { name: "disabled-code-odd-casing", kind: "attack", storageState: ".auth/anna.json",
    start: "/events/midnight-arcade-neon-tour/checkout?qty=2",
    inputs: { "discount code": "launch50" },
    goal: "Apply the discount code launch50.",
    expect: ["This code is no longer active.", "Total €92.70"],   // the app refuses, the total is unchanged
    expectAbsent: ["% off tickets"] },                            // the applied-code line never appears
  { name: "other-users-order", kind: "attack", storageState: ".auth/anna.json",
    start: "/orders/1", control: "/orders/281",                   // someone else's order; the user's own
    goal: "Open order TB-00001.", expect: ["Nothing here"], expectAbsent: ["Total paid"] },
];
```

Run the happy paths first. When one fails, the attacks on that flow wait until it passes.

Limits: one browser and one action at a time (no double-click races, no multi-tab flows), and no
header, cookie, request-body or network tampering (a crafted URL in `start` is in scope). Test those
with API property tests or a code-level adversarial tester. Attack only an app you own.

### Run and read the result

The app must be running for both commands: `check` loads each start page.

```bash
npx quicke2e check quicke2e.spec.mjs --base http://localhost:3000     # validate specs, no model call
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --json --headless
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --engine local --only book-with-code
```

`--engine jev|vercel|local` picks the engine (default `jev`). `--only <name>` runs one flow. `--runs N`
repeats each flow.

- **Exit code:** `0` = every run passed; `1` = a run failed, a spec failed the `WEAK_ASSERTION`
  or `ABSENT_ON_START` check, or a start page was unreachable (line `UNREACHABLE <name>: <url> (...). Is the app running?`);
  `2` = usage error.
- **Human output:** one line per run, `PASS|FAIL  <name>  <steps> steps  <seconds>s  $<cost>  <outcome>`,
  then `saw "<text>"` after an `ABSENT_SEEN`, `HTTP <status>` after a `SERVER_ERROR`, and `(<kind>)` when
  the spec has a `kind`.
- **Machine output:** with `--json`, the **last line of stdout** is a JSON array with one record per run.

| record field | type | meaning |
|---|---|---|
| `flow` | string | the spec's `name` |
| `passed` | boolean | the final assertion check: the result to trust |
| `outcome` | string | why the loop stopped: `DONE_VERIFIED` (all assertions held on a snapshot; the model has no "done" option), `ABSENT_SEEN` (an `expectAbsent` text appeared: the app accepted what it must refuse), `SERVER_ERROR` (a page navigation answered with HTTP 5xx; the run fails), `MODEL_BLOCKED` (the engine found no useful action three times on an unchanged page), `NO_SPEC_VALUE`, `MAX_STEPS` (step limit reached), `ERROR` (see `error`) |
| `error` | string or null | the error message when `outcome` is `ERROR` |
| `absentSeen` | string | only with `ABSENT_SEEN`: the `expectAbsent` text that appeared |
| `httpStatus` | number | only with `SERVER_ERROR`: the 5xx status |
| `kind` | string | only when the spec has a `kind` |
| `finalUrl` | string | the URL when the run ended |
| `steps` | array | one entry per decision: `n`, `op` (`CLICK`, `TYPE_TEXT`, `SELECT`, `WAIT`, `BLOCKED`), `label` (the element), `url`, `confidence`, `ms` (decision time) |
| `wallMs` | number | total run time in ms |
| `cost` | number | engine cost in USD (`0` on `local`) |
| `engine` | string | `jev`, `vercel` or `local` |

Other fields (`base`, `budget`, `decideMs`, `inferMs`, `weakEchoed`, per-step `target`, `inputKey`, `via`,
`tokens`) are diagnostics. Do not depend on them.

On a failure, read `outcome`, then the last entries of `steps` (the page and the elements the engine
chose), then `finalUrl`. Add `--trace <dir>` for a full JSON trace per run and `--video <dir>` for a
WebM recording.

### Turn a passing run into a CI test

```bash
npx quicke2e run quicke2e.spec.mjs --base http://localhost:3000 --emit e2e/generated/
```

`--emit` writes a plain Playwright spec per passing run. It replays without a model call.

### Let the agent invent the cases

`skill/quicke2e/SKILL.md` is a skill for Claude Code and compatible agents: it maps the app
(`quicke2e discover`), reads the source for business rules, writes specs, runs them, and reports
findings.

## Part 2: change this repo

- `src/loop.mjs`: the run loop (snapshot → offered actions → engine decision → act → assertion check).
  `src/discover.mjs`: the crawler. `src/secret.mjs`, `src/redact.mjs`: what the engine may see.
  `codegen/codegen.mjs`: the Playwright export. `bin/quicke2e.mjs`: the CLI. `local-engine/`: the local engine.
- Tests: `npm test` (model-free, no key, no cost) and `python3 -m unittest local-engine/test_server.py`.
  CI also runs `node fixtures/run.mjs --checkout . --engine jev --n 1` when `OPENROUTER_API_KEY` is set.
- A behaviour change needs a fixture page in `fixtures/pages/` and a flow in `fixtures/flows.mjs` that
  fails before the change and passes after it.
- Never send a secret spec value to the engine: route new page text through the scrub in `src/secret.mjs`.
