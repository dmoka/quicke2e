// Sign in to TicketBay as the seeded customer and save the session for specs (`storageState`).
//   node examples/ticketbay/sign-in.mjs [base] [out]   defaults: http://localhost:3000 .auth/anna.json
// The password is the public demo password from TicketBay's README seed.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const out = process.argv[3] || ".auth/anna.json";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(base + "/sign-in");
await page.getByLabel("Email").fill("anna@ticketbay.test");
await page.getByLabel("Password").fill("ticketbay-demo");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
fs.mkdirSync(path.dirname(out), { recursive: true });
await ctx.storageState({ path: out });
await browser.close();
console.log(`signed in as anna@ticketbay.test -> ${out}`);
