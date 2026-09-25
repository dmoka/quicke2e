// Records what the loop OFFERED the decision model, without touching the checkout.
// loop.mjs reads LOCAL_URL from the environment, so pointing it here captures the full
// criteria set per step. That is the only way to assert "this option was never offered"
// (link starvation, a stripped escape hatch, a decoy that must not appear) from outside.
import http from "node:http";

export function startProxy({ upstream = "http://127.0.0.1:8822", port = 8823 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", async () => {
      let sent = null;
      try { sent = JSON.parse(b); } catch {}
      try {
        // One retry: the local MLX server is shared with other agents and rejects under
        // load. Without this, a neighbour's traffic turns into a fake fixture failure.
        let up, txt;
        for (let a = 0; a < 3; a++) {
          try {
            up = await fetch(upstream, { method: "POST",
              headers: { "Content-Type": "application/json" }, body: b });
            txt = await up.text();
            if (up.ok) break;
          } catch (err) { if (a === 2) throw err; }
          await new Promise((r) => setTimeout(r, 400 * (a + 1)));
        }
        let ans = null; try { ans = JSON.parse(txt); } catch {}
        calls.push({
          raw: b,
          url: sent?.state?.url ?? null,
          elements: sent?.state?.elements ?? [],
          criteria: Object.keys(sent?.questions?.action?.criteria || {}),
          criteriaText: sent?.questions?.action?.criteria || {},
          choice: ans?.answers?.action?.choice ?? null,
          confidence: ans?.answers?.action?.confidence ?? null,
          // server.py:127 silently cuts the option list to 52 (one per letter) and only
          // reports it here. Raising `budget` past 52 therefore changes nothing, and the
          // keys cut are the LAST ones — which is where WAIT/DONE/BLOCKED live.
          truncated: ans?.timing?.truncated ?? null,
          seen: ans?.answers?.action?.probabilities ? Object.keys(ans.answers.action.probabilities).length : null,
        });
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(txt);
      } catch (e) {
        // Keep the shape uniform: a failed upstream call is still a step, and graders
        // index into criteria/elements unconditionally.
        calls.push({ error: String(e.message || e), url: sent?.state?.url ?? null,
          elements: [], criteria: [], criteriaText: {}, choice: null, confidence: null });
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({
    port, url: `http://127.0.0.1:${port}`,
    reset: () => { calls.length = 0; },
    calls: () => calls.slice(),
    close: () => new Promise((d) => server.close(d)),
  })));
}
