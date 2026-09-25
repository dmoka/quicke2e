// Head-to-head on TicketBay's plain checkout: (a) Claude Code + Playwright MCP, (b) jevtester.
// Same start page, same goal text, same DB reset before every run, same SQL pass check.
//   node bench/headtohead.mjs --arm claude --model sonnet --n 5
//   node bench/headtohead.mjs --arm jev --n 5
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const ARM = arg("arm"), N = Number(arg("n", 5)), MODEL = arg("model", "sonnet");
const BASE = arg("base", "http://localhost:3200");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const RESET = arg("reset", path.join(ROOT, "examples/ticketbay/reset.sh"));
const SPEC = arg("spec", path.join(ROOT, "examples/ticketbay/flows.mjs"));
const DB = process.env.DATABASE_URL || "postgres://ticketbay:local-dev-only@localhost:5432/ticketbay";
const EVENT = "midnight-arcade-neon-tour";
const GOAL = "Book tickets for this event: continue to checkout, enter the email fan@example.com "
  + "and the name Alex Fan, and pay.";

// The ONE pass check both arms share: a new paid order with the right email, name and total.
const sql = (q) => execFileSync("psql", [DB, "-Atc", q]).toString().trim();
const placed = () => Number(sql(`select count(*) from orders where id > 315 and status = 'paid'
  and customer_email = 'fan@example.com' and customer_name = 'Alex Fan' and total_cents = 12154
  and event_id = '${EVENT}'`));

const out = [];
for (let k = 0; k < N; k++) {
  execFileSync("bash", [RESET], { stdio: "ignore" });
  const t0 = performance.now();
  let rec = {};
  if (ARM === "claude") {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "h2h-"));
    const prompt = `Use the browser. Go to ${BASE}/events/${EVENT}. ${GOAL} `
      + `Stop when the order confirmation page shows the payment confirmed. Reply DONE or FAILED.`;
    const r = spawnSync("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json",
      "--mcp-config", path.join(HERE, "pw-mcp.json"), "--strict-mcp-config",
      "--setting-sources", "project", "--tools", "", "--allowedTools", "mcp__playwright",
      "--no-session-persistence"], { cwd, encoding: "utf8", timeout: 600000 });
    let j = {}; try { j = JSON.parse(r.stdout); } catch { j = { parseError: (r.stdout || r.stderr || "").slice(0, 300) }; }
    rec = { cost: j.total_cost_usd ?? null, turns: j.num_turns ?? null, apiMs: j.duration_api_ms ?? null,
      said: String(j.result ?? "").slice(-60), error: j.parseError || (j.is_error ? j.subtype : null) };
  } else {
    const r = spawnSync("node", [path.join(ROOT, "bin/jevtester.mjs"), "run", SPEC, "--only", "checkout-plain",
      "--base", BASE, "--engine", arg("engine", "jev"), "--json"], { encoding: "utf8", timeout: 600000 });
    const last = (r.stdout || "").trim().split("\n").pop();
    let j = []; try { j = JSON.parse(last); } catch {}
    const x = j[0] || {};
    rec = { cost: x.cost ?? null, steps: x.steps?.length ?? null, verdict: x.outcome ?? r.stderr?.slice(0, 200) };
  }
  const wallMs = Math.round(performance.now() - t0);
  const pass = placed() === 1;
  out.push({ arm: ARM, model: ARM === "claude" ? MODEL : arg("engine", "jev"), run: k + 1, pass, wallMs, ...rec });
  console.log(JSON.stringify(out.at(-1)));
}
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const sum = { arm: ARM, model: out[0]?.model, n: N, pass: out.filter((r) => r.pass).length,
  medianWallMs: med(out.map((r) => r.wallMs)), totalCost: out.reduce((a, r) => a + (r.cost || 0), 0) };
console.log("SUMMARY " + JSON.stringify(sum));
fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
fs.writeFileSync(path.join(HERE, "results", `h2h-${ARM}-${sum.model}-${Date.now()}.json`), JSON.stringify({ sum, out }, null, 2));
