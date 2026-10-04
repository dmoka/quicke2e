<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="QuickE2E" src="docs/logo-light.png" width="420">
  </picture>
</p>

![QuickE2E buys two tickets with a discount code on TicketBay, from the home page, in 4.8 seconds](docs/demo.gif)

*Real time, not sped up. Task: from the home page, buy 2 tickets with the discount code WELCOME10.
Median of 5 runs each, all passed, same database check: **QuickE2E 4.79 s** (hosted Jev) and **3.23 s**
(local Shisa DE-1, $0), **Claude Code + Playwright MCP (Sonnet 5) 20.89 s**. Cost per run $0.00030
against $0.0888. Measured 2026-09-30 on an M2 Max; see [the launch-video task](#the-launch-video-task).*

> Formerly `jevtester`. **Unofficial:** not affiliated with TypeSafe, the makers of the Jev model that
> the default engine uses.

**An exploratory browser tester. It maps your app, a small decision model picks the clicks, your spec
supplies every typed value, and code decides pass or fail. A passing run becomes a plain Playwright
spec.**

```js
// quicke2e.spec.mjs
export default [{
  name: "book-with-code",
  start: "/events/midnight-arcade-neon-tour",
  inputs: { name: "Alex Fan", email: "fan@example.com", "discount code": "WELCOME10" },
  goal: "Book tickets: continue to checkout, apply the discount code WELCOME10, enter the email and name, and pay.",
  expectUrl: "/orders/\\d+\\?placed=1",                  // the assertion
  expect: ["Payment confirmed", "Total paid €109.39"],    // the assertion
}];
```

```
$ npx quicke2e run quicke2e.spec.mjs --base http://localhost:3200
PASS  book-with-code                8 steps    4.3s  $0.00032  DONE_VERIFIED
```

No selectors. The model never types, and it never decides whether the test passed. With the default
`jev` engine there is no LLM in the run loop.

**On the same checkout flow, quicke2e was 7.10× faster and 614× cheaper than Claude Code driving
Playwright MCP (Sonnet 5), and 8.30× faster and 675× cheaper than it on Opus 5.5.** Details below.

## Quick start

```bash
npm install -D quicke2e && npx playwright install chromium
export OPENROUTER_API_KEY=...                    # the Jev engine, via OpenRouter
npx quicke2e run quicke2e.spec.mjs --base http://localhost:3000
```

No app handy? Clone the repo and run the examples against the bundled fixture pages:

```bash
git clone https://github.com/dmoka/quicke2e && cd quicke2e && npm ci && npx playwright install chromium
node fixtures/serve.mjs 8899 &
npx quicke2e run examples/fixtures.spec.mjs --base http://127.0.0.1:8899
```

On your own app:

```bash
npx quicke2e discover http://localhost:3000 -o quicke2e.map.json      # map the app (once)
npx quicke2e check quicke2e.spec.mjs --base http://localhost:3000    # reject weak assertions
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --map quicke2e.map.json
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --emit e2e/generated/   # -> Playwright spec
npx quicke2e run   quicke2e.spec.mjs --base http://localhost:3000 --video runs/        # record the browser
```

`--video <dir>` saves a WebM of each run, and with `--trace <dir>` every step's start time, decision time
and the box of the element it acted on. The video shows what the browser showed, typed values included.

The browser is visible when you run a command yourself in a terminal, so you can watch what the model
does. It runs headless in CI (`CI` set), without a display, or when the output is piped. `--headed` and
`--headless` force either.

`npm test` runs the model-free test suite (no key, no cost).

## How it works

Three parts, and only one of them is a model.

1. **Discover (once).** `quicke2e discover` crawls the app with plain Playwright and writes a map:
   pages (`/events/:id`), the links and buttons between them, and every form with its fields, options,
   and where its submit leads. On `localhost` it submits forms (a full crawl), so point it at a
   throwaway database; `--reset "<cmd>"` restores your seed data first. On any other host it refuses
   unless you pass `--safe` or `--i-own-this-data`.
2. **Decide.** Each step, the page becomes a short list of legal moves (`TYPE_TEXT 3 Email [textbox]`,
   `CLICK 7 Pay [button]`). Jev returns one of **your** keys, with a confidence taken from its
   probability distribution over the offered keys. It cannot invent an action, a selector, or a value;
   an answer that is not an offered key is treated as BLOCKED. Nothing is ever dropped: when a page
   has more candidates than one decision can hold, they are split into heats that Jev decides in
   parallel (each with a "none of these" option), and the final is between the heat winners. With a
   map, Jev first picks the page the goal needs, and code walks there by the map's links.
3. **Verify.** Code decides success, checked on every snapshot:
   - `expectUrl`: a URL regex.
   - `expect`: text a sighted user sees on the page. Hidden, transparent, clipped and off-page text does
     not count, and neither do form controls: a value the test typed or chose itself is not a result.
   - `expectState: [{ role, name, value | checked | selected }]`: a control's state (a chosen option,
     a checked box, a field's value).
   - `expectSeen`: text that appeared at any moment since the page loaded, such as a toast.

**Text comes from the spec.** Spec keys match field labels (`email` → "Email"); one key fills one field
per page. When a label contains no key (a rename: "E-mail", "Ticket holder"), Jev picks which of your
unused keys belongs there — a typed choice over your keys, so the value still comes only from the spec.

**Your secrets stay out.** A spec key that looks secret (`password`, `api key`, `card number`, `token`,
…) never has its value sent to the engine. It is scrubbed from the whole request, including where the
page echoes it (re-cased, truncated, re-spaced, grouped, URL-encoded, or as a masked card "ending 6789"),
and from traces, maps and emitted specs on disk. A *weak* value (`admin`, `letmein1`) looks like an
ordinary word, so it is handled by history instead of shape: a page string that appears only after the
value was typed is an echo and is scrubbed; a string the page had before, or a label that is exactly
that word (an "Admin" link), is the page's own.

**Page content is what the engine decides on**, as with any browser agent. Content that must never leave
the page is declared in the spec:

```js
redact: [".backup-code", "#saved-cards", /recovery code \S+/i]   // CSS selectors and text patterns
```

A selector covers its elements anywhere (shadow roots and same-origin iframes included) and every
label, name or option derived from their text; a pattern covers raw text, such as the page title. The
same list works for `discover --redact`, so the map on disk stays clean too. A matched text shorter
than 4 characters (a 3-digit CVC) hides its own element but is not searched for in other text, because
cutting every "737" on a page would mangle numbers; declare such a copy with a pattern.

**`WEAK_ASSERTION`.** `run` and `check` first load the start page. If the assertion already holds before
any work, the spec is rejected. An assertion that is true on page load proves nothing.

**Codegen.** `--emit` turns a passing run into a Playwright spec with accessible-name locators and the
same assertions — the deterministic replay you can put in CI. Secret inputs are read from environment
variables only.

## Measured

All numbers measured on 2026-09-24 on an M2 Max, engine `jev` (`typesafe/jev-1.13` via OpenRouter)
unless stated.

**Head to head: TicketBay checkout** (the same start page, the same goal text, a database reset
before every run, and one SQL check for all arms: a new paid order with the right name, email and
total). Wall time is the whole command, end to end, including browser or MCP start-up.

| | pass | median wall | cost / run |
|---|---|---|---|
| **quicke2e, `jev` engine** | **5/5** | **3.05 s** | **$0.000153** |
| quicke2e, `local` engine, Shisa DE-1 | 5/5 | **2.04 s** | $0 |
| quicke2e, `local` engine, Eikos-4B | 5/5 | 4.36 s | $0 |
| Claude Code + Playwright MCP, Sonnet 5 | 5/5 | 21.67 s | $0.0940 |
| Claude Code + Playwright MCP, Opus 5.5 | 5/5 | 25.34 s | $0.1033 |

Hosted latency varies: one 5-run `jev` batch landed in a slow period on the hosted engine and took a
median 11.6 s (still 1.86× faster than Sonnet); the batch re-run right after gave the 3.05 s above. Both
batches are in the results file. The `local` engine does not have this variance.
Claude's cost is the `total_cost_usd` that `claude -p --output-format json` reports (API-equivalent).
Both approaches pass; the difference is time and money. Reproduce: `node bench/headtohead.mjs --arm jev --n 5`
and `node bench/headtohead.mjs --arm claude --model sonnet --n 5` (needs a running TicketBay); raw runs
in `bench/results/h2h-final.json`.

### The launch-video task

The GIF at the top. The agent starts on the home page, finds the event in the list, opens it, continues
to checkout, applies WELCOME10, enters the email and name, and pays. Same database check as above (one
new paid order, WELCOME10 applied, total €109.39). TicketBay in its dark theme, measured 2026-09-30.

| | pass | median wall | steps | cost / run |
|---|---|---|---|---|
| **QuickE2E, `local` engine, Shisa DE-1** | **5/5** | **3.23 s** | 7 | **$0** |
| **QuickE2E, `jev` engine** | **5/5** | **4.79 s** | 7 | $0.00030 |
| Claude Code + Playwright MCP, Sonnet 5 | 5/5 | 20.89 s (18.4–37.3) | 13–15 tool calls | $0.0888 |

Median decision time: 94 ms on Shisa DE-1 (local, no network), 327 ms on hosted Jev. TicketBay here is
the [`bench/2026-10`](https://github.com/dmoka/ticket-bay/tree/bench/2026-10) branch: the benchmark
commit `7bc02b6` plus one checkout fix (the discount-code form no longer reloads the page and wipes the
typed details; the same fix is `e40d86c` on TicketBay `main`). Before that fix, QuickE2E typed the email
and name a second time after applying the code.

Reproduce (TicketBay `bench/2026-10` running on :3200 as a production build; `APP_DIR` and
`DATABASE_URL` set for `examples/ticketbay/reset.sh`):

```bash
node bench/demo-capture.mjs --arm jev --n 5 --dark --spec bench/demo-flows.mjs --flow buy-from-home --out runs/demo
node bench/demo-capture.mjs --arm claude --model sonnet --n 5 --dark --spec bench/demo-flows.mjs --flow buy-from-home --out runs/demo
```

Each run writes a video and a timeline (steps, timestamps, tokens, cost). Claude Code's browser is
launched and recorded by the script and reached by the MCP server over CDP, so its video is complete.

**Eight UI stacks × three tasks.** Vanilla HTML, React + MUI, React + Ant Design, React + Radix/shadcn,
Vue 3 + Element Plus, Web Components (Shoelace + Lit, shadow DOM), a form inside a same-origin iframe,
and a legacy jQuery/table page. Tasks: log in; fill a form with a text field, a dropdown and a checkbox;
open row 57 of a 60-row list.

| | pass | median run | cost / run |
|---|---|---|---|
| quicke2e | **120/120** (n=5 per cell) | 1.8 s | $0.00014 |

Reproduce (about 4 minutes, about $0.014):

```bash
bench/stacks/build.sh && node bench/verify-stacks.mjs     # builds the 8 apps; 24/24 scripted checks, no model
node bench/run-matrix.mjs --approaches A --n 5 --out bench/results/mine.jsonl   # a NEW --out file
node bench/report.mjs bench/results/mine.jsonl
```

(Ports 5101–5108 must be free. `A` means this checkout's `src/`. The runner skips runs already in its
output file, so always pass a new `--out`.) The page-representation comparison behind this design —
in-page DOM snapshot vs Playwright's aria snapshot vs the CDP accessibility tree — is in
`docs/bakeoff-2026-09-24.md`.

**A real app: TicketBay** (the practice app of the *AI Agent Engineer* course: Next.js 16 +
shadcn/Radix + Postgres, production build, data reset before every run; specs in `examples/ticketbay/`):

| spec | jev | local (Eikos-4B / Shisa DE-1) | steps (jev) | wall (jev) | cost (jev) |
|---|---|---|---|---|---|
| book with a discount code | 5/5 | 5/5 / 5/5 | 8 | 4.3 s | $0.00032 |
| refund inside the window | 5/5 | 5/5 / 5/5 | 1 | 0.9 s | $0.00003 |
| refund refused after the event started | 5/5 | 5/5 / 5/5 | 1 | 0.9 s | $0.00003 |
| plain checkout | 5/5 | 5/5 / 5/5 | 4 | 2.5 s | $0.00015 |

The refund spec, run against a copy of TicketBay with the refund-window check removed, fails 5/5: it
catches the bug (the copy refunded €39.69 after the event started). The Playwright spec emitted from a
passing checkout run replays 3/3, about 0.8 s each including browser start, with no model.

**Fixture suite** (`fixtures/`: 59 small hand-written pages, n=3). Each page is a defect found in the
field or an attack from a ten-round security and robustness audit: shadow DOM, iframes, toasts, secret
echoes (re-cased, truncated, grouped, URL-encoded, weak), declared redaction through shadow roots and
iframes, hidden-text false passes, a 150-link page, a safe crawl. **jev 59/59; local Eikos-4B
58/59; local Shisa DE-1 56/59.** Strong spec secrets: 0 leaks.

## Engines

| engine | how | notes |
|---|---|---|
| `jev` (default) | `OPENROUTER_API_KEY` | hosted, any OS |
| `vercel` | `AI_GATEWAY_API_KEY` | the same Jev model through the Vercel AI Gateway (not measured for this release) |
| `local` | `local-engine/server.py` | **Apple Silicon only**, $0, offline. Open decision models: **Eikos-4B** (default, 4.1 GB, TicketBay 20/20, fixtures 58/59) or **Shisa DE-1** (`--model shisa-de-1`, 17 GB, needs `brew install llama.cpp`; TicketBay 20/20 and **faster than hosted Jev**: a checkout in 2.0 s against 3.05 s). They only pick an option, never write text. See `local-engine/README.md` |

## The skill: let a big model invent the cases

`skill/quicke2e/SKILL.md` is an agent skill (Claude Code and compatible agents). The big model reads the
map and your source code, lists the business rules (`rule — file:line`), invents happy-path, boundary
and refusal cases, writes the spec file, runs `check` and `run`, and reports which failures are app
bugs. The split is deliberate: the big model thinks once, offline; Jev drives cheaply, many times; code
judges.

## Limits

- **It checks your assertions. It does not find bugs you did not assert.** A green run proves the
  assertion, not that the app is correct.
- **Not a merge gate by itself.** A Jev run explores. The Playwright spec it emits can gate CI.
- **Tested stacks only:** the eight above plus TicketBay. Not tested: canvas apps, cross-origin iframes
  (Stripe Elements), closed shadow roots, native mobile.
- **The verdict is deterministic; the path is not guaranteed.** The same state gives the same choice, but
  page timing can add a step.
- **Page content reaches the engine unless you declare it with `redact`.** Nothing guesses which page
  text is sensitive: an automatic "looks like a code" rule was built and measured, and it broke four
  working flows (order numbers, versions, SKUs, a year) while still missing other code shapes.
- **A full crawl changes data.** Use a throwaway database. **`--safe` is best effort, not read-only:** it
  clicks only controls that declare they open something (menus, tabs, dropdowns) and skips links that
  name a destructive verb, but a GET link or an opener with a side effect can still change data.
- **The `local` engines trail Jev slightly on the fixture suite** (58/59 and 56/59 against 59/59).
  Eikos-4B is slower than Jev (a checkout in 4.4 s against 3.05 s); Shisa DE-1 is faster but needs a
  32 GB Mac.

## Design notes

What we measured while building it:
- **Remove bad options; do not instruct against them.** A decision model cannot be told out of a bad
  choice. Take it away: no DONE while a dropdown is open, no submit while a spec field is unset, no
  typing into a field the spec has no value for.
- **Form state goes in `values`, not in the choice list.** The same fact as a non-choosable element made
  Jev answer BLOCKED (0.37); as a `values` map it clicked Save (0.99).
- **Never let the model judge success.** The deterministic check, run on every snapshot, fixed every
  false DONE.

## License

MIT
