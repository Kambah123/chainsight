import { generateReport } from './_lib/ai.js';
import { cors, readBody } from './_lib/http.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { profile } = await readBody(req);
    if (!profile) return res.status(400).json({ error: 'profile required' });
    res.status(200).json(await generateReport(profile));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
