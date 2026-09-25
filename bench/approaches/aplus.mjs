// A+ : in-page snapshot that pierces open shadow roots and same-origin iframes (aplus-snapshot.js),
// with native-select options and hidden-checkbox labels. Acts by stamp in whichever frame holds it
// (Playwright CSS pierces open shadow roots), then the src/ role fallback per frame.
import fs from "node:fs";
import path from "node:path";
import { roleFallback, viaLabel } from "../lib/core.mjs";
const SNAPSHOT = fs.readFileSync(path.join(import.meta.dirname, "aplus-snapshot.js"), "utf8");

export async function actStamped(page, action, fn) {
  const sel = `[data-jev-node="${action.node}"]`;
  for (const f of page.frames()) {
    const loc = f.locator(sel);
    if (!(await loc.count().catch(() => 0))) continue;
    try { await fn(loc, 1200); return f === page.mainFrame() ? "node" : "node@frame"; }
    catch {}
    if (action.role === "checkbox" || action.role === "radio") { try { return await viaLabel(f, loc, fn); } catch {} }
    break;
  }
  for (const f of page.frames()) { try { return await roleFallback(f, action, fn); } catch {} }
  throw new Error("unresolvable");
}
export default {
  name: "A+", selectFix: true,
  snapshot: (page) => page.evaluate(`(${SNAPSHOT})()`),
  act: actStamped,
};
