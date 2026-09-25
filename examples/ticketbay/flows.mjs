// TicketBay (ticket-bay-v2, branch app/v2) flow specs. Four money paths, no selectors.
//
// Data contract: every run starts from a fresh `npm run db:seed` (see reset.sh). The seed is
// deterministic (fixed PRNG, dates relative to the current hour, TRUNCATE ... RESTART IDENTITY),
// so order ids and amounts below are stable. reset.sh re-checks every fact these specs rely on
// and refuses to continue if one has drifted.
//
//   order #1  = midnight-arcade-neon-tour (starts in 12 days), paid, 2 tickets, tickets 7670
//               -> cancel inside the window: 7670 less a 2% fee (153) = 7517 = "Refunded €75.17"
//   order #10 = velvet-static-live (started 20 days ago), paid, 1 ticket
//               -> the window is closed: refund must be €0.00 and the seats stay sold
//   event midnight-arcade-neon-tour: €59.00, 12 days out (no early-bird), qty defaults to 2
//               -> plain:      2 x 5900 = 11800 + 3% fee 354       = €121.54
//               -> WELCOME10:  11800 - 10% = 10620 + 3% fee 319    = €109.39
//
// README finding #4 -- every assertion below was checked to be FALSE on its start page
// (precheck.mjs), so none can pass by doing nothing:
//   - "Total paid" is only rendered on /orders/<id>; checkout says "Total".
//   - "Refunded €…" is only rendered once status=refunded; before it the page says
//     "Cancel now and get €75.17 back" / "Cancelling now refunds €0.00" (lower-case, different verb).
//   - /orders/<id>?placed=1 cannot exist before Pay is clicked.
//
// Input keys are matched against field LABELS by substring, first key wins (loop.mjs keyFor).
// "Name on tickets" contains both "name" and "tickets", so no spec here uses a "tickets" key:
// the event page's quantity already defaults to 2.
const EVENT = "midnight-arcade-neon-tour";

export const FLOWS = [
  // (a) booking with a discount code
  { name: "book-with-code", start: `/events/${EVENT}`, maxSteps: 16,
    inputs: { name: "Alex Fan", email: "fan@example.com", "discount code": "WELCOME10" },
    goal: "Book tickets for this event: continue to checkout, apply the discount code WELCOME10, "
      + "enter the email fan@example.com and the name Alex Fan, and pay.",
    done: "The order confirmation page is shown with the payment confirmed.",
    expectUrl: "/orders/\\d+\\?placed=1",
    expect: ["Payment confirmed", "WELCOME10 10%", "Total paid €109.39"] },

  // (b) refund inside the window
  { name: "refund-in-window", start: "/orders/1", maxSteps: 8,
    goal: "Cancel this order to get a refund.",
    done: "The order shows it was refunded.",
    expectUrl: "/orders/1$",
    expect: ["Refunded €75.17", "The seats went back on sale."] },

  // (c) refund after the event started -> must be refused (€0.00, seats stay sold)
  { name: "refund-after-start", start: "/orders/10", maxSteps: 8,
    goal: "Cancel this order to get a refund.",
    done: "The order shows it was cancelled.",
    expectUrl: "/orders/10$",
    expect: ["Refunded €0.00", "Cancelled after the event started — no refund"] },

  // (d) plain checkout, no code -- the benchmark flow. Keep it boring.
  { name: "checkout-plain", start: `/events/${EVENT}`, maxSteps: 12,
    inputs: { name: "Alex Fan", email: "fan@example.com" },
    goal: "Book tickets for this event: continue to checkout, enter the email fan@example.com "
      + "and the name Alex Fan, and pay.",
    done: "The order confirmation page is shown with the payment confirmed.",
    expectUrl: "/orders/\\d+\\?placed=1",
    expect: ["Payment confirmed", "Total paid €121.54"] },
];
