// TicketBay (main) attack specs: QuickE2E acting as a malicious user. Each attack asserts that the
// app REFUSES (`expect`) and that the success state is ABSENT (`expectAbsent`).
//
//   npm run db:seed                                            # in the TicketBay checkout
//   node examples/ticketbay/sign-in.mjs http://localhost:3000 .auth/anna.json
//   npx quicke2e check examples/ticketbay/attacks.mjs --base http://localhost:3000
//   npx quicke2e run   examples/ticketbay/attacks.mjs --base http://localhost:3000
//
// Seed facts (deterministic seed): anna@ticketbay.test owns orders 128, 214, 281 and 301; order 1
// belongs to another customer. LAUNCH50 is disabled. midnight-arcade-neon-tour: 2 x €45.00 + €2.70
// service fee = €92.70.
const anna = ".auth/anna.json";

export default [
  // Another user's order by URL. Loading the start URL is the attack, so the WEAK_ASSERTION check
  // runs on `control` (Anna's own order), where "Total paid" is shown and the assertion is false.
  { name: "attack-other-users-order", kind: "attack", storageState: anna,
    start: "/orders/1", control: "/orders/281", maxSteps: 3,
    goal: "Open order TB-00001.",
    expect: ["Nothing here"],
    expectAbsent: ["Total paid"] },

  // A disabled code in odd casing: refused, and the total stays €92.70.
  { name: "attack-disabled-code-odd-casing", kind: "attack", storageState: anna,
    start: "/events/midnight-arcade-neon-tour/checkout?qty=2", maxSteps: 6,
    inputs: { "discount code": "launch50" },
    goal: "Apply the discount code launch50.",
    expect: ["This code is no longer active.", "Total €92.70"],
    expectAbsent: ["% off tickets"] },
];
