/* ============================================================
   Chainsight — server-side chain data
   Fetches + normalizes on-chain data into one WalletProfile
   shape. Uses keyed providers (Etherscan V2 / Helius) when keys
   are present, else keyless public endpoints. Keys stay here,
   server-side — never shipped to the browser.
   ============================================================ */

const PRICES = { eth: null, btc: null, sol: null, at: 0 };
async function prices() {
  if (Date.now() - PRICES.at < 60_000 && PRICES.eth) return PRICES;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,solana&vs_currencies=usd');
    const j = await r.json();
    PRICES.eth = j.ethereum?.usd || 0; PRICES.btc = j.bitcoin?.usd || 0; PRICES.sol = j.solana?.usd || 0; PRICES.at = Date.now();
  } catch (_) { /* keep last */ }
  return PRICES;
}

const short = a => (a && a.length > 18) ? a.slice(0, 8) + '…' + a.slice(-6) : (a || '');
const CHAIN = { eth: 'Ethereum', btc: 'Bitcoin', sol: 'Solana' };
const fmtDate = ts => { const d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

function labelTag(label) {
  const l = (label || '').toLowerCase();
  if (/tornado|mixer|blender|wasabi/.test(l)) return ['Mixer', 'red'];
  if (/bridge|wormhole|debridge|hop|across|celer|synapse/.test(l)) return ['Bridge', 'amber'];
  if (/binance|coinbase|kraken|okx|bybit|huobi|kucoin|bitfinex|gate|exchange|deposit/.test(l)) return ['Exchange', 'blue'];
  if (/uniswap|sushi|1inch|0x|jupiter|curve|aave|compound|router|swap/.test(l)) return ['DeFi', 'emerald'];
  return ['', ''];
}
function aggregate(items) { // items: {ts,out,v,other,name}
  const cp = {}, tl = {};
  let inUsd = 0, outUsd = 0;
  for (const t of items) {
    if (t.other) {
      const k = t.other.toLowerCase();
      const e = cp[k] || (cp[k] = { addr: short(t.other), label: t.name || short(t.other), dir: t.out ? 'out' : 'in', txs: 0, usd: 0, tag: ['', ''] });
      e.txs++; e.usd += t.v || 0;
      if ((t.out && e.dir === 'in') || (!t.out && e.dir === 'out')) e.dir = 'both';
      if (t.name) e.label = t.name;
    }
    if (t.out) outUsd += t.v || 0; else inUsd += t.v || 0;
    if (t.ts) {
      const d = new Date(t.ts), key = d.getFullYear() * 12 + d.getMonth();
      const label = d.toLocaleString('en-US', { month: 'short' }) + ' ' + String(d.getFullYear()).slice(2);
      const b = tl[key] || (tl[key] = { label, in: 0, out: 0 });
      b[t.out ? 'out' : 'in'] += t.v || 0;
    }
  }
  const cps = Object.values(cp).sort((a, b) => b.usd - a.usd).slice(0, 7);
  cps.forEach(c => c.tag = labelTag(c.label));
  const keys = Object.keys(tl).map(Number).sort((a, b) => a - b).slice(-12);
  const timeline = { labels: keys.map(k => tl[k].label), inflow: keys.map(k => tl[k].in), outflow: keys.map(k => tl[k].out) };
  return { cps, timeline, inUsd, outUsd };
}
function graphFromCps(subj, cps) {
  const CAT = { Mixer: 2, Bridge: 3, Exchange: 1, DeFi: 4, '': 5 };
  const nodes = [{ id: 'subj', name: subj, cat: 0, size: 42 }];
  const edges = [];
  cps.forEach((c, i) => {
    const id = 'n' + i;
    nodes.push({ id, name: c.label.length > 16 ? c.label.slice(0, 15) + '…' : c.label, cat: CAT[c.tag[0]] ?? 5, size: Math.max(12, Math.min(30, 10 + Math.log10((c.usd || 0) + 10) * 4)) });
    edges.push(c.dir === 'in' ? { s: id, t: 'subj', usd: c.usd, txs: c.txs } : { s: 'subj', t: id, usd: c.usd, txs: c.txs });
  });
  return { nodes, edges };
}
function scoreRisk(sig) {
  let r = 8; const flags = [];
  if (sig.scam) { r += 72; flags.push({ t: 'Flagged by block explorer', s: 'critical', d: 'Public scam/abuse tag on the explorer.' }); }
  const mix = sig.cps.filter(c => c.tag[0] === 'Mixer');
  if (mix.length) { r += 45; flags.push({ t: 'Mixer exposure', s: 'critical', d: `Direct flow to/from ${mix.map(m => m.label).join(', ')}.` }); }
  const br = sig.cps.filter(c => c.tag[0] === 'Bridge');
  if (br.length) { r += 10; flags.push({ t: 'Cross-chain bridge use', s: 'medium', d: `${br.length} bridge counterpart(y/ies) in recent flow.` }); }
  if (sig.contract) { r += 5; flags.push({ t: 'Contract / smart account', s: 'info', d: sig.proxy ? `Smart-contract account (${sig.proxy}).` : 'Address is a contract, not an EOA.' }); }
  const outCps = sig.cps.filter(c => c.dir !== 'in').length;
  if (outCps >= 6) { r += 12; flags.push({ t: 'Wide out-distribution', s: 'high', d: `Funds spread across ${outCps}+ recipients — possible fan-out.` }); }
  if (!flags.length) flags.push({ t: 'No adverse signals in window', s: 'low', d: 'No mixer, sanctions-proximity, or fan-out patterns in the recent window.' });
  return { risk: Math.max(2, Math.min(95, Math.round(r))), flags };
}

/* ---------- Ethereum: Etherscan V2 (if key) else Blockscout ---------- */
async function eth(address) {
  const px = (await prices()).eth, subj = address.toLowerCase();
  const key = process.env.ETHERSCAN_KEY;
  let bal = 0, txItems = [], info = {}, source = 'Blockscout';
  if (key) {
    source = 'Etherscan V2';
    const base = `https://api.etherscan.io/v2/api?chainid=1&apikey=${key}`;
    const [balR, txR] = await Promise.all([
      fetch(`${base}&module=account&action=balance&address=${address}&tag=latest`).then(r => r.json()),
      fetch(`${base}&module=account&action=txlist&address=${address}&page=1&offset=50&sort=desc`).then(r => r.json())
    ]);
    bal = (+balR.result || 0) / 1e18;
    const txs = Array.isArray(txR.result) ? txR.result : [];
    txItems = txs.map(t => {
      const out = (t.from || '').toLowerCase() === subj;
      return { ts: +t.timeStamp * 1000, out, v: (+t.value || 0) / 1e18 * px, other: out ? t.to : t.from, name: null };
    });
    info = { txCount: txs.length ? undefined : 0 };
  } else {
    const b = 'https://eth.blockscout.com/api/v2';
    info = await fetch(`${b}/addresses/${address}`).then(r => r.json());
    const [counters, txR] = await Promise.all([
      fetch(`${b}/addresses/${address}/counters`).then(r => r.json()).catch(() => ({})),
      fetch(`${b}/addresses/${address}/transactions`).then(r => r.json()).catch(() => ({ items: [] }))
    ]);
    bal = (+info.coin_balance || 0) / 1e18;
    info.txCount = +(counters.transactions_count || 0) || undefined;
    txItems = (txR.items || []).filter(t => t.from && t.hash).map(t => {
      const out = (t.from.hash || '').toLowerCase() === subj, other = out ? t.to : t.from;
      return { ts: t.timestamp, out, v: (+t.value || 0) / 1e18 * px, other: other && other.hash, name: other && other.name };
    });
  }
  const { cps, timeline, inUsd, outUsd } = aggregate(txItems);
  const { risk, flags } = scoreRisk({ scam: info.is_scam, contract: info.is_contract, proxy: info.proxy_type, cps });
  const label = info.ens_domain_name || info.name || short(address);
  const tags = [];
  if (info.ens_domain_name) tags.push(['ENS: ' + info.ens_domain_name, 'violet']);
  if (info.is_contract) tags.push([info.proxy_type ? 'Smart account · ' + info.proxy_type : 'Contract', 'blue']);
  tags.push(['Live · ' + source, 'emerald']);
  return finalize('eth', address, label, bal, 'ETH', px, info.txCount ?? txItems.length, txItems, cps, timeline, inUsd, outUsd, risk, flags, tags, source);
}

/* ---------- Bitcoin: Blockstream (keyless) ---------- */
async function btc(address) {
  const px = (await prices()).btc, subj = address;
  const b = 'https://blockstream.info/api';
  const info = await fetch(`${b}/address/${address}`).then(r => r.json());
  const txs = await fetch(`${b}/address/${address}/txs`).then(r => r.json()).catch(() => []);
  const items = (txs || []).map(t => {
    const inVin = (t.vin || []).some(i => i.prevout && i.prevout.scriptpubkey_address === subj);
    const out = inVin; let v = 0, other = null;
    if (out) { const o = (t.vout || []).filter(x => x.scriptpubkey_address && x.scriptpubkey_address !== subj).sort((a, b) => b.value - a.value); v = o.reduce((s, x) => s + x.value, 0); other = o[0]?.scriptpubkey_address; }
    else { const o = (t.vout || []).filter(x => x.scriptpubkey_address === subj); v = o.reduce((s, x) => s + x.value, 0); other = (t.vin || []).map(i => i.prevout?.scriptpubkey_address).find(a => a && a !== subj); }
    return { ts: t.status?.block_time ? t.status.block_time * 1000 : null, out, v: v / 1e8 * px, other, name: null };
  });
  const { cps, timeline, inUsd, outUsd } = aggregate(items);
  const bal = ((info.chain_stats?.funded_txo_sum || 0) - (info.chain_stats?.spent_txo_sum || 0)) / 1e8;
  const { risk, flags } = scoreRisk({ cps });
  return finalize('btc', address, short(address), bal, 'BTC', px, info.chain_stats?.tx_count || items.length, items, cps, timeline, inUsd, outUsd, risk, flags, [['UTXO wallet', ''], ['Live · Blockstream', 'emerald']], 'Blockstream');
}

/* ---------- Solana: Helius (if key) else public RPC ---------- */
async function sol(address) {
  const px = (await prices()).sol;
  const rpc = process.env.HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com';
  const call = (method, params) => fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json()).then(r => { if (r.error) throw new Error(r.error.message); return r.result; });
  const [balR, sigs] = await Promise.all([call('getBalance', [address]), call('getSignaturesForAddress', [address, { limit: 200 }]).catch(() => [])]);
  const bal = (balR?.value || 0) / 1e9;
  const times = (sigs || []).filter(s => s.blockTime).map(s => s.blockTime * 1000);
  const items = times.map(ts => ({ ts, out: false, v: 0 }));
  const { timeline } = aggregate(items);
  const source = process.env.HELIUS_KEY ? 'Helius' : 'Solana RPC';
  return {
    chain: 'sol', live: true, source, id: 'live_sol_' + address.slice(0, 8), caseNo: 'LIVE / ' + source,
    address, label: short(address), desc: 'Live Solana lookup',
    tags: [['SPL wallet', ''], ['Live · ' + source, 'emerald']],
    balanceNative: bal.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' SOL', balanceUsd: usd(bal * px),
    first: times.length ? fmtDate(Math.min(...times)) : '—', last: times.length ? fmtDate(Math.max(...times)) : '—',
    txCount: (sigs || []).length >= 200 ? '200+' : (sigs || []).length, risk: 12,
    flags: [{ t: 'Activity-level view', s: 'info', d: process.env.HELIUS_KEY ? 'Balance + signatures live via Helius. Full SPL parsing available on request.' : 'Public RPC gives balance + signatures. SPL flows/counterparties need Helius.' }],
    stats: { in: 0, out: 0, peak: timeline.labels.slice(-1)[0] || '—', peakV: 0 },
    timeline: timeline.labels.length ? timeline : { labels: ['window'], inflow: [0], outflow: [0] },
    counterparties: [{ addr: short(address), label: process.env.HELIUS_KEY ? 'SPL parsing on request' : 'Enable Helius for SPL counterparties', dir: 'both', txs: (sigs || []).length, usd: 0, tag: ['Needs indexer', 'amber'] }],
    graph: { nodes: [{ id: 'subj', name: short(address), cat: 0, size: 42 }], edges: [] }, qa: []
  };
}

function usd(n) { if (n >= 1e9) return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'; if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K'; return '$' + Math.round(n); }
function finalize(chain, address, label, bal, unit, px, txCount, items, cps, timeline, inUsd, outUsd, risk, flags, tags, source) {
  return {
    chain, live: true, source, id: 'live_' + chain + '_' + address.slice(2, 10), caseNo: 'LIVE / ' + source,
    address, label, desc: `Live ${CHAIN[chain]} lookup`, tags,
    balanceNative: bal.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + unit, balanceUsd: usd(bal * px),
    first: '—', last: items[0]?.ts ? fmtDate(items[0].ts) : '—', txCount, risk,
    flags, stats: { in: inUsd, out: outUsd, peak: timeline.labels[0] || '—', peakV: Math.max(inUsd, outUsd) },
    timeline: timeline.labels.length ? timeline : { labels: ['window'], inflow: [inUsd], outflow: [outUsd] },
    counterparties: cps.length ? cps : [{ addr: short(address), label: 'No transfers in recent window', dir: 'both', txs: 0, usd: 0, tag: ['', ''] }],
    graph: graphFromCps(label.length > 14 ? short(address) : label, cps), qa: []
  };
}

export async function getWallet(chain, address) {
  if (chain === 'eth') return eth(address);
  if (chain === 'btc') return btc(address);
  if (chain === 'sol') return sol(address);
  throw new Error('unsupported chain: ' + chain);
}
