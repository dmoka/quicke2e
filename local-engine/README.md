# local-engine — a free, offline decision engine (Apple Silicon)

`--engine local` for jevtester. A small instruct model on MLX, used as a **constrained chooser**: it
never generates text. Each offered option id is mapped to one letter, one prefill runs, and only those
letters' logits are read. It cannot return an action that was not offered, and `confidence` is a
softmax over the offered set, not a self-report.

It IS a small LLM. "No LLM in the run loop" holds only for the default `jev` engine.

## Run it

```bash
cd local-engine
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt
.venv/bin/python server.py                    # Qwen3.5-9B (default), :8822
.venv/bin/python server.py --model mlx-community/Qwen3-4B-Instruct-2507-4bit   # light option
```

Then `jevtester run ... --engine local` (set `LOCAL_URL` if you use another port). `GET /` reports the
model, peak memory and decisions served.

## Which model

| | Qwen3.5-9B (default) | Qwen3-4B (light) | Jev (hosted) |
|---|---|---|---|
| memory (MLX peak) | about 6 GB | about 3 GB | none locally |
| time per decision (M2 Max) | about 0.7 s | about 0.3 s | about 0.3 s |
| TicketBay (4 specs × 5) | **20/20** | 15/20 | 20/20 |
| book with a discount code | 5/5 | 0/5 (pays before applying the code) | 5/5 |
| fixture suite (n=3) | 57/59 | 57/59 | 59/59 |
| plain checkout, end to end | 4.2 s | 3.1 s | 3.1 s |
| cost | $0 | $0 | ~$0.0002 per flow |

Measured 2026-09-24/25 on an M2 Max. Both local models were chosen after comparing more than a dozen local and
open "Jev-like" decision models on 142 recorded decisions and on full runs; the two above were the
most reliable end to end for their memory size.

## Licences

The server is MIT (this repo). Qwen3.5-9B and Qwen3-4B-Instruct-2507 are Apache-2.0; they are
downloaded from Hugging Face on first run, not shipped here.
