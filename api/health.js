import { aiInfo } from './_lib/ai.js';
import { cors } from './_lib/http.js';

export default function handler(req, res) {
  if (cors(req, res)) return;
  const ai = aiInfo();
  res.status(200).json({ ok: true, service: 'chainsight', provider: ai.provider, model: ai.model, aiReady: ai.keyPresent });
}
