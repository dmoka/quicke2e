# fixtures — one page per confirmed defect

Hand-written vanilla HTML. **No build step, no dependencies, no component libraries.** Built
2026-09-21 after field testing found the tool scored 30/30 on the app it was written against and
**MUI 18/24, Ant Design 6/21, legacy/enterprise 12/30** on real ones: one app, one component library,
one layout flatters the tool. The first 17 pages are defects found in the field; the rest were added by
the 2026-09-24 security and robustness audit (shadow DOM, iframes, toasts, secret echoes, safe crawl).

## Why these pages and not a taxonomy of widgets

Seeded from bugs that were **measured**, not from a guess about which widgets matter. A fixture you
design is a fixture you design to pass; every defect below surprised us.

Survey of 12 browser-agent repos: **0 of 12 vendor a component library** into a test bed; **7 of 12
vendor small hand-written pages**. This follows that shape.

| page | catches |
|---|---|
| `table.html` / `table2.html` | budget starvation — 60 rows, target is the LAST link. Fails at budget 30, 60, 120 AND 250 |
| `form-heavy.html` | the other side of the same tension: a form starved when links are promoted |
| `select.html` | native `<select>` — options dedupe to the placeholder, `SELECT` has no dispatch branch, and `checkGoal` cannot see a selection at all |
| `modal-list.html` | a truncated option list eats the escape hatch |
| `menu-sidebar.html` | `role=menuitem` nav mistaken for an open dropdown |
| `ambiguous.html` | label-substring matching: `{name:"Zed"}` filled First, Middle AND Last Name |
| `aria-label.html` + `redeem-done.html` | `aria-labelledby`-only labelling, and the ZWSP **false pass** |
| `ordinal-a/b.html` | `filled` keyed on a per-snapshot ordinal, so it suppresses typing on a later page |
| `negative.html` | elements that must **NOT** be offered — hidden, `display:none`, zero-size, plus prose bait |
| `login.html` + `login.mutated.html` | the rename pair |

## The two that matter most

**`negative.html`** asserts what must not appear. Everyone tests what a tool finds; nobody tests
what it wrongly finds. Two of this project's defects were exactly that shape.

**`login.html` / `login.mutated.html`** freezes the project's flagship demo, which until now existed
only as a README claim with no code. Field labels, the submit button and a link are renamed, one
`aria-label` changes, one list item is deleted — but **every `id` and `data-testid` is byte-identical
across both files**, and a hidden `data-truth` attribute never enters the candidate list. That is
what lets the harness assert the loop hit the RIGHT element instead of merely surviving.

It earned itself immediately: `aria-label.html` reported **verdict 3/3, right-element 0/3** —
`DONE_VERIFIED` in one step having typed nothing, because a zero-width-stripping fix made
`Access​code accepted` and `Access code accepted` compare equal. Only `data-truth` told them
apart. Fixed in `7ca7d64`.

## Run

```
node fixtures/serve.mjs                                  # static server for pages/
node fixtures/run.mjs --checkout . --engine jev --n 3    # or --engine local
node fixtures/run.mjs --checkout . --pin <name> --n 3    # copy the tree first, so edits mid-run cannot skew it
```

**Pin before measuring.** An earlier baseline was invalidated by `src/loop.mjs` being edited on main
mid-run.
