/* ============================================================
   Chainsight — AI layer (provider-agnostic, resilient)
   Turns a normalized on-chain WalletProfile into an analyst
   report and answers chat questions, grounded strictly in the
   data it is given. Retries + a model-fallback chain make
   flaky free-tier providers usable; if every attempt fails the
   frontend keeps its templated output, so the UX never breaks.
   ============================================================ */

const PROVIDER = () => (process.env.AI_PROVIDER
  || (process.env.OPENROUTER_API_KEY ? 'openrouter'
    : process.env.ANTHROPIC_API_KEY ? 'anthropic'
    : process.env.OPENAI_API_KEY ? 'openai' : 'openrouter')).toLowerCase();
const DEFAULT_MODEL = {
  openrouter: 'openai/gpt-oss-20b:free',      // free tier — $0 per report
  anthropic:  'claude-3-5-sonnet-latest',
  openai:     'gpt-4o',
  mock:       'mock'
};
const MODEL = () => process.env.AI_MODEL || DEFAULT_MODEL[PROVIDER()] || DEFAULT_MODEL.openrouter;
// primary model + comma-separated fallbacks tried in order (AI_MODEL_FALLBACKS)
const MODELS = () => [MODEL(), ...String(process.env.AI_MODEL_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean)];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CALL_TIMEOUT = () => Number(process.env.AI_CALL_TIMEOUT_MS) || 22000;  // per model call
const DEADLINE     = () => Number(process.env.AI_DEADLINE_MS) || 44000;      // whole request budget (< platform 60s cap)
const retryable = (e_status, msg, e) => (e && e.validation) || e_status === 429 || (e_status >= 500 && e_status < 600) ||
  /provider returned error|temporarily|overloaded|timeout|rate.?limit|capacity/i.test(msg || '');
function httpError(status, message, retryAfter) { const e = new Error(message); e.status = status; if (retryAfter) e.retryAfter = retryAfter; return e; }

/* ---- persona: a sober forensic analyst, never a hype machine ---- */
const ANALYST = `You are a senior blockchain forensics analyst at Chainsight.
You produce precise, sober investigation write-ups grounded ONLY in the structured
on-chain profile you are given. Absolute rules:
- Never invent addresses, transactions, entities, counterparties, or figures that are
  not present in the provided data. Reason only from what is there.
- Prefer concrete numbers over adjectives. Quote balances, counts, and USD values.
- When the evidence is thin, say so plainly, and name the data that would resolve it
  (e.g. token/SPL-level indexer, deeper history, sanctions list cross-reference).
- Distinguish established fact (present in the data) from inference (your reading of it).
- No hype, no price talk, no financial or legal advice. Calm, senior, exact.`;

const REPORT_SCHEMA = `Return STRICT, valid JSON only (no prose, no markdown fences) with this exact shape:
{
  "summary": string,                 // 2-4 sentences: what this address is and what the data shows
  "findings": string[],              // 3-6 specific, evidence-backed findings (cite numbers/counterparties)
  "notableTransactions": string[],   // 2-4 lines referencing real counterparties/amounts from the data
  "riskAssessment": string,          // 1-3 sentences tied to the risk score and flags
  "recommendedActions": string[]     // 2-4 concrete next steps for an analyst
}`;

/* ---- providers (Node 18+ global fetch). Each throws httpError on failure. ---- */
async function openrouter(system, user, wantJson, model, maxTokens) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw httpError(401, 'OPENROUTER_API_KEY is not set (free key at openrouter.ai/keys)');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(CALL_TIMEOUT()),
    headers: {
      Authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'https://chainsight.demo', 'X-Title': 'Chainsight'
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      // Keep reasoning models (gpt-oss etc.) snappy and stop them burning the
      // token budget on hidden thinking; OpenRouter drops this for models
      // that don't support it.
      reasoning: { effort: 'low' },
      // NOTE: free-tier models don't all support response_format — we enforce JSON
      // via the prompt and parse defensively with extractJSON() instead.
      messages: [
        { role: 'system', content: system + (wantJson ? '\n\nRespond with STRICT JSON only — no prose, no markdown fences.' : '') },
        { role: 'user', content: user }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data?.error?.message || `openrouter ${res.status}`, +res.headers.get('retry-after') || 0);
  if (data.error) throw httpError(data.error.code || 502, data.error.message || 'provider returned error');
  const txt = (data.choices?.[0]?.message?.content || '').trim();
  if (!txt) throw httpError(502, 'empty completion');
  return txt;
}
async function anthropic(system, user, wantJson, model, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpError(401, 'ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(CALL_TIMEOUT()),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: system + (wantJson ? '\n\nRespond with JSON only.' : ''), messages: [{ role: 'user', content: user }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data?.error?.message || `anthropic ${res.status}`, +res.headers.get('retry-after') || 0);
  return (data.content || []).map(b => b.text || '').join('').trim();
}
async function openai(system, user, wantJson, model, maxTokens) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw httpError(401, 'OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(CALL_TIMEOUT()),
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(wantJson ? { response_format: { type: 'json_object' } } : {}) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status, data?.error?.message || `openai ${res.status}`, +res.headers.get('retry-after') || 0);
  return (data.choices?.[0]?.message?.content || '').trim();
}
/* mock — keyless smoke tests (AI_PROVIDER=mock). Deterministic, data-grounded. */
async function mock(system, user, wantJson) {
  if (!wantJson) return 'MOCK ANALYST: grounded answer engine online — connect a real key to replace me.';
  const m = user.match(/"balance": "([^"]*)"[\s\S]*?"riskScore": (\d+)/);
  return JSON.stringify({
    summary: `MOCK REPORT — smoke test. Subject holds ${m ? m[1] : 'N/A'} with heuristic risk ${m ? m[2] : '?'}/100.`,
    findings: ['Mock finding: profile → prompt → JSON pipeline works end to end.'],
    notableTransactions: ['MOCK — connect a real model'], riskAssessment: 'Mock assessment.',
    recommendedActions: ['Set OPENROUTER_API_KEY in .env', 'Restart the server']
  });
}
const PROVIDERS = { openrouter, anthropic, openai, mock };

/* ---- resilient dispatch: walk the model chain, retry transient failures ---- */
async function callLLM(system, user, wantJson = false, maxTokens = 1000, validate = null) {
  const fn = PROVIDERS[PROVIDER()] || openrouter;
  const started = Date.now();
  let lastErr;
  for (const model of MODELS()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() - started > DEADLINE()) throw (lastErr || new Error('AI deadline exceeded'));
      try {
        const out = await fn(system, user, wantJson, model, maxTokens);
        if (validate) { try { validate(out); } catch (ve) { ve.validation = true; throw ve; } }
        return out;
      }
      catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') { e.status = 504; e.message = 'model timeout'; }
        lastErr = e;
        if (!retryable(e.status, e.message, e) || attempt === 2) break; // move to next model
        await sleep(e.retryAfter ? Math.min(e.retryAfter * 1000, 12000) : 1200 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error('LLM call failed');
}

function extractJSON(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  const m = t.match(/\{[\s\S]*\}/) || t.match(/\{[\s\S]*/); // even unterminated
  if (m) {
    let c = m[0];
    try { return JSON.parse(c); } catch (_) {}
    // best-effort repair of truncated output: close open strings/arrays/objects
    for (const suffix of ['"', '"]', '"}', '"]}', '"}]}', ']}', '}', ']}}', '}}']) {
      try { return JSON.parse(c + suffix); } catch (_) {}
    }
    c = c.replace(/,\s*$/, '');
    for (const suffix of ['}', ']}', '"]}', '"}']) {
      try { return JSON.parse(c + suffix); } catch (_) {}
    }
  }
  throw new Error('Model did not return parseable JSON');
}

/* ---- only send the analytically-relevant fields to the model ---- */
function slim(p) {
  return {
    chain: p.chain, label: p.label, address: p.address,
    balance: p.balanceNative, balanceUsd: p.balanceUsd,
    txCount: p.txCount, firstSeen: p.first, lastActive: p.last,
    riskScore: p.risk, riskFlags: (p.flags || []).map(f => ({ flag: f.t, severity: f.s, detail: f.d })),
    recentInflowUsd: p.stats?.in, recentOutflowUsd: p.stats?.out,
    counterparties: (p.counterparties || []).map(c => ({
      entity: c.label, direction: c.dir, txs: c.txs, valueUsd: Math.round(c.usd || 0), tag: c.tag?.[0] || ''
    })),
    activityTimeline: p.timeline ? { months: p.timeline.labels, inflowUsd: p.timeline.inflow, outflowUsd: p.timeline.outflow } : null,
    dataSource: p.live ? p.source : 'curated case file (live-verified)'
  };
}

export async function generateReport(profile) {
  const user = `Investigation subject profile:\n\`\`\`json\n${JSON.stringify(slim(profile), null, 2)}\n\`\`\`\n\n${REPORT_SCHEMA}`;
  const raw = await callLLM(ANALYST, user, true, 1000, out => { const j = extractJSON(out); if (!Array.isArray(j.findings) || j.findings.length < 2) throw new Error('incomplete findings'); return j; });
  const j = extractJSON(raw);
  const actions = j.recommendedActions || j.actions || [];
  return {
    summary: j.summary || '',
    findings: j.findings || [],
    notableTransactions: j.notableTransactions || j.notable || [],
    riskAssessment: j.riskAssessment || j.assessment || '',
    recommendedActions: actions.length ? actions : [
      'Verify counterparty labels against a second source before acting.',
      'Extend the window with a full indexer (Etherscan V2 · Helius) for token-level flows.'
    ]
  };
}

export async function answerChat(profile, question, history = []) {
  const convo = (history || []).slice(-6)
    .map(m => `${m.role === 'user' ? 'Analyst' : 'You'}: ${m.text}`).join('\n');
  const sys = `${ANALYST}
You are in a chat with an analyst about ONE wallet. Answer only from the profile and this
conversation. Be concise (2-5 sentences), numbers-first, plain English. PLAIN TEXT ONLY —
no markdown, no asterisks, no headers, no bullet lists; write flowing sentences. If the
data can't answer, say what's missing and how to get it. Never fabricate.`;
  const user = `Wallet profile:\n\`\`\`json\n${JSON.stringify(slim(profile), null, 2)}\n\`\`\`
${convo ? `\nConversation so far:\n${convo}\n` : ''}
Analyst's question: ${question}`;
  return (await callLLM(sys, user, false, 550)).trim();
}

export function aiInfo() {
  const p = PROVIDER();
  const keyPresent = p === 'mock' ? true
    : p === 'openrouter' ? !!process.env.OPENROUTER_API_KEY
    : p === 'openai' ? !!process.env.OPENAI_API_KEY
    : !!process.env.ANTHROPIC_API_KEY;
  return { provider: p, model: MODEL(), models: MODELS(), keyPresent };
}
