# local-engine — free, offline decision engines (Apple Silicon)

`--engine local` for jevtester. It runs an open **decision model**: a model trained to pick one of a
list of options for a goal. It never generates text. The page state, the goal and the offered options
go into one structured prompt, and the model reads the next-token logits of the option labels only. It
cannot return an option that was not offered, and `confidence` is a softmax over the offered set.

## Run it

```bash
cd local-engine
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install -r requirements.txt
.venv/bin/python server.py                      # Eikos-4B (default), :8822
.venv/bin/python server.py --model shisa-de-1   # Shisa DE-1, the fast one (needs: brew install llama.cpp)
```

Then `jevtester run ... --engine local` (set `LOCAL_URL` if you use another port). The first start
downloads the model. `GET /` reports the model, peak memory and decisions served.

## Which model

| | **Eikos-4B** (default) | **Shisa DE-1** (fast) | Jev (hosted) |
|---|---|---|---|
| what it is | Qwen3.5-4B fine-tuned for decisions | Gemma 4 26B MoE, 3.8B active per token | TypeSafe's hosted model |
| memory (peak) | **4.1 GB** | 17.4 GB | none locally |
| TicketBay (4 specs × 5) | 20/20 | 20/20 | 20/20 |
| book with a discount code | 7.5 s | **3.5 s** | 4.4 s |
| plain checkout, end to end | 4.4 s | **2.0 s** | 3.05 s |
| fixture suite (59 pages, n=3) | **58/59** | 56/59 | 59/59 |
| runtime | MLX | llama.cpp (Metal) | OpenRouter |
| cost | $0 | $0 | ~$0.0002 per flow |

Measured 2026-09-28 on an M2 Max (64 GB). Eikos-4B fits any Apple Silicon Mac with 8 GB or more. Shisa
DE-1 needs 32 GB, and is then faster than the hosted engine, because only 3.8B of its 25B parameters
work on each token and there is no network round trip.

These two were chosen after comparing more than a dozen open models on 142 recorded decisions and on
full runs.

## How it works

Both models were trained on the same prompt shape: a short system instruction, then one JSON message
with `evidence` (the page: URL, title, form values, recent steps, the elements), `criterion` (the goal)
and `options` (each with a label). Eikos-4B reads up to 100 options in one pass (labels A–Z, then AA,
AB, …). Shisa DE-1 reads up to 26; a longer list is decided in groups, and the best options of every
group go to a final.

The prompt format follows SemIf by TheoLeeCJ ([github.com/TheoLeeCJ/SemIf](https://github.com/TheoLeeCJ/SemIf), MIT).

## Licences

The server is MIT (this repo). The models are downloaded on first run, not shipped here:
[Eikos-4B](https://huggingface.co/caiovicentino1/Eikos-4B) is MIT (base Qwen3.5-4B, Apache-2.0);
[Shisa DE-1](https://huggingface.co/shisa-ai/shisa-de-1) is Apache-2.0 (base Gemma 4), run from the
[GGUF build](https://huggingface.co/mradermacher/shisa-de-1-GGUF).
