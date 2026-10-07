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
| `expect` | no | array of strings. Each must appear in the text a user sees on the page, as a substring, ignoring case (CSS `text-transform` changes case), after whitespace is collapsed. Form control values do not count. A test of case handling (an email normalized to lower case) needs `expectState` on the field or an `expectUrl` |
| `expectSeen` | no | like `expect`, but passes if the text appeared at any moment since the page loaded (toasts) |
| `expectState` | no | array of `{ role, name, value, selected, checked, expanded }`; every given key must match one control. `name` = the control's label (exact), `value` = substring |
| `expectAbsent` | no | array of strings that must NOT appear in the text a user sees (same matching as `expect`), at any moment of the run. When one appears, the run stops with outcome `ABSENT_SEEN` and fails. It must not be on the start page |
| `expectGone` | no | array of strings that must NOT be visible at the end. Unlike `expectAbsent`, they may be on the start page: use it for a delete (`expectGone: ["Temp task"]`) |
| `allowServerErrors` | no | `true`: a same-origin HTTP 5xx (page or fetch/XHR) does not fail the run. Default: it fails with `SERVER_ERROR` |
| `control` | no | a path where the app says yes (the user's own order). The `WEAK_ASSERTION` check loads it instead of `start`, and the run checks the assertion on the start page before any step. Use it when loading `start` is the attack |
| `kind` | no | a label copied into the run record and the output line. Use `"attack"` for attack specs |
| `redact` | no | array of CSS selector strings and `RegExp` objects (`/recovery code \S+/i`) |
| `storageState` | no | Playwright storage state (object or file path), for a logged-in start |
| `maxSteps` | no | step limit, default 14 |
| `neverClick` | no | elements never offered to the engine: case-insensitive globs over the whole label (`"Pay*"`) or `RegExp`s |
| `minConfidence` | no | engine picks below this confidence are not executed (default 0.3) |
| `dialog` | no | `"accept"` (default) or `"dismiss"` for native dialogs; a `prompt` gets the spec value whose key its message names |
| `navTimeout` | no | page-load timeout in ms (default 30000) |
| `maxTimeMs` | no | time budget; outcome `TIMEOUT` when it runs out |

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
5. **In a refusal test, block the success action with `neverClick`** (`neverClick: ["Pay*"]`). If the
   app does not refuse (or the browser blocks the form first), the run fails without paying, buying or
   deleting. A refusal spec without it can trigger the side effect it is testing against. Exception:
   when the app refuses ON that click (a server check behind "Place order"), do not list it; a failed run
   with `neverHidden` tells you this happened.
6. **A dropdown takes its value from `inputs` too**: key = words from the dropdown's label, value = the
   option's visible text (`country: "Hungary"`). A required dropdown with no key is left unset.
7. **Put content the engine must never see in `redact`** (CSS selectors or `/regex/` patterns).
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
  `2` = usage error, an invalid spec (wrong field type, unknown field, no assertion), or an API key the
  engine rejected (the run stops at the first flow: `stopped: the engine rejected the API key`);
  `3` = every failure was `ENGINE_ERROR` (engine timeout, 429/5xx): retry, it says nothing about the app.
- **Human output:** one line per run, `PASS|FAIL  <name>  <steps> steps  <seconds>s  $<cost>  <outcome>`,
  then `saw "<text>"` after an `ABSENT_SEEN`, `HTTP <status>` after a `SERVER_ERROR`, and `(<kind>)` when
  the spec has a `kind`.
- **Machine output:** with `--json`, the **last line of stdout** is a JSON array with one record per run.

| record field | type | meaning |
|---|---|---|
| `flow` | string | the spec's `name` |
| `passed` | boolean | the final assertion check: the result to trust |
| `outcome` | string | why the loop stopped: `DONE_VERIFIED` (all assertions held on a snapshot; the model has no "done" option), `ABSENT_SEEN` (an `expectAbsent` text appeared: the app accepted what it must refuse), `SERVER_ERROR` (a page navigation answered with HTTP 5xx; the run fails), `MODEL_BLOCKED` (the engine found no useful action, or only picks under `minConfidence`, three times on an unchanged page), `LOOP` (the same action ran 3 times on an unchanged page), `AUTH_REQUIRED` (the flow's `storageState` session is missing or expired: the start page redirected to sign-in), `TIMEOUT` (`maxTimeMs` ran out), `NO_SPEC_VALUE`, `MAX_STEPS` (step limit reached), `WEAK_ASSERTION` (the assertions held before the run executed any action: the spec proves nothing), `NOT_REFUSED` (a `control` load attack: the start page did not show the refusal; the run never acts on it), `ENGINE_ERROR` (the engine failed: timeout, 429/5xx, rejected key; not an app failure), `ERROR` (see `error`). Flows that never ran: `UNREACHABLE`, `WEAK_ASSERTION`, `ABSENT_ON_START`, `RESET_FAILED` (and `OK` from `check`); their records have the same fields with `steps: []` and `assertions: []` |
| `assertions` | array | one entry per assertion: `{ kind, value, held, actual? }` on the final page. Read this first on a failure |
| `heldBack` | array | on a failure: submits that were hidden because a spec field was unset: `{ label, waitingFor, key }` |
| `loop`, `lowConfidence`, `failedActions`, `emptyRequired` | | on a failure: the repeated action, the best pick under `minConfidence`, actions that threw, required fields still empty |
| `pageErrors`, `unusedInputs`, `unkeyedFields`, `unmatchedOptions`, `networkErrors`, `apiError` | | on a failure: what the page says is wrong (`role=alert`, `aria-live`, `aria-invalid` text); spec keys no field used (also on a pass); visible fields with no spec key; a select value that matches no option (with the options); failed requests (the app stopped?); the same-origin request that answered 5xx |
| `coveredBy`, `neverHidden`, `startStatus` | | on a failure: `{ label, by }` when another element (a cookie banner) lay over a click target; elements `neverClick` kept from the engine; the start page's HTTP status when it was 4xx (401: a login is needed) |
| `dialogs` | array | native dialogs the run handled: `{ type, message, action, inputKey? }` |
| `slowSteps` | array | actions that took over 3 s from decision to a settled page: `{ n, op, label, ms }` (also on a pass) |
| `error` | string or null | the error message with `ERROR`, `ENGINE_ERROR`, and a skipped flow's reason |
| `absentSeen` | string | only with `ABSENT_SEEN`: the `expectAbsent` text that appeared |
| `httpStatus` | number | only with `SERVER_ERROR`: the 5xx status |
| `kind` | string | only when the spec has a `kind` |
| `finalUrl` | string | the URL when the run ended |
| `steps` | array | one entry per decision: `n`, `op` (`CLICK`, `TYPE_TEXT`, `SELECT`, `PRESS_ENTER`, `HOVER`, `DRAG`, `CLOSE` (Escape on an open list), `WAIT`, `BLOCKED`), `label` (the element), `url`, `confidence`, `ms` (decision time) |
| `wallMs` | number | total run time in ms |
| `cost` | number | engine cost in USD (`0` on `local`), including early decisions that were discarded |
| `engine` | string | `jev`, `vercel` or `local` |

Other fields (`base`, `budget`, `decideMs`, `inferMs`, `weakEchoed`, `speculative` (early decisions used and
wasted), per-step `target`, `inputKey`, `via`, `tokens`) are diagnostics. Do not depend on them.

On a failure, read `assertions` (which ones did not hold), then `heldBack`, `loop` and `emptyRequired`,
then the last entries of `steps`. The human output prints the same reasons under the FAIL line.
`--trace <dir>` also stores, per step, the list of options the engine was offered (`offered`). Add `--trace <dir>` for a full JSON trace per run and `--video <dir>` for a
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
