<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img alt="QuickE2E" src="docs/logo.svg" width="420">
  </picture>
</p>

<p align="center">
  <b>Plain-English end-to-end tests for web apps.<br>A small decision model picks each click. Code decides pass or fail.</b>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#attack-cases">Attack cases</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#engines">Engines</a> ·
  <a href="#limits">Limits</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/quicke2e"><img alt="npm" src="https://img.shields.io/npm/v/quicke2e"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/dmoka/quicke2e/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dmoka/quicke2e/actions/workflows/ci.yml/badge.svg?branch=main"></a>
</p>

<p align="center"><sub>For AI agents: <a href="AGENTS.md"><code>AGENTS.md</code></a> (spec rules, exit codes, the <code>--json</code> record) · <a href="llms.txt"><code>llms.txt</code></a> · <a href="skill/quicke2e/SKILL.md">agent skill</a></sub></p>

<br>
<br>

![QuickE2E with the local Shisa DE-1 model buys two tickets with a discount code on TicketBay, from the home page, in 2.9 seconds](docs/demo.gif)

*Recorded at 1× speed with the `local` engine (Shisa DE-1). Task: from the TicketBay home page, buy 2 tickets with the discount code WELCOME10.*

| launch task, 5 runs per arm | median wall time | pass | cost / run |
|---|---|---|---|
| **QuickE2E, `local` engine, Shisa DE-1** | **2.94 s** | 5/5 | **$0** |
| **QuickE2E, hosted Jev** | **3.74 s** | 5/5 | $0.00038 |
| Claude Code + Playwright MCP, Sonnet 5 | 25.29 s (21.8–29.6) | 5/5 | $0.0896 |

Local Shisa DE-1 against Claude Code: **8.6× faster, at $0 per run.** Hosted Jev against Claude Code:
**6.7× faster and 234× cheaper.** Same start page, same goal, one SQL check for every run. Measured
2026-10-06 with QuickE2E 0.5.0 on an M2 Max. Raw runs: [`bench/results/launch-task.json`](bench/results/launch-task.json). [Method and other tasks](#benchmarks).

## What it is

QuickE2E is an exploratory end-to-end browser tester. A spec holds a goal in plain English, the values
to type, and an assertion. Each step, QuickE2E turns the page into a list of legal moves, a decision
model returns the key of one move, and code checks the assertion on every page snapshot.

- **No selectors in the spec.** A spec holds a goal, inputs and assertions.
- **The engine writes no text.** It returns one of the offered keys. Every typed value comes from the spec's `inputs`.
- **Code decides pass or fail.** It checks the URL, the text a user sees, and control state.
- **`--emit` turns a passing run into a Playwright spec.** The spec replays in CI with no model call.
- **Secret-looking spec values are scrubbed** from every engine request, and from traces, maps and emitted specs on disk.
- **The `local` engine costs $0 per run** and makes no network call after the first model download. It needs Apple Silicon.

```js
// quicke2e.spec.mjs (the book-with-code spec from examples/ticketbay/flows.mjs)
export default [{
  name: "book-with-code",
  start: "/events/midnight-arcade-neon-tour",
  maxSteps: 16,
  inputs: { name: "Alex Fan", email: "fan@example.com", "discount code": "WELCOME10" },
  goal: "Book tickets for this event: continue to checkout, apply the discount code WELCOME10, "
    + "enter the email fan@example.com and the name Alex Fan, and pay.",
  expectUrl: "/orders/\\d+\\?placed=1",                                  // the assertion
  expect: ["Payment confirmed", "WELCOME10 10%", "Total paid €109.39"],  // the assertion
}];
```

## Quick start

Requires Node 20 or later.

**1. Install** (`@playwright/test` runs the Playwright specs that `--emit` writes):

```bash
npm i -D quicke2e @playwright/test && npx playwright install chromium
export OPENROUTER_API_KEY=...        # the default jev engine calls OpenRouter; --engine local needs no key
```

**2. Write a spec.** Save the example from the top of this page as `quicke2e.spec.mjs` and change
`start`, `goal`, `inputs` and the assertions to one flow of your app. Assert the page after the last
action: the run stops on the first snapshot where all assertions hold.

**3. Check it, then run it** (your app must be running):

```bash
npx quicke2e check quicke2e.spec.mjs --base http://localhost:3000   # rejects a spec that proves nothing
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000
```

On TicketBay, the example spec printed this (hosted Jev, 2026-09-24):

```console
$ npx quicke2e run quicke2e.spec.mjs --base http://localhost:3200
PASS  book-with-code                8 steps    4.3s  $0.00032  DONE_VERIFIED
```

A failed run prints the reason under its line: each assertion that did not hold, a submit held back
for an empty field, a repeated action (`LOOP`), and required fields left empty.

No app at hand? Clone the repo and run three example flows (`login`, `choose-a-plan`,
`weekly-digest-toast`) against the bundled fixture pages:

```bash
git clone https://github.com/dmoka/quicke2e && cd quicke2e && npm ci && npx playwright install chromium
node fixtures/serve.mjs 8899 &
npx quicke2e run examples/fixtures.spec.mjs --base http://127.0.0.1:8899
```

### On your own app

```bash
npx quicke2e discover http://localhost:3000 -o quicke2e.map.json      # map the app (once, no model)
npx quicke2e check quicke2e.spec.mjs --base http://localhost:3000    # reject weak assertions
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --map quicke2e.map.json
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --emit e2e/generated/   # -> Playwright spec
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --video runs/        # record the browser
```

The browser is visible when you run a command in a terminal. It runs headless when `CI` is set, when
the output is piped, or on Linux with no `DISPLAY` or `WAYLAND_DISPLAY`. `--headed` and `--headless`
force either mode.

`run` and `check` exit with code 1 when any spec fails, fails the `WEAK_ASSERTION` check, or its start
page is unreachable, and with code 2 on a usage error (an unknown option is an error, not ignored).

## How it works

QuickE2E has three parts. Only the second part calls a model.

### 1. Discover (once)

`quicke2e discover` crawls the app with plain Playwright and writes a map: pages (`/events/:id`), the
links and buttons between them, and every form with its fields, options, and the page its submit leads
to.

On `localhost`, `127.0.0.1`, `[::1]` and `0.0.0.0`, discover submits forms (a full crawl), so point it
at a throwaway database. `--reset "<cmd>"` restores your seed data first. On any other host, a full
crawl stops with an error unless you pass `--i-own-this-data`. Pass `--safe` for a crawl that submits
no form. Neither mode clicks a log-out control.

### 2. Decide

Each step, the page becomes a short list of legal moves (`TYPE_TEXT 3 Email [textbox]`,
`CLICK 7 Pay [button]`). The engine returns one of the offered keys, with a confidence. It cannot
invent an action, a selector or a value. QuickE2E treats an answer that is not an offered key as
BLOCKED and does not act on it.

When a page has more candidates than one decision can hold, QuickE2E splits them into heats. The
engine decides the heats in parallel, each with a "none of these" option, and then decides a final
between the heat winners. No candidate is dropped.

After an action, QuickE2E waits until the page has been quiet for 150 ms before it decides. With a
hosted engine, it sends the next decision before that wait, on the page as it is. After the wait it
builds the request again from the settled page. It uses the early answer only when both requests are
byte-identical; otherwise it discards the answer and asks again. The engine gets the same input as
without the early call, so the decisions do not change. A discarded early call is counted in the
run's cost. `QUICKE2E_SPECULATE=0` turns this off. It is off for the `local` engine, which answers one
request at a time.

With a map (`--map`), the engine first picks the page the goal needs. If the start page is in the map
and the map has a link route, code clicks along that route. A run never moves to another page of the
start page's own pattern: a spec that starts on `/orders/281` stays on order 281.

### 3. Verify

Code decides success. It checks the assertions on every snapshot:

| assertion | passes when |
|---|---|
| `expectUrl` | the URL matches this regex |
| `expect` | a sighted user sees this text on the page. Hidden, `aria-hidden`, transparent, clipped and off-page text does not count. The values of form controls do not count, because the test typed or chose them |
| `expectState: [{ role, name, value \| checked \| selected }]` | a control has this state (a chosen option, a checked box, a field's value) |
| `expectSeen` | this text appeared at any moment since the page loaded, such as a toast |
| `expectAbsent` | a sighted user does NOT see this text. When it appears, the run stops with outcome `ABSENT_SEEN` and fails |

The run stops on the first snapshot where all assertions hold, and that run passes. Write the assertions
for the state after the last action: after a submit, assert the page the submit leads to.

### Text comes from the spec

Spec keys match field labels by substring (`email` → "Email"). One key fills one field per page. When
a label contains no key (a renamed label such as "E-mail" or "Ticket holder"), the engine picks which
of your unused keys belongs there. That pick is a choice over your keys, so the value still comes only
from the spec. QuickE2E never maps a key into a number, date or file field this way.

### `WEAK_ASSERTION`

`run` and `check` first load the start page. If the assertion already holds before any step, QuickE2E
rejects the spec with `WEAK_ASSERTION`, because an assertion that is true on page load passes without
any work. A spec with `control` is checked on the control page instead (see [Attack cases](#attack-cases)).
An `expectAbsent` text that is already on the start page fails the check with `ABSENT_ON_START`.

### Codegen

`--emit <dir>` turns a passing run into `<dir>/<name>.spec.ts`: a plain Playwright spec with the same
assertions. Each locator is built and verified on the live page during the run, before the action: it
must match exactly one element, the one the run acted on. The order of candidates: Playwright's own role
and accessible name; that, scoped to the row or card holding the element (`getByRole("listitem").filter({
hasText: "Sauce Labs Bike Light" })`), when several elements share the name; label, placeholder, test id;
position. Assertions read the page with the same text function as the run, so a green replay means what a
passing run meant. Native dialogs, Escape presses, hover and drag replay the same way, and a path
`storageState` becomes `test.use({ storageState })`. Measured on saucedemo.com: 9 of 9 emitted specs replay. Each input is read from an environment variable named
`<FLOW>_<KEY>` (for example `CHECKOUT_PLAIN_EMAIL`). A non-secret input falls back to the spec value. A
secret input has no fallback, so the credential is never written into the file: without the variable,
that one test is skipped with a message.

## Attack cases

Attacks are not a separate mode. In every session the agent skill writes happy-path cases first, then
boundary, refusal and attack cases. When a happy path fails, the attacks on that flow wait. This is the
attack instruction it follows, word for word:

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
// examples/ticketbay/attacks.mjs (TicketBay main, signed in as the seeded customer Anna)
{ name: "attack-disabled-code-odd-casing", kind: "attack", storageState: ".auth/anna.json",
  start: "/events/midnight-arcade-neon-tour/checkout?qty=2",
  inputs: { "discount code": "launch50" },
  goal: "Apply the discount code launch50.",
  expect: ["This code is no longer active.", "Total €92.70"],   // the app refuses, the total is unchanged
  expectAbsent: ["% off tickets"] }                             // the applied-code line never appears
```

When loading the start URL is the attack (another user's order at `/orders/1`), the assertion holds on
page load. Give such a spec a `control` path where the app says yes (`/orders/281`, the user's own
order): `check` runs the `WEAK_ASSERTION` check on the control page, and the run checks the assertion
on the start page before any step.

On TicketBay main (2026-10-04), both specs in `examples/ticketbay/attacks.mjs` passed 3/3 on `jev` and
3/3 on `local` Shisa DE-1. The other-user's-order spec passes in 0 steps with no engine call; the code
spec takes 2 steps.

**Limits of attack cases.** One browser and one action at a time: no simultaneous double clicks, races
or multi-tab flows. No header, cookie or request-body tampering, and no network-level attacks. Test those
with API property tests or a code-level adversarial tester. A crafted URL in `start` is in scope. Attack
only an app you own: the full crawl runs only on localhost unless you pass `--i-own-this-data`.

## Secrets and redaction

**Secret inputs.** A spec key is secret when its name matches a pattern such as `password`,
`api key`, `card`, `token`, `otp` or `iban`. QuickE2E scrubs a strong secret value (10 or more
characters with 2 or more character classes, or a number with 10 or more digits) from every engine
request, including places where the page echoes it: re-cased, truncated, re-spaced, grouped,
URL-encoded, or as a masked card "ending 6789". It also scrubs the value from traces, maps and emitted
specs on disk.

**Weak secret values.** A weak value (`admin`, `letmein1`) looks like an ordinary word, so QuickE2E
classifies page strings by history:
- A page string that appears only after the value was typed is an echo. QuickE2E scrubs it.
- A string the page had before, or a label that is exactly that word (an "Admin" link), is the page's own text. QuickE2E keeps it, and it reaches the engine.

`run` prints a note for every weak secret in a spec.

**Page content.** The engine decides on page content: labels, the page title, and form values. Declare
content that must never leave the page in the spec:

```js
redact: [".backup-code", "#saved-cards", /recovery code \S+/i]   // CSS selectors and text patterns
```

- A selector covers its elements in the document, open shadow roots and same-origin iframes, and every label, name or option derived from their text.
- A pattern covers raw text, such as the page title and URLs.
- `discover --redact` takes the same list, so the map on disk stays clean.
- A matched text with fewer than 4 letters or digits (a 3-digit CVC) hides its own element, but QuickE2E does not search for it in other text, because cutting every "737" on a page would corrupt prices and numbers. Declare such a copy with a pattern.

## Benchmarks

Machine: an M2 Max. Hosted engine: `jev` (`typesafe/jev-1.13` via OpenRouter). Claude's cost is the
`total_cost_usd` that `claude -p --output-format json` reports (API-equivalent). Wall time is the whole
command, end to end, including browser or MCP start-up.

### Launch task: buy from the home page (the GIF)

The agent starts on the home page, finds the event in the list, opens it, continues to checkout,
applies WELCOME10, enters the email and name, and pays. The check for every run: one new paid order,
WELCOME10 applied, total €109.39. TicketBay in its dark theme, QuickE2E 0.5.0, measured 2026-10-06.

| | pass | median wall | steps | cost / run |
|---|---|---|---|---|
| **QuickE2E, `local` engine, Shisa DE-1** | **5/5** | **2.94 s** (2.77–2.99) | 7 | **$0** |
| **QuickE2E, `jev` engine** | **5/5** | **3.74 s** (3.59–4.74) | 7 | $0.00038 |
| Claude Code + Playwright MCP, Sonnet 5 | 5/5 | 25.29 s (21.8–29.6) | 15–16 tool calls | $0.0896 |

Shisa DE-1 against Sonnet 5: 25.29 / 2.94 = 8.60 (8.6× faster), $0 per run. Hosted Jev against
Sonnet 5: 25.29 / 3.74 = 6.76 (6.7× faster); $0.0896 / $0.00038 = 234 (234× cheaper). Median decision
time: 86 ms on Shisa DE-1 (local, no network), 300 ms on hosted Jev.

Jev's cost per run includes early decisions that were discarded (see [Decide](#2-decide)): 0.4.0 cost
$0.00031 per run on the same task. The first measurement (QuickE2E 0.2.0, 2026-09-29/30): Shisa DE-1
3.23 s, Jev 4.79 s, Claude Code 20.89 s; raw runs in
[`bench/results/launch-task-2026-09-29.json`](bench/results/launch-task-2026-09-29.json). Claude Code's
median changes from day to day on the same task: 20.89 s then, 25.29 s on 2026-10-06.

<details>
<summary>App version and reproduce</summary>

TicketBay here is the [`bench/2026-10`](https://github.com/dmoka/ticket-bay/tree/bench/2026-10) branch:
the benchmark commit `7bc02b6` plus one checkout fix. With the fix, the discount-code form no longer
reloads the page and wipes the typed details. The same fix is `e40d86c` on TicketBay `main`. Before
that fix, QuickE2E typed the email and name a second time after applying the code.

Run TicketBay `bench/2026-10` on :3200 as a production build, and set `APP_DIR` and `DATABASE_URL` for
`examples/ticketbay/reset.sh`. Then:

```bash
node bench/demo-capture.mjs --arm jev --n 5 --dark --spec bench/demo-flows.mjs --flow buy-from-home --out runs/demo
node bench/demo-capture.mjs --arm jev --engine local --n 5 --dark --spec bench/demo-flows.mjs --flow buy-from-home --out runs/demo
node bench/demo-capture.mjs --arm claude --model sonnet --n 5 --dark --spec bench/demo-flows.mjs --flow buy-from-home --out runs/demo
```

The `--engine local` line needs the local engine server running with `--model shisa-de-1`. Each run
writes a video and a timeline (steps, timestamps, tokens, cost), and the script prints the median wall
time and median cost. The script launches and records Claude Code's browser, and the MCP server reaches
that browser over CDP, so the Claude Code video is complete.

</details>

### Plain checkout: start on the event page (2026-09-24)

A shorter task: start on the event page, continue to checkout, enter the email and name, and pay (no
discount code). Same goal text for every arm, a database reset before every run, and one SQL check: a
new paid order with the right name, email and total.

| | pass | median wall | mean cost / run |
|---|---|---|---|
| **QuickE2E, `jev` engine** | **5/5** | **3.05 s** | **$0.000153** |
| QuickE2E, `local` engine, Shisa DE-1 | 5/5 | **2.04 s** | $0 |
| QuickE2E, `local` engine, Eikos-4B | 5/5 | 4.36 s | $0 |
| Claude Code + Playwright MCP, Sonnet 5 | 5/5 | 21.67 s | $0.0940 |
| Claude Code + Playwright MCP, Opus 5.5 | 5/5 | 25.34 s | $0.1033 |

Hosted Jev was 7.10× faster and 614× cheaper than Sonnet 5, and 8.30× faster and 675× cheaper than
Opus 5.5 (median wall time, mean cost). The two `local` rows were measured on 2026-09-28.

Hosted latency varies. One 5-run `jev` batch ran during a slow period on the hosted engine and took a
median 11.6 s (1.86× faster than Sonnet 5). The batch re-run right after it gave the 3.05 s above. The
`local` engine sends no request over the network, so this variance does not apply to it.

<details>
<summary>Reproduce</summary>

Needs a running TicketBay.

```bash
node bench/headtohead.mjs --arm jev --n 5
node bench/headtohead.mjs --arm claude --model sonnet --n 5
```

Raw runs of the `jev` batches (both) and the Claude Code arms: `bench/results/h2h-final.json`.

</details>

### Eight UI stacks × three tasks

Stacks: vanilla HTML, React + MUI, React + Ant Design, React + Radix/shadcn, Vue 3 + Element Plus, Web
Components (Shoelace + Lit, shadow DOM), a form inside a same-origin iframe, and a legacy jQuery/table
page. Tasks: log in; fill a form with a text field, a dropdown and a checkbox; open row 57 of a 60-row
list.

| engine | pass | median run | mean cost / run |
|---|---|---|---|
| `jev` | **120/120** (24 cells, n=5 per cell) | 1.8 s | $0.00014 |

Raw runs: `bench/results/6c6a550.jsonl`. The page-representation comparison behind this design
(in-page DOM snapshot vs Playwright's aria snapshot vs the CDP accessibility tree) is in
[`docs/bakeoff-2026-09-24.md`](docs/bakeoff-2026-09-24.md).

<details>
<summary>Reproduce (about 4 minutes, about $0.017)</summary>

```bash
bench/stacks/build.sh && node bench/verify-stacks.mjs     # builds the 8 apps; 24/24 scripted checks, no model
node bench/run-matrix.mjs --approaches A --n 5 --out bench/results/mine.jsonl   # a NEW --out file
node bench/report.mjs bench/results/mine.jsonl
```

Ports 5101–5108 must be free. `A` means this checkout's `src/`. The runner skips runs already in its
output file, so always pass a new `--out`.

</details>

### Four TicketBay specs

TicketBay is the practice app of the *AI Agent Engineer* course: Next.js 16 + shadcn/Radix + Postgres,
production build, data reset before every run. Specs are in `examples/ticketbay/`. The `jev` columns
are from 2026-09-24, the `local` column from 2026-09-28.

| spec | jev | local (Eikos-4B / Shisa DE-1) | steps (jev) | wall (jev) | cost (jev) |
|---|---|---|---|---|---|
| book with a discount code | 5/5 | 5/5 / 5/5 | 8 | 4.3 s | $0.00032 |
| refund inside the window | 5/5 | 5/5 / 5/5 | 1 | 0.9 s | $0.00003 |
| refund refused after the event started | 5/5 | 5/5 / 5/5 | 1 | 0.9 s | $0.00003 |
| plain checkout | 5/5 | 5/5 / 5/5 | 4 | 2.5 s | $0.00015 |

- **The refund spec found a planted bug.** It fails 5/5 against a copy of TicketBay with the refund-window check removed. That copy refunded €39.69 after the event started.
- **The emitted spec replays.** The Playwright spec emitted from a passing checkout run replays 3/3, about 0.8 s each including browser start, with no model.

### Fixture suite

`fixtures/` holds 59 small hand-written pages, run at n=3. Each page is a defect found in the field or
an attack from the project's ten-round security and robustness audit: shadow DOM, iframes, toasts,
secret echoes (re-cased, truncated, grouped, URL-encoded, weak), declared redaction through shadow
roots and iframes, hidden-text false passes, a 150-link page, a safe crawl.

| engine | pass |
|---|---|
| `jev` | **59/59** |
| `local`, Eikos-4B | 58/59 |
| `local`, Shisa DE-1 | 56/59 |

Strong spec secrets in the suite: 0 leaks.

Attack cases added two pages and five fixtures (2026-10-04): an expired code in odd casing (refused, and
refused-but-applied), another user's order by URL (refused, and leaked), and a URL that answers HTTP 500.
`jev` 5/5 and `local` Shisa DE-1 5/5, n=3. Against the code before this change, four of the five fail.

## Engines

Select an engine with `--engine`. Jev is a model by TypeSafe. QuickE2E is an independent project, not affiliated with TypeSafe.

| engine | setup | notes |
|---|---|---|
| `jev` (default) | `OPENROUTER_API_KEY` | Hosted, any OS. |
| `vercel` | `AI_GATEWAY_API_KEY` | The same Jev model through the Vercel AI Gateway. Not measured for this release. |
| `local` | `local-engine/server.py` | **Apple Silicon only.** $0 per run. Open decision models that read the logits of the option labels and generate no text. |

The `local` engine runs one of two open models:

| | **Eikos-4B** (default) | **Shisa DE-1** (`--model shisa-de-1`) | Jev (hosted) |
|---|---|---|---|
| what it is | Qwen3.5-4B fine-tuned for decisions | Gemma 4 26B MoE, 3.8B active per token | TypeSafe's hosted model |
| peak memory | **4.1 GB** | 17.4 GB | none locally |
| Mac | any Apple Silicon Mac with 8 GB or more | 32 GB, and `brew install llama.cpp` | any OS |
| TicketBay (4 specs × 5) | 20/20 | 20/20 | 20/20 |
| plain checkout, end to end | 4.4 s | **2.0 s** | 3.05 s |
| fixture suite (59 pages, n=3) | 58/59 | 56/59 | 59/59 |

Measured 2026-09-28 on an M2 Max with 64 GB. Shisa DE-1 beats hosted Jev on the plain checkout because
only 3.8B parameters are active per token and no request crosses the network.

<details>
<summary>Run the local engine</summary>

```bash
cd local-engine
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt
.venv/bin/python server.py                      # Eikos-4B (default), :8822
.venv/bin/python server.py --model shisa-de-1   # Shisa DE-1 (needs: brew install llama.cpp)
```

Then run `quicke2e run ... --engine local`. Set `LOCAL_URL` if the server uses another port. The first
start downloads the model. `GET /` reports the model, peak memory and decisions served. Details,
prompt format and model licences: [`local-engine/README.md`](local-engine/README.md).

</details>

## The agent skill: a big model invents the cases

`skill/quicke2e/SKILL.md` is an agent skill for Claude Code and compatible agents. The big model:

1. reads the map and your source code,
2. lists the business rules (`rule — file:line`),
3. invents happy-path, boundary, refusal and [attack](#attack-cases) cases,
4. writes the spec file and runs `check` and `run`,
5. reports which failures are app bugs.

The big model runs once to write the specs. The decision engine makes every decision of every run.
Code decides pass or fail.

## Reference

<details>
<summary>CLI</summary>

```
quicke2e discover <baseUrl> [--start /,/admin] [--safe] [--i-own-this-data] [--reset "<cmd>"]
                            [--inputs inputs.json] [--storage state.json] [-o quicke2e.map.json]
                            [--redact ".css-selector" --redact "/regex/i" ...] [--headed|--headless]
quicke2e run <spec.mjs> [--base url] [--engine jev|local|vercel] [--map quicke2e.map.json]
                        [--runs N] [--emit dir] [--trace dir] [--video dir] [--headed|--headless]
                        [--allow-weak] [--only name]
quicke2e check <spec.mjs> [--base url]
```

| flag | command | effect |
|---|---|---|
| `--start` | discover | comma-separated start paths (default `/`) |
| `--safe` | discover | safe crawl: follows links, opens menus, dialogs and dropdowns, and never submits a form (see [Limits](#limits)) |
| `--i-own-this-data` | discover | allow a full crawl on a host other than `localhost` |
| `--reset "<cmd>"` | discover | command that restores seed data before the crawl |
| `--inputs` | discover | JSON file with values for forms during the crawl |
| `--storage` | discover | Playwright storage-state file |
| `--max-pages` | discover | page limit for the crawl (default 40) |
| `-o` | discover | output map file (default `quicke2e.map.json`) |
| `--redact` | discover | CSS selector or `/regex/`; repeat the flag for more |
| `--base` | run, check | app base URL (default `$APP_BASE`, then `http://localhost:3000`) |
| `--engine` | run | `jev` (default), `local` or `vercel` |
| `--map` | run | map file from `discover` |
| `--runs` | run | runs per spec (default 1) |
| `--only` | run, check | run only the spec with this `name` |
| `--emit` | run | write a Playwright spec for each passing run |
| `--trace` | run | write a JSON trace per run, with each step's start time and decision time |
| `--video` | run | save a WebM per run. With `--trace`, each step in the trace also gets the box of the element it acted on. The video shows typed values |
| `--allow-weak` | run | run a spec that failed the `WEAK_ASSERTION` check |
| `--json` | run, check | print all records as one JSON array on the last line of stdout, including flows that never ran (`UNREACHABLE`, `WEAK_ASSERTION`); fields: [`AGENTS.md`](AGENTS.md#run-and-read-the-result) |
| `--min-confidence` | run | below this engine confidence an action is not executed (default 0.3) |
| `--nav-timeout` | run | page-load timeout in ms (default 30000) |
| `--reset` | run | shell command run before every run, to restore seed data (a failing command stops that flow with `RESET_FAILED`) |
| `--headed` / `--headless` | all | force the browser mode |

| environment variable | effect |
|---|---|
| `OPENROUTER_API_KEY` | key for the `jev` engine |
| `AI_GATEWAY_API_KEY` | key for the `vercel` engine |
| `LOCAL_URL` | URL of the local engine server (default `http://127.0.0.1:8822`) |
| `APP_BASE` | default `--base` |
| `QUICKE2E_SPECULATE=0` | turn off early decisions (see [Decide](#2-decide)) |
| `QUICKE2E_PROF=1` | add per-step timings (settle, snapshot, decide, act) to each run record |
| `JEV_DEBUG=1` | print the page state and the options of every decision to stderr |

</details>

<details>
<summary>Spec fields</summary>

A spec file exports an array of flows (`export default [...]`).

| field | meaning |
|---|---|
| `name` | flow name, used in output, `--only` and emitted file names |
| `start` | start path (default `/`) |
| `base` | base URL for this flow; overrides `--base` |
| `goal` | the task in plain English |
| `inputs` | every value the run types, keyed by field label |
| `expectUrl`, `expect`, `expectState`, `expectSeen`, `expectAbsent` | the assertions (see [Verify](#3-verify)) |
| `control` | a path where the app says yes; the `WEAK_ASSERTION` check loads it instead of `start` (see [Attack cases](#attack-cases)) |
| `kind` | a label for the run record and the output line, such as `"attack"` |
| `redact` | CSS selectors and text patterns the engine must never see |
| `storageState` | Playwright storage state for the browser context |
| `maxSteps` | step limit (default 14) |
| `neverClick` | elements the engine is never offered: case-insensitive globs over the whole label (`"Pay*"`, `"*delete*"`) or RegExps. Use it in refusal tests so a failed refusal cannot buy, pay or delete |
| `minConfidence` | an action the engine picks below this confidence is not executed and counts as BLOCKED (default 0.3, or `--min-confidence`) |
| `dialog` | `"accept"` (default) or `"dismiss"` for native `confirm`/`alert`/`prompt` dialogs; a prompt gets the spec value whose key its message names |
| `navTimeout` | page-load timeout in ms (default 30000, or `--nav-timeout`) |
| `maxTimeMs` | time budget for the run; when it runs out, the outcome is `TIMEOUT` |
| `done` | optional plain-English end state, for the reader. The run loop does not send it to the engine |

</details>

<details>
<summary>Run outcomes</summary>

The outcome says why the run loop stopped. Pass or fail comes from the final assertion check.

| outcome | meaning |
|---|---|
| `DONE_VERIFIED` | the assertions held on a snapshot |
| `ABSENT_SEEN` | an `expectAbsent` text appeared: the app accepted what it must refuse |
| `SERVER_ERROR` | a page navigation answered with HTTP 5xx. The run fails, whatever the assertions say |
| `MODEL_BLOCKED` | the engine answered BLOCKED (or a key that was not offered) three times, each time on a page that did not change within 3 s |
| `NO_SPEC_VALUE` | the run needed a value the spec does not have |
| `MAX_STEPS` | the step limit ran out |
| `LOOP` | the same action ran 3 times on a page that did not change; the 4th was not executed |
| `AUTH_REQUIRED` | the flow has a `storageState`, but the start page redirected to a sign-in page: the session is missing or expired |
| `TIMEOUT` | the flow's `maxTimeMs` ran out |
| `ERROR` | the run threw an error |

</details>

## Limits

- **QuickE2E checks only the assertions in the spec.** A green run proves those assertions and nothing else about the app.
- **Use the emitted Playwright spec as the CI merge gate.** A model-driven run can take a different path on the next run.
- **Tested stacks:** the eight above plus TicketBay, saucedemo.com (React), practicesoftwaretesting.com (Angular), demoqa.com and the-internet. Not tested: canvas apps, cross-origin iframes (Stripe Elements), closed shadow roots, native mobile.
- **Hover and drag are offered only for recognisable patterns.** HOVER: an element whose container holds hidden text (a caption, a tooltip). DRAG: elements marked draggable or named "drag" onto drop zones named "drop". Custom drag libraries with other markup are not detected.
- **Native dialogs are accepted by default** (`dialog: "dismiss"` flips it); a `prompt` takes the spec value whose key its message names. Block a destructive action in a refusal test with `neverClick`.
- **The step count can vary.** Page timing can add a step. The verdict comes from code, so the same final page gives the same verdict.
- **Page content reaches the engine unless you declare it with `redact`.** No rule guesses which page text is sensitive. An automatic "looks like a code" rule was built and measured: it broke four working flows (order numbers, versions, SKUs, a year) and still missed other code shapes.
- **A full crawl changes data.** Use a throwaway database.
- **`--safe` is best effort.** It clicks only controls that declare they open something (menus, tabs, dropdowns) and skips links whose text or URL names a destructive verb. A GET link or an opener with a side effect can still change data.
- **The `local` engines fail more fixtures than Jev.** On the 74-fixture suite (2026-10-06): Shisa DE-1 71/74, Jev 74/74. Shisa DE-1 answers BLOCKED on a field whose label matches no spec key and on a submit inside an iframe, and clicks one save button twice. On the earlier 59-fixture suite the two local engines passed 58/59 and 56/59. Eikos-4B is slower than Jev (a plain checkout in 4.4 s against 3.05 s). Shisa DE-1 is faster but needs a 32 GB Mac.

<details>
<summary>What does a run cost?</summary>

- Hosted `jev`: the sum of the `usage.cost` that OpenRouter reports per decision. Measured: $0.00003 (a 1-step refund spec) to $0.00032 (an 8-step checkout) on TicketBay, and a mean of $0.00014 on the eight-stack matrix.
- `local`: $0.
- `discover` and `check` call no model, so they cost $0.
- The agent skill runs on your own agent, at that agent's price.

</details>

<details>
<summary>What data leaves my machine?</summary>

With `jev` or `vercel`, each decision sends one request to OpenRouter or the Vercel AI Gateway. It
holds:
- the URL with token-like path segments replaced by `:id`, and the first 60 characters of the page title,
- the offered elements: role and label (up to 44 characters each),
- form values: a chosen option, a checkbox state, or a typed value that is exactly a non-secret spec value. Any other filled field is sent as `(filled)`,
- the last 5 steps, the goal, and the list of legal moves,
- for a field whose label matches no spec key: the label and the names of your unused spec keys (the values stay local).

Strong secret values are scrubbed from all of it. Content you declare in `redact` is removed before the
request is built. With `--map`, one or two extra requests send the app's host name and a summary of each
mapped page (path pattern, heading, form fields). With `local`, requests go only to the local server
(`127.0.0.1:8822` by default). `discover` and the emitted Playwright spec call no model.

</details>

<details>
<summary>Which API keys do I need?</summary>

| engine | key |
|---|---|
| `jev` | `OPENROUTER_API_KEY` |
| `vercel` | `AI_GATEWAY_API_KEY` |
| `local` | none |

`discover`, `check` and `npm test` need no key.

</details>

<details>
<summary>How do I use it in CI?</summary>

1. Run `quicke2e run ... --emit e2e/generated/` locally until the spec passes.
2. Commit the emitted `<name>.spec.ts` and run it with `npx playwright test`. It calls no model.
3. Set `APP_BASE` to the app's URL, and set one environment variable per secret input (`<FLOW>_<KEY>`, for example `LOGIN_PASSWORD`).

`quicke2e run` also works in CI. It runs headless when `CI` is set and exits with code 1 when a spec
fails.

</details>

## Design notes

<details>
<summary>What we measured while building it</summary>

- **Bad options are removed from the list.** A prompt instruction does not stop a decision model from picking a bad option, so the tool removes the option: no DONE option at all, no submit while a spec field is unset, no typing into a field the spec has no value for.
- **Form state goes in a `values` map.** The same fact as a non-choosable element in the choice list made Jev answer BLOCKED (0.37). As a `values` map, Jev clicked Save (0.99).
- **Code judges success.** The deterministic check runs on every snapshot, and the model is never asked whether the task is done. This removed every false DONE in the measured runs.

</details>

## Development

```bash
npm test     # the model-free test suite: no key, no cost
```

On every push and pull request, CI runs the model-free suite and the local-engine prompt tests. When
the repo has an `OPENROUTER_API_KEY` secret, CI also runs the fixture flows on the hosted Jev engine.

## License

MIT
