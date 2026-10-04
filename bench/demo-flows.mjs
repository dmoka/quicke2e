// Launch-video task: the whole purchase, from the home page. Same pass check as examples/ticketbay
// book-with-code (one paid order, WELCOME10 applied, total €109.39), but the agent must first find
// the event in the list. The quantity field defaults to 2 on TicketBay, so "2 tickets" needs no typing.
export const FLOWS = [
  { name: "buy-from-home", start: "/", maxSteps: 16,
    inputs: { name: "Alex Fan", email: "fan@example.com", "discount code": "WELCOME10" },
    goal: "Buy 2 tickets for Midnight Arcade — Neon Tour: open the event, continue to checkout, "
      + "apply the discount code WELCOME10, enter the email fan@example.com and the name Alex Fan, and pay.",
    done: "The order confirmation page is shown with the payment confirmed.",
    expectUrl: "/orders/\\d+\\?placed=1",
    expect: ["Payment confirmed", "WELCOME10 10%", "Total paid €109.39"] },
];
export default FLOWS;
