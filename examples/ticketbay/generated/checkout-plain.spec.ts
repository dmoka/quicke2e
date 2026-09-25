// GENERATED from a passed exploratory run -- do not hand-edit; regenerate.
// flow: checkout-plain   engine: jev   outcome: DONE_VERIFIED   4 steps in 2462 ms
// Every locator below is an ACCESSIBLE NAME. A rename in the app breaks this spec --
// that is the intended signal, not a defect. See replay-or-heal.mjs.
import { test, expect } from "@playwright/test";

const BASE = process.env.APP_BASE ?? "http://localhost:3200";
const INPUTS = {
  name: process.env.CHECKOUT_PLAIN_NAME ?? "Alex Fan",
  email: process.env.CHECKOUT_PLAIN_EMAIL ?? "fan@example.com",
};

test("checkout-plain", async ({ page }) => {
  await page.goto(BASE + "/events/midnight-arcade-neon-tour");
  await page.getByRole("button", { name: "Continue to checkout", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("/events/midnight-arcade-neon-tour/checkout"));
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(INPUTS.email);
  await page.getByRole("textbox", { name: "Name on tickets", exact: true }).fill(INPUTS.name);
  await page.getByRole("button", { name: new RegExp("^Pay") }).click();

  // ---- the assertion. This, not the steps, is the test.
  await expect(page).toHaveURL(new RegExp("/orders/\\d+\\?placed=1"), { timeout: 5000 });
  await expect(page.locator("body")).toContainText("Payment confirmed", { timeout: 5000 });
  await expect(page.locator("body")).toContainText("Total paid €121.54", { timeout: 5000 });
});
