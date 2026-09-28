"""Local decision engine for jevtester (`--engine local`). Apple Silicon.

  POST /  {state, questions:{action:{criteria, instructions:{goal, rules}}}}
       -> {answers:{action:{choice, confidence, probabilities}}, timing, usage}

It never generates text. The page state, the goal and the offered options go into one structured
prompt; the model reads the next-token logits of the option LABELS only, and a softmax over those is
the answer. It cannot return an option that was not offered.

Two open decision models, both trained on this exact prompt shape:

  eikos-4b    (default) caiovicentino1/Eikos-4B-MLX-4bit, MIT, ~4.6 GB, MLX.
              Labels A-Z then AA, AB, ... -- up to 100 options in one pass.
  shisa-de-1  (fast)    Shisa DE-1, Gemma 4 26B-A4B MoE (3.8B active), Apache-2.0, ~15 GB+,
              run through llama.cpp (`brew install llama.cpp`); this server starts llama-server
              itself and downloads the public GGUF on first run. Labels A-Z; more options are
              decided in groups of 26, then a final between the group winners.

The prompt format (a system instruction plus a JSON user message of evidence, criterion and
lettered options) follows SemIf by TheoLeeCJ (github.com/TheoLeeCJ/SemIf, MIT), which both models
were trained on.

  python server.py                      # eikos-4b on :8822
  python server.py --model shisa-de-1   # needs llama-server on PATH
"""
import argparse, json, math, resource, shutil, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PROFILES = {
    "eikos-4b": {"backend": "mlx", "repo": "caiovicentino1/Eikos-4B-MLX-4bit", "labels": 100},
    "shisa-de-1": {"backend": "llamacpp", "hf_repo": "mradermacher/shisa-de-1-GGUF",
                   "hf_file": "shisa-de-1.Q4_K_M.gguf", "labels": 26, "ctx": 8192,
                   "suffix": "<|channel>thought\n<channel|>"},
}
SYSTEM = ("Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. "
          "Respond with only its uppercase letter, with no explanation or reasoning.")
META = {"WAIT": "wait for the page", "BLOCKED": "nothing can progress",
        "NONE": "none of these options advances the goal"}
_U = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
LABELS = list(_U) + [a + b for a in _U for b in _U]


# ---------------------------------------------------------------- the prompt (model-independent)

def evidence(state):
    """The page state, compact: each element as one short string ("4 textbox Email = Acme")."""
    ev = {k: v for k, v in (state or {}).items() if k in ("url", "title", "values", "done", "elements")}
    if isinstance(ev.get("elements"), list):
        ev["elements"] = [" ".join(filter(None, [str(e.get("i", "")), e.get("r", ""), e.get("l", "")]))
                          + (f" = {e['v']}" if e.get("v") else "") + (" (popup)" if e.get("p") else "")
                          for e in ev["elements"]]
    return ev


def option_texts(criteria):
    return [(k, f"{k}: {criteria.get(k) or META.get(k, k)}") for k in criteria]


def messages(ev, criterion, texts, labels):
    payload = {"evidence": ev, "criterion": criterion,
               "options": [{"letter": labels[i], "description": d} for i, d in enumerate(texts)]}
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


def distribution(read, texts, cap):
    """Probabilities over `texts` from `read(batch)` (one pass, at most `cap` options). Longer lists
    are split into near-equal groups; the top options of every group go to a final, whose
    distribution is the answer (options that did not reach the final get 0)."""
    if len(texts) <= cap:
        return read(texts)
    n = -(-len(texts) // cap)
    size, extra = divmod(len(texts), n)
    groups, start = [], 0
    for g in range(n):
        stop = start + size + (g < extra)
        groups.append(list(range(start, stop)))
        start = stop
    keep = max(1, cap // n)
    finalists, rest = [], []
    for idx in groups:
        p = read([texts[i] for i in idx])
        order = sorted(range(len(idx)), key=lambda j: -p[j])
        finalists += [idx[j] for j in order[:keep]]
        rest += [(p[j], idx[j]) for j in order[keep:]]
    # free places in the final go to the next most likely options of any group
    finalists += [i for _, i in sorted(rest, key=lambda r: -r[0])[:max(0, cap - len(finalists))]]
    finalists.sort()
    final = distribution(read, [texts[i] for i in finalists], cap)
    out = [0.0] * len(texts)
    for i, q in zip(finalists, final):
        out[i] = q
    return out


def softmax(xs):
    m = max(xs)
    e = [math.exp(x - m) for x in xs]
    t = sum(e)
    return [x / t for x in e]


# ---------------------------------------------------------------- backends

class MLXBackend:
    def __init__(self, repo):
        import mlx.core as mx
        from mlx_lm import load
        self.mx = mx
        self.model, self.tok = load(repo)
        self.ids = {}

    def label_id(self, label):
        if label not in self.ids:
            self.ids[label] = self.tok.encode(label, add_special_tokens=False)[-1]
        return self.ids[label]

    def read(self, msgs, labels):
        prompt = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True,
                                              enable_thinking=False)
        ids = self.tok.encode(prompt, add_special_tokens=False)
        logits = self.model(self.mx.array([ids]))[0, -1]
        self.mx.eval(logits)
        return [float(logits[self.label_id(l)]) for l in labels], len(ids)

    def peak_mb(self):
        return round(self.mx.get_peak_memory() / 1e6, 1)


class LlamaCppBackend:
    def __init__(self, prof, port):
        exe = shutil.which("llama-server")
        if not exe:
            raise SystemExit("shisa-de-1 needs llama.cpp: brew install llama.cpp")
        self.base, self.suffix = f"http://127.0.0.1:{port}", prof["suffix"]
        self.proc = subprocess.Popen([exe, "--hf-repo", prof["hf_repo"], "--hf-file", prof["hf_file"],
                                      "-c", str(prof["ctx"]), "-ngl", "99", "--port", str(port)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(1800):   # the first run downloads ~15 GB
            try:
                if json.loads(urllib.request.urlopen(self.base + "/health", timeout=2).read()).get("status") == "ok":
                    return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise SystemExit("llama-server exited while starting")
            time.sleep(2)
        raise SystemExit("llama-server did not become ready")

    def _post(self, path, body):
        req = urllib.request.Request(self.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=600).read())

    def read(self, msgs, labels):
        prompt = self._post("/apply-template", {"messages": msgs})["prompt"]
        if self.suffix and not prompt.endswith(self.suffix):
            prompt += self.suffix
        out = self._post("/completion", {"prompt": prompt, "n_predict": 1, "n_probs": 64,
                                         "temperature": 0, "cache_prompt": True})
        first = (out.get("completion_probabilities") or [{}])[0]
        seen = {}
        for e in first.get("top_logprobs") or first.get("probs") or []:
            t = (e.get("token") or e.get("tok_str") or "").strip()
            if t and t not in seen:
                seen[t] = e.get("logprob", math.log(max(e.get("prob", 1e-12), 1e-12)))
        floor = min(seen.values(), default=0.0) - 5
        return [seen.get(l, floor) for l in labels], out.get("tokens_evaluated", 0)

    def peak_mb(self):
        return None


# ---------------------------------------------------------------- server

PROFILE, BACKEND, SERVED = None, None, 0


def decide(payload):
    q = payload["questions"]["action"]
    criteria = q["criteria"]
    instr = q.get("instructions") or {}
    state = payload.get("state") or {}
    if isinstance(state, str):
        state = json.loads(state)
    pairs = option_texts(criteria)
    ev = evidence(state)
    criterion = "\n".join(filter(None, [instr.get("goal", ""), instr.get("rules", "")]))
    tokens = [0]

    def read(batch):
        labels = LABELS[:len(batch)]
        logits, n = BACKEND.read(messages(ev, criterion, batch, labels), labels)
        tokens[0] += n
        return softmax(logits)

    t0 = time.perf_counter()
    probs = distribution(read, [t for _, t in pairs], PROFILE["labels"])
    ms = (time.perf_counter() - t0) * 1000
    dist = {k: p for (k, _), p in zip(pairs, probs)}
    choice = max(dist, key=dist.get)
    return {"answers": {"action": {"choice": choice, "confidence": round(dist[choice], 4),
                                   "probabilities": {k: round(v, 4) for k, v in dist.items()}}},
            "timing": {"infer_ms": round(ms, 1), "queued_ms": 0, "truncated": False},
            "usage": {"input_tokens": tokens[0], "output_tokens": 0, "cost": 0}}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        global SERVED
        n = int(self.headers.get("Content-Length", 0))
        try:
            out = decide(json.loads(self.rfile.read(n)))
            SERVED += 1
        except Exception as e:
            out = {"error": f"{type(e).__name__}: {e}"}
        self._send(out)

    def do_GET(self):
        self._send({"ok": True, "model": PROFILE["name"], "decisions_served": SERVED,
                    "mlx_peak_mb": BACKEND.peak_mb(),
                    "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1)})

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="jevtester local decision engine")
    ap.add_argument("--model", choices=sorted(PROFILES), default="eikos-4b")
    ap.add_argument("--port", type=int, default=8822)
    ap.add_argument("--llama-port", type=int, default=8823, help="internal port for llama-server (shisa-de-1)")
    args = ap.parse_args()
    PROFILE = {**PROFILES[args.model], "name": args.model}
    BACKEND = MLXBackend(PROFILE["repo"]) if PROFILE["backend"] == "mlx" else LlamaCppBackend(PROFILE, args.llama_port)
    # Stop llama-server with us on SIGTERM/SIGINT too (Python skips `finally` on a plain SIGTERM,
    # which left an orphaned llama-server holding ~15 GB).
    import signal, sys
    def stop(*_):
        if isinstance(BACKEND, LlamaCppBackend):
            BACKEND.proc.terminate()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    decide({"state": {"url": "/", "title": "warmup"}, "questions": {"action": {
        "criteria": {"CLICK:1": "CLICK 1 Sign in [button]", "WAIT": "wait for the page"},
        "instructions": {"goal": "Sign in", "rules": ""}}}})
    print(f"local engine ready: {args.model} on :{args.port}", flush=True)
    # Single-threaded on purpose: one model on one GPU, one decision at a time.
    try:
        HTTPServer(("127.0.0.1", args.port), H).serve_forever()
    finally:
        if isinstance(BACKEND, LlamaCppBackend):
            BACKEND.proc.terminate()
