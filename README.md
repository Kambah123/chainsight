# Chainsight backend

Real AI investigation reports + investigator chat for Chainsight, powered by
**OpenRouter** free-tier models ($0 per report): `nvidia/nemotron-3-ultra-550b-a55b:free` (fast, ~9s)
with automatic fallbacks to `openai/gpt-oss-20b:free` and `poolside/laguna-s-2.1:free`,
with server-side chain data so **API keys never touch the browser**.

## Quick start (2 minutes)

```bash
# 1) install
npm install

# 2) configure — grab a FREE key at https://openrouter.ai/keys
cp .env.example .env
#    …then paste your key into OPENROUTER_API_KEY in .env

# 3) run
npm start
#    → Chainsight backend  →  http://localhost:8787
```

Open **http://localhost:8787** — the backend serves the frontend from `/public`,
same origin, so live lookups and AI work with zero CORS/CSP setup. The console
auto-detects the backend and flips the report + chat into **real AI mode** (✨ AI badge).

## Endpoints

| Method | Path          | What it does |
|--------|---------------|--------------|
| GET    | `/api/health` | `{ ok, provider, model, aiReady }` — frontend uses this to enable AI mode |
| POST   | `/api/report` | `{ profile }` → AI-written investigation report (strict JSON, grounded in the profile) |
| POST   | `/api/chat`   | `{ profile, question, history }` → investigator answer |
| POST   | `/api/wallet` | `{ chain: eth\|btc\|sol, address }` → normalized live WalletProfile (server-side keys) |

## Models

Default chain: `nvidia/nemotron-3-ultra-550b-a55b:free` → `openai/gpt-oss-20b:free` → `poolside/laguna-s-2.1:free` (set via `AI_MODEL` + `AI_MODEL_FALLBACKS`). Change `AI_MODEL` in `.env`
to any slug from https://openrouter.ai/models. `AI_PROVIDER` can be
`openrouter` · `anthropic` · `openai` · `mock` (keyless smoke tests).

> Free-tier OpenRouter models are rate-limited and don't all support
> `response_format` — Chainsight enforces JSON via the prompt and parses
> defensively, so `:free` models work fine. If a report comes back malformed,
> the frontend keeps its templated fallback, so the demo never breaks.

## Data providers

- **Ethereum**: Etherscan V2 (if `ETHERSCAN_KEY` set — one key, 50+ EVM chains) else Blockscout (keyless)
- **Bitcoin**: Blockstream Esplora (keyless)
- **Solana**: Helius (if `HELIUS_KEY` set) else public RPC (keyless)
- **Prices**: CoinGecko (keyless, cached 60s)

## Grounding & safety

The AI is instructed to reason ONLY from the structured profile it receives —
never to invent addresses, transactions, or figures — and to state plainly when
the data can't answer. Reports distinguish fact from inference. Not financial
or legal advice.

## Deploy

Any Node 18+ host (Railway, Render, Fly.io, a $5 VPS). Set env vars, then point
the published demo's **Connect AI** button at your deployed URL — or just share
the backend URL itself, since it serves the whole app.

---
Built in public in 24h · idea @Ezekieldking94 · build @0xSkamber
Landing UI adapted from next-saas-lp (MIT).
