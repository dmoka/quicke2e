// Model-free tests of --map routing in runOnce. A stub engine stands in for the decision model: it
// answers on the local engine's wire, so the routing code runs unchanged. Own file, because the loop
// reads LOCAL_URL when it is first imported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startStatic } from "../fixtures/serve.mjs";

// The stub makes the choices measured on TicketBay (run-4): the page is /orders/:id, the item is the
// first link (TB-00301), and on an order page it clicks "Cancel order".
const engine = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const crit = JSON.parse(b).questions.action.criteria;
    const keys = Object.keys(crit);
    const choice = keys.find((k) => k.startsWith("PAGE:") && crit[k].startsWith("/orders/:id"))
      ?? keys.find((k) => k === "URL:0") ?? keys.find((k) => /Cancel order/.test(crit[k])) ?? keys[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answers: { action: { choice, confidence: 0.9 } },
      timing: { infer_ms: 0, queued_ms: 0, truncated: false }, usage: { input_tokens: 0 } }));
  });
});

let srv, base, browser, map, runOnce;
before(async () => {
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));
  process.env.LOCAL_URL = `http://127.0.0.1:${engine.address().port}`;
  const loop = await import("../src/loop.mjs");
  const { discover } = await import("../src/discover.mjs");
  runOnce = loop.runOnce;
  srv = await startStatic(0);
  base = `http://127.0.0.1:${srv.server.address().port}`;
  browser = await loop.chromium.launch({ headless: true });
  map = await discover({ base, start: ["/orders"], mode: "safe", browser });
});
after(async () => { await browser.close(); await srv.close(); await new Promise((r) => engine.close(r)); });

test("map: a concrete start page is never swapped for another instance of its pattern", async () => {
  const ids = map.pages.find((p) => p.pattern === "/orders/:id")?.urls.map((u) => new URL(u).pathname);
  assert.deepEqual(ids?.sort(), ["/orders/281", "/orders/301"], "the map holds both orders");
  srv.reset();
  const rec = await runOnce({ engine: "local", browser, base, map, flow: { name: "m", start: "/orders/281",
    goal: "Cancel the order.", expect: ["Order TB-00281"], maxSteps: 2 } });
  assert.equal(new URL(rec.finalUrl).pathname, "/orders/281");
  assert.deepEqual(rec.route.hops, []);
  assert.ok(!srv.truth().some((t) => t.truth === "cancel-301"), "the run clicked Cancel on order 301");
  assert.equal(rec.passed, true);
});

test("map: a start page of another pattern still routes to the item", async () => {
  const rec = await runOnce({ engine: "local", browser, base, map, flow: { name: "m", start: "/orders",
    goal: "Open order TB-00301.", expect: ["Order TB-00301"], maxSteps: 2 } });
  assert.equal(new URL(rec.finalUrl).pathname, "/orders/301");
  assert.deepEqual(rec.route.hops.map((h) => h.label), ["TB-00301"]);
  assert.equal(rec.passed, true);
});
