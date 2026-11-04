import { parseGeminiKeys } from '../_lib/gemini.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const keys = parseGeminiKeys();
  return res.status(200).json({ keyCount: keys.length });
}
