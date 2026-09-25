// A through the bench harness: src/snapshot.js evaluated as-is, src/loop.mjs act() as-is.
// Used for snapshot timing and to show the harness copy behaves like runOnce (A-h vs A).
import fs from "node:fs";
import path from "node:path";
import { actA } from "../lib/core.mjs";
const SNAPSHOT = fs.readFileSync(path.join(import.meta.dirname, "../../src/snapshot.js"), "utf8");
export default {
  name: "A-h", selectFix: false,
  snapshot: (page) => page.evaluate(`(${SNAPSHOT})()`),
  act: actA,
};
