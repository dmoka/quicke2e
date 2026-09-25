"""Local decision engine for agent-browser-test. Same wire shape as the Jev /
Laya engines in src/loop.mjs, so `engine: "local"` is a drop-in swap.

  POST /  {state, questions:{action:{criteria, instructions:{goal, rules}}}}
       -> {answers:{action:{choice, confidence, probabilities}}, timing, usage}

It never generates text. The option ids are mapped to single letters, one prefill
runs, and we read the logits of exactly those letter tokens. The model therefore
cannot return anything that was not offered, and the confidence is a real softmax
over the offered set rather than a self-report.
"""
import argparse, json, math, os, time, resource
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx.core as mx
from mlx_lm import load as mlx_load

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
DEFAULT_RULES = ("Choose the one operation that advances the goal from this page. "
                 "Do not repeat a step that is already satisfied. "
                 "Fill required fields before submitting.")

MODEL = None
TOK = None
LETTER_ID = {}
SERVED = 0


def letter_id(ch):
    if ch not in LETTER_ID:
        LETTER_ID[ch] = TOK.encode(ch, add_special_tokens=False)[-1]
    return LETTER_ID[ch]


RENDER = "terse"


def option_text(key, desc):
    """One criterion rendered for the prompt. loop.mjs sends '<OP> <n> <label>'.

    Prefill runs at ~700 tok/s here, so prompt length is latency. Measured on the
    13-case discriminator (local-engine/latency.py): terse and verbose both score
    13/13, terse is ~20% shorter and ~20% faster. Keeping the goal-specific DONE
    description scored *worse* (12/13) as well as slower — the loop's own
    deterministic DONE check is what decides completion anyway, so the model does
    not need to be told what success looks like."""
    op = key.split(":")[0]
    parts = desc.split(" ", 2)
    label = parts[2] if len(parts) > 2 else desc
    if RENDER == "terse":
        return {"WAIT": "wait for the page",
                "BLOCKED": "nothing can progress",
                "DONE": "the goal is already complete",
                "CLICK": f"click {label}",
                "TYPE_TEXT": f"type into {label}",
                "SELECT": f"select {label}"}.get(op, desc)
    if key == "WAIT":
        return "Wait for the page to finish loading."
    if key == "BLOCKED":
        return "Nothing on this page can make progress towards the goal."
    if key == "DONE":
        return f"The goal is already complete. {desc}"
    if op == "CLICK":
        return f"Click the {label} link or button."
    if op == "TYPE_TEXT":
        return f"Type the required text into the {label} field."
    if op == "SELECT":
        return f"Select an option from {label}."
    return desc


def build_prompt(state, goal, rules, keys, criteria):
    opts = "\n".join(f"{LETTERS[i]}. {option_text(k, criteria[k])}"
                     for i, k in enumerate(keys))
    done = state.get("done") or []
    els = state.get("elements") or []
    body = (
        "You drive a browser to reach a goal. " + rules + " Answer with a single letter.\n\n"
        f"GOAL: {goal}\n"
        f"PAGE: {state.get('url', '')} — {state.get('title', '')}\n"
        + (f"ALREADY DONE: {'; '.join(map(str, done))}\n" if done else "")
        + (f"CONTROLS ON PAGE: {len(els)}\n" if els else "")
        + f"\nOPTIONS:\n{opts}\n\nAnswer with one letter only."
    )
    msgs = [{"role": "user", "content": body}]
    try:
        return TOK.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True,
                                       enable_thinking=False)
    except TypeError:
        return TOK.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)


FLAN = None  # (torch, tokenizer, model, letter_ids) when --backend flan


def decide_flan(state, goal, rules, keys, criteria):
    """MindAct / WebLINX formulation: lettered multiple choice, reading the first
    decoder step's logits restricted to the letter tokens. 7x faster than the 4B
    decoder here, and multiple choice is in-distribution for Flan-T5."""
    torch, tok, model, lids = FLAN
    keys = keys[:26]
    done = state.get("done") or []
    opts = "\n".join(f"{LETTERS[i]}. {option_text(k, criteria[k])}"
                     for i, k in enumerate(keys))
    prompt = (f"{rules}\n\nGoal: {goal}\n"
              f"Page: {state.get('url', '')} ({state.get('title', '')})\n"
              + (f"Already done: {'; '.join(map(str, done))}\n" if done else "")
              + f"\nWhich action advances the goal?\n{opts}\n\nAnswer:")
    enc = tok(prompt, return_tensors="pt", truncation=True, max_length=1024).to("mps")
    dec = torch.tensor([[model.config.decoder_start_token_id]]).to("mps")
    with torch.no_grad():
        lg = model(**enc, decoder_input_ids=dec).logits[0, 0]
    return keys, [float(lg[lids[i]]) for i in range(len(keys))], int(enc["input_ids"].shape[1])


def decide(payload):
    q = payload["questions"]["action"]
    criteria = q["criteria"]
    instr = q.get("instructions") or {}
    goal = instr.get("goal", "")
    rules = instr.get("rules", DEFAULT_RULES)
    state = payload.get("state") or {}
    if isinstance(state, str):
        state = json.loads(state)

    keys = list(criteria)
    truncated = len(keys) > len(LETTERS)
    keys = keys[:len(LETTERS)]

    if FLAN is not None:
        t0 = time.perf_counter()
        keys, raw, n_in = decide_flan(state, goal, rules, keys, criteria)
        infer_ms = (time.perf_counter() - t0) * 1000
        ids = range(n_in)
    else:
        text = build_prompt(state, goal, rules, keys, criteria)
        ids = TOK.encode(text)
        t0 = time.perf_counter()
        logits = MODEL(mx.array([ids]))[0, -1]
        mx.eval(logits)
        infer_ms = (time.perf_counter() - t0) * 1000
        raw = [float(logits[letter_id(LETTERS[i])]) for i in range(len(keys))]

    top = max(range(len(raw)), key=lambda i: raw[i])
    m = max(raw)
    exp = [math.exp(v - m) for v in raw]
    s = sum(exp)
    probs = [v / s for v in exp]
    return {
        "answers": {"action": {
            "choice": keys[top],
            "confidence": round(probs[top], 4),
            "probabilities": {keys[i]: round(probs[i], 4) for i in range(len(keys))},
        }},
        "timing": {"infer_ms": round(infer_ms, 1), "queued_ms": 0, "truncated": truncated},
        "usage": {"input_tokens": len(ids), "output_tokens": 0, "cost": 0},
    }


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        global SERVED
        n = int(self.headers.get("Content-Length", 0))
        try:
            out = decide(json.loads(self.rfile.read(n)))
            SERVED += 1
        except Exception as e:
            out = {"error": f"{type(e).__name__}: {e}"}
        b = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        # ru_maxrss is bytes on macOS. MLX allocates in the unified pool, so
        # report its own peak too — that is the number that matters for "will
        # this fit alongside the app under test".
        b = json.dumps({
            "ok": True, "model": os.environ.get("LOCAL_MODEL", ""),
            "render": RENDER,
            "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1),
            "backend": "flan" if FLAN is not None else "mlx",
            "mlx_peak_mb": round(mx.get_peak_memory() / 1e6, 1),
            "mlx_active_mb": round(mx.get_active_memory() / 1e6, 1),
            "decisions_served": SERVED,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mlx-community/Qwen3.5-9B-MLX-4bit")   # light option: mlx-community/Qwen3-4B-Instruct-2507-4bit
    ap.add_argument("--port", type=int, default=8822)
    ap.add_argument("--render", choices=("terse", "verbose"), default="terse")
    ap.add_argument("--backend", choices=("mlx", "flan"), default="mlx")
    a = ap.parse_args()
    RENDER = a.render
    os.environ["LOCAL_MODEL"] = a.model
    if a.backend == "flan":
        import torch
        from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
        _tok = AutoTokenizer.from_pretrained(a.model)
        _m = AutoModelForSeq2SeqLM.from_pretrained(a.model).to("mps").eval()
        FLAN = (torch, _tok, _m,
                [_tok.encode(c, add_special_tokens=False)[0] for c in LETTERS[:26]])
    else:
        MODEL, TOK = mlx_load(a.model)
    # One warm-up prefill so the first real decision is not paying compile cost.
    decide({"state": {"url": "/", "title": "warmup", "elements": [], "done": []},
            "questions": {"action": {"criteria": {"CLICK:1": "CLICK 1 Warm", "DONE": "done"},
                                     "instructions": {"goal": "warm up"}}}})
    print(f"local engine ready: {a.model} on :{a.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
