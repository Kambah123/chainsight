import { getWallet } from './_lib/chains.js';
import { cors, readBody } from './_lib/http.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { chain, address } = await readBody(req);
    if (!chain || !address) return res.status(400).json({ error: 'chain and address required' });
    res.status(200).json(await getWallet(chain, address));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
