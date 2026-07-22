/* ============================================================
   Chainsight backend — Express
   Serves the frontend (same-origin => no CORS/CSP friction) and
   exposes the AI + chain-data API. Keys live in .env only.
   ============================================================ */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReport, answerChat, aiInfo } from './api/_lib/ai.js';
import { getWallet } from './api/_lib/chains.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const ok = (res, body) => res.json(body);
const fail = (res, e, code = 500) => { console.error(e); res.status(code).json({ error: String(e.message || e) }); };

// health — the frontend pings this to switch into real-AI mode
app.get('/api/health', (_req, res) => {
  const ai = aiInfo();
  ok(res, { ok: true, service: 'chainsight', provider: ai.provider, model: ai.model, aiReady: ai.keyPresent });
});

// AI investigation report from a wallet profile
app.post('/api/report', async (req, res) => {
  try {
    const { profile } = req.body || {};
    if (!profile) return fail(res, new Error('profile required'), 400);
    ok(res, await generateReport(profile));
  } catch (e) { fail(res, e); }
});

// conversational investigator
app.post('/api/chat', async (req, res) => {
  try {
    const { profile, question, history } = req.body || {};
    if (!profile || !question) return fail(res, new Error('profile and question required'), 400);
    ok(res, { answer: await answerChat(profile, question, history) });
  } catch (e) { fail(res, e); }
});

// server-side chain fetch (keys stay here). Returns a normalized WalletProfile.
app.post('/api/wallet', async (req, res) => {
  try {
    const { chain, address } = req.body || {};
    if (!chain || !address) return fail(res, new Error('chain and address required'), 400);
    ok(res, await getWallet(chain, address));
  } catch (e) { fail(res, e); }
});

// serve the single-file frontend (same origin as the API — no CORS/CSP friction)
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  const ai = aiInfo();
  console.log(`\n  Chainsight backend  →  http://localhost:${PORT}`);
  console.log(`  AI provider: ${ai.provider} · model: ${ai.model} · key ${ai.keyPresent ? 'present ✓' : 'MISSING ✗ (set it in .env)'}`);
  console.log(`  Endpoints: GET /api/health · POST /api/report · POST /api/chat · POST /api/wallet\n`);
});
