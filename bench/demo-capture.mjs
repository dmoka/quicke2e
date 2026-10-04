// Capture for the launch video: the same TicketBay task run by (a) quicke2e and (b) Claude Code +
// Playwright MCP, each with a video of the browser and a timeline of what it did and when.
// Same start page, same goal, same DB reset, same SQL pass check as bench/headtohead.mjs.
//   node bench/demo-capture.mjs --arm jev --n 5 --out bench/demo/<id>
//   node bench/demo-capture.mjs --arm claude --model sonnet --n 5 --out bench/demo/<id>
// Every clock starts when the process is spawned. The video's first frame is placed on that clock
// by the video file's creation time, so both panels can be lined up on one start line.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const ARM = arg("arm"), N = Number(arg("n", 5)), MODEL = arg("model", "sonnet");
const ENGINE = arg("engine", "jev");   // jev = hosted; local = the local-engine server (LOCAL_URL)
const BASE = arg("base", "http://localhost:3200");
const OUT = path.resolve(arg("out", "bench/demo/" + new Date().toISOString().slice(0, 10)));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const RESET = path.join(ROOT, "examples/ticketbay/reset.sh");
const SPEC = path.resolve(arg("spec", path.join(ROOT, "examples/ticketbay/flows.mjs")));
const FLOW = arg("flow", "book-with-code");
const DB = process.env.DATABASE_URL || "postgres://ticketbay:local-dev-only@localhost:5432/ticketbay";
const EVENT = "midnight-arcade-neon-tour";
const flow = (await import(SPEC)).FLOWS.find((f) => f.name === FLOW);
const SIZE = { width: 1280, height: 900 };
// --dark: TicketBay's own dark theme (next-themes keeps the choice in localStorage "theme"). Set in both
// browsers before the first page loads; the app, the task and the checks are unchanged.
const DARK = process.argv.includes("--dark");
let SPEC_RUN = SPEC;
if (DARK) {
  SPEC_RUN = path.join(os.tmpdir(), `demo-dark-${process.pid}.mjs`);
  fs.writeFileSync(SPEC_RUN, `import { FLOWS } from ${JSON.stringify(SPEC)};
export default FLOWS.map((f) => ({ ...f, storageState: { cookies: [], origins: [{ origin: ${JSON.stringify(BASE)},
  localStorage: [{ name: "theme", value: "dark" }] }] } }));\n`);
}

const sql = (q) => execFileSync("psql", [DB, "-Atc", q]).toString().trim();
// The pass check both arms share: one new paid order, right email and name, WELCOME10 applied.
const placed = () => Number(sql(`select count(*) from orders where id > 315 and status = 'paid'
  and customer_email = 'fan@example.com' and customer_name = 'Alex Fan' and total_cents = 10939
  and event_id = '${EVENT}'`));

// Each arm's own token accounting, turned into a running cost that ends exactly at the reported
// total: a step's share is weighted by what its tokens cost (cache reads 0.1x, writes 1.25x, output 5x).
function spreadCost(events, total) {
  const w = events.map((e) => e.weight || 0), sum = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  events.forEach((e, i) => { acc += sum ? total * w[i] / sum : 0; e.costSoFar = acc; delete e.weight; });
}

function run(cmd, args, opts, onLine) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", err = "";
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => { if (buf) onLine(buf); resolve({ code, err }); });
  });
}

async function jevArm(dir) {
  const t0 = Date.now();
  const lines = [];
  await run("node", [path.join(ROOT, "bin/quicke2e.mjs"), "run", SPEC_RUN, "--only", FLOW, "--base", BASE,
    "--engine", ENGINE, "--headless", "--json", "--video", dir, "--trace", dir], {}, (l) => lines.push(l));
  const wallMs = Date.now() - t0;
  const rec = JSON.parse(lines.at(-1))[0];
  const video = rec.video.file;
  // quicke2e's own clock starts inside the process; shift its step times onto the spawn clock.
  const shift = fs.statSync(video).birthtimeMs - t0 - rec.video.at;
  const events = rec.steps.map((s) => ({ t: s.at + shift, done: (s.wallAt ?? s.decidedAt) + shift, kind: s.op, label: s.label,
    url: s.url, box: s.box ?? null, tokens: s.tokens || 0, weight: s.tokens || 0, confidence: s.confidence }));
  spreadCost(events, rec.cost);
  return { wallMs, video, videoAt: fs.statSync(video).birthtimeMs - t0, events,
    cost: rec.cost, tokens: events.reduce((a, e) => a + e.tokens, 0), outcome: rec.outcome, shift };
}

// The recorder owns the browser the agent drives. Claude Code stops its MCP server abruptly at exit,
// and a video recorded inside that server loses its last seconds (measured: 12.8 s of a 24 s run).
// So this process launches Chromium with a CDP port, records it, and closes it cleanly afterwards;
// the MCP server connects over CDP. The waiting page keeps painting (an invisible animation), so the
// video's first frame is the moment this page was opened -- a known point on the spawn clock.
async function claudeArm(dir) {
  const { chromium } = await import("playwright");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const ctx = await chromium.launchPersistentContext(path.join(cwd, "profile"), { headless: true, viewport: SIZE,
    recordVideo: { dir, size: SIZE }, args: [`--remote-debugging-port=${port}`] });
  if (DARK) await ctx.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch {} });
  const first = ctx.pages()[0] || await ctx.newPage();
  const mcp = path.join(cwd, "mcp.json");
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: "npx",
    args: ["-y", "@playwright/mcp@0.0.82", "--cdp-endpoint", `http://localhost:${port}`] } } }));
  await first.setContent(`<style>i{position:fixed;left:0;top:0;width:1px;height:1px;background:#fff;
    animation:p .2s infinite alternate}@keyframes p{to{background:#fefefe}}</style><i></i>`);
  const prompt = `Use the browser. Go to ${BASE}${flow.start || "/"}. ${flow.goal} `
    + `Stop when the order confirmation page shows the payment confirmed. Reply DONE or FAILED.`;
  const videoAt = Date.now();
  const t0 = Date.now();
  const events = [], seen = new Set();
  let result = {}, lastUrl = null;
  await run("claude", ["-p", prompt, "--model", MODEL, "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcp, "--strict-mcp-config", "--setting-sources", "project", "--tools", "",
    "--allowedTools", "mcp__playwright", "--no-session-persistence"], { cwd }, (line) => {
    const t = Date.now() - t0;
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.type === "assistant") {
      const m = j.message, u = m.usage || {};
      const first = !seen.has(m.id); seen.add(m.id);
      for (const c of m.content || []) {
        if (c.type !== "tool_use") continue;
        const tool = c.name.replace(/^mcp__playwright__browser_/, "");
        events.push({ t, id: c.id, kind: tool, label: c.input.element || c.input.url || c.input.text || null,
          input: c.input, url: lastUrl, box: null, tokens: 0, weight: 0 });
      }
      // One API message can arrive as several lines; its usage is counted once, on its first line.
      if (first) {
        const tok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        const w = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0);
        const target = events.at(-1) && events.at(-1).t === t ? events.at(-1) : (events.push({ t, kind: "think", label: null, url: lastUrl, box: null, tokens: 0, weight: 0 }), events.at(-1));
        target.tokens += tok; target.weight += w;
      }
    } else if (j.type === "user") {
      for (const c of j.message?.content || []) {
        if (c.type !== "tool_result") continue;
        const text = [].concat(c.content).map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n");
        const m = text.match(/Page URL: (\S+)/);
        if (m) lastUrl = m[1];
        const e = events.find((x) => x.id === c.tool_use_id);
        const code = text.match(/```js\n([\s\S]*?)```/);
        if (e) { e.done = t; if (m) e.urlAfter = m[1]; if (code) e.code = code[1].trim(); }
      }
    } else if (j.type === "result") result = { ...j, t };
  });
  const wallMs = Date.now() - t0;
  const pages = ctx.pages().map((p) => ({ url: p.url(), video: p.video() }));
  await ctx.close();
  const videos = await Promise.all(pages.map(async (p) => ({ url: p.url, file: await p.video.path() })));
  const video = videos[0]?.file || null;
  spreadCost(events, result.total_cost_usd || 0);
  return { wallMs, video, videos, videoAt: videoAt - t0, events,
    cost: result.total_cost_usd ?? null, tokens: events.reduce((a, e) => a + e.tokens, 0),
    turns: result.num_turns, outcome: String(result.result ?? "").slice(-40) };
}

fs.mkdirSync(OUT, { recursive: true });
const all = [];
for (let k = 1; k <= N; k++) {
  execFileSync("bash", [RESET], { stdio: "ignore" });
  const dir = path.join(OUT, `${ARM}-${ARM === "claude" ? MODEL : ENGINE}-${k}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = await (ARM === "claude" ? claudeArm(dir) : jevArm(dir));
  const rec = { arm: ARM, model: ARM === "claude" ? MODEL : ENGINE, run: k, flow: FLOW, pass: placed() === 1, size: SIZE, ...r };
  fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(rec, null, 2));
  all.push(rec);
  console.log(JSON.stringify({ run: k, pass: rec.pass, wallMs: rec.wallMs, cost: rec.cost, tokens: rec.tokens,
    steps: rec.events.length, videoAt: Math.round(rec.videoAt ?? -1), video: !!rec.video }));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log("SUMMARY " + JSON.stringify({ arm: ARM, model: all[0].model, n: N, pass: all.filter((r) => r.pass).length,
  medianWallMs: med(all.map((r) => r.wallMs)), medianCost: med(all.map((r) => r.cost ?? 0)), medianTokens: med(all.map((r) => r.tokens)) }));
