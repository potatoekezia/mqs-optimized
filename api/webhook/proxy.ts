export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  const { url, payload } = req.body || {};
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing webhook URL',
    });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        success: false,
        status: response.status,
        error: `Upstream webhook returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
      });
    }

    return res.status(200).json({
      success: true,
      status: response.status,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Webhook Proxy Error] ${msg.slice(0, 300)}`);
    return res.status(502).json({
      success: false,
      error: msg.slice(0, 200) || 'Webhook proxy request failed',
    });
  }
}
