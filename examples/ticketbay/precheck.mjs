// README finding #4: an assertion must be FALSE before the work. Loads each flow's start page
// on a freshly reset DB and evaluates the SAME predicates checkGoal() uses (URL regex, then
// normalised innerText substrings). Every flow must print FALSE, or its spec proves nothing.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FLOWS } from "./flows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.APP_BASE || "http://localhost:3200";
const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
execFileSync(path.join(here, "reset.sh"), { stdio: "pipe" });
const browser = await chromium.launch({ headless: true });
let bad = 0;
for (const f of FLOWS) {
  const page = await browser.newPage();
  await page.goto(base + f.start, { waitUntil: "networkidle" });
  const text = norm(await page.evaluate(() => document.body.innerText));
  const urlOk = f.expectUrl ? new RegExp(f.expectUrl).test(page.url()) : true;
  const each = (f.expect || []).map((w) => [w, text.includes(norm(w))]);
  const all = urlOk && each.every(([, v]) => v);
  if (all) bad++;
  console.log(`${f.name.padEnd(20)} goal-on-start-page=${all ? "TRUE (WEAK!)" : "FALSE"}  url=${urlOk}  `
    + each.map(([w, v]) => `${JSON.stringify(w)}=${v}`).join("  "));
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
