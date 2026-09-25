// Sanity check for the Tier-2 apps, no model: (1) every assertion is FALSE on the start page,
// (2) a scripted Playwright solve makes it TRUE. Proves the apps work and the assertions are not weak.
import { chromium } from "playwright";
import { serveAll, PORTS } from "./stacks/serve.mjs";
import { TASKS } from "./tasks.mjs";

const { bases, close } = await serveAll();
const browser = await chromium.launch();
const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
async function asserted(page, t) {
  if (!new RegExp(t.expectUrl).test(page.url())) return false;
  const txt = norm(await page.evaluate(() => document.body.innerText));
  return t.expect.every((w) => txt.includes(norm(w)));
}
const role = (r, name) => (pg) => pg.getByRole(r, { name, exact: true });
// Scripted solves: the hand-written baseline a human would write. Frame-aware for iframe.
const SOLVE = {
  T1: async (pg, s) => {
    const f = s === "iframe" ? pg.frameLocator("iframe") : pg;
    if (s === "legacy") { await pg.fill("input[name=email]", TASKS.T1.inputs.email); await pg.fill("input[name=password]", TASKS.T1.inputs.password); await pg.click("#logon"); return; }
    await f.getByLabel("Email").fill(TASKS.T1.inputs.email);
    await f.getByLabel("Password").fill(TASKS.T1.inputs.password);
    await f.getByRole("button", { name: s === "legacy" ? "Log On" : "Sign in" }).click();
  },
  T2: async (pg, s) => {
    const f = s === "iframe" ? pg.frameLocator("iframe") : pg;
    if (s === "legacy") { await pg.fill("input[name=projectname]", "Orion"); await pg.selectOption("select[name=plan]", "Enterprise");
      await pg.check("input[name=terms]"); await pg.click("#save"); return; }
    await f.getByLabel("Project name").fill("Orion");
    if (s === "vanilla" || s === "iframe") await f.getByLabel("Plan").selectOption("Enterprise");
    else if (s === "antd") { await pg.locator(".ant-select").click(); await pg.locator(".ant-select-item-option[title=Enterprise]").click(); }
    else if (s === "vue-ep") { await pg.locator(".el-select").click(); await pg.locator(".el-select-dropdown__item", { hasText: "Enterprise" }).click(); }
    else if (s === "wc") { await pg.locator("sl-select").click(); await pg.locator("sl-option[value=Enterprise]").click(); }
    else { await f.getByRole("combobox").first().click(); await pg.getByRole("option", { name: "Enterprise", exact: true }).click(); }
    if (s === "vue-ep") await pg.getByText("I accept the terms").click();
    else if (s === "wc") await pg.locator("sl-checkbox label").click();   // the shadow <input> is not actionable
    else await f.getByRole("checkbox", { name: "I accept the terms" }).click();
    await f.getByRole("button", { name: "Create project" }).click();
  },
  T3: async (pg, s) => {
    const f = s === "iframe" ? pg.frameLocator("iframe") : pg;
    await f.getByRole("link", { name: "Quentin Harlow", exact: true }).click();
  },
};
let bad = 0;
for (const s of Object.keys(PORTS)) for (const [k, t] of Object.entries(TASKS)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage(); pg.setDefaultTimeout(5000);
  let before, after, err = "";
  try {
    await pg.goto(bases[s] + t.start); await pg.waitForLoadState("networkidle"); await pg.waitForTimeout(300);
    before = await asserted(pg, t);
    await SOLVE[k](pg, s);
    await pg.waitForURL(new RegExp(t.expectUrl), { timeout: 5000 }).catch(() => {});
    await pg.waitForTimeout(300);
    after = await asserted(pg, t);
  } catch (e) { err = String(e.message).split("\n")[0].slice(0, 120); }
  const ok = before === false && after === true;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${s.padEnd(8)} ${k} before=${before} after=${after} ${err} ${ok ? "" : pg.url()}`);
  await ctx.close();
}
await browser.close(); await close();
process.exit(bad ? 1 : 0);
