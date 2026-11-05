import {
  GEMINI_MODEL,
  parseGeminiKeys,
  createGeminiClient,
  classifyGeminiError,
  type ClassifiedGeminiError,
} from '../_lib/gemini.js';

export const config = {
  maxDuration: 30,
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 3;

// Best-effort warm-instance cooldown map: keyIndex -> cooldownUntil timestamp
const keyCooldownMap = new Map<number, number>();

function shuffleIndices(indices: number[]): number[] {
  const arr = [...indices];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export type AttemptOutcome =
  | 'ok'
  | 'quota_exhausted'
  | 'invalid_key'
  | 'permission_denied'
  | 'model_not_found'
  | 'error'
  | 'skipped_cooldown';

export interface AttemptLogEntry {
  keyIndex: number;
  outcome: AttemptOutcome;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      reason: 'error',
      message: 'Method not allowed. Use POST.',
      detail: `Received ${req.method}`,
      attempts: 0,
      attemptLog: [],
    });
  }

  const keys = parseGeminiKeys();
  if (keys.length === 0) {
    return res.status(500).json({
      success: false,
      reason: 'no_keys',
      message: 'No Gemini API keys configured on server (GEMINI_KEYS is empty).',
      detail: 'Set GEMINI_KEYS in environment variables.',
      attempts: 0,
      attemptLog: [],
    });
  }

  const body = req.body || {};
  const { contents } = body;
  if (!contents) {
    return res.status(400).json({
      success: false,
      reason: 'error',
      message: 'Missing contents in request body.',
      detail: 'Request body must include { contents }.',
      attempts: 0,
      attemptLog: [],
    });
  }

  const now = Date.now();
  const attemptLog: AttemptLogEntry[] = [];
  const availableIndices: number[] = [];

  for (let i = 0; i < keys.length; i++) {
    const cooldownUntil = keyCooldownMap.get(i);
    if (cooldownUntil && now < cooldownUntil) {
      attemptLog.push({ keyIndex: i, outcome: 'skipped_cooldown' });
      continue;
    }
    if (cooldownUntil && now >= cooldownUntil) {
      keyCooldownMap.delete(i);
    }
    availableIndices.push(i);
  }

  if (availableIndices.length === 0) {
    return res.status(429).json({
      success: false,
      reason: 'quota_exhausted',
      message: 'All server Gemini keys are currently in 5-minute cooldown.',
      detail: `All ${keys.length} key(s) returned 429 within the last 5 minutes.`,
      attempts: 0,
      attemptLog,
    });
  }

  const candidateIndices = shuffleIndices(availableIndices).slice(0, MAX_ATTEMPTS);
  const contentPayload = Array.isArray(contents) ? contents : [contents];

  let lastClassified: ClassifiedGeminiError = {
    status: 502,
    reason: 'error',
    message: 'Unknown Gemini error.',
    detail: 'No attempt completed.',
  };
  let attempts = 0;

  for (const keyIndex of candidateIndices) {
    attempts++;
    const ai = createGeminiClient(keys[keyIndex]);

    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: contentPayload,
      });

      const text = response?.text ? response.text.trim() : '';
      if (!text) {
        attemptLog.push({ keyIndex, outcome: 'error' });
        lastClassified = {
          status: 502,
          reason: 'error',
          message: `Empty response from ${GEMINI_MODEL} using key #${keyIndex}.`,
          detail: 'Model returned empty text.',
        };
        console.warn(`[Gemini key #${keyIndex}] Empty response from ${GEMINI_MODEL}`);
        return res.status(502).json({
          success: false,
          reason: lastClassified.reason,
          message: lastClassified.message,
          detail: lastClassified.detail,
          attempts,
          attemptLog,
        });
      }

      attemptLog.push({ keyIndex, outcome: 'ok' });
      return res.status(200).json({
        success: true,
        text,
        keyIndex,
        attemptLog,
      });
    } catch (err: unknown) {
      const rawMsg =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : JSON.stringify(err);
      console.warn(`[Gemini key #${keyIndex}] ${rawMsg.slice(0, 300)}`);

      const classified = classifyGeminiError(err);
      lastClassified = classified;

      const outcome: AttemptOutcome =
        classified.reason === 'quota_exhausted' ||
        classified.reason === 'invalid_key' ||
        classified.reason === 'permission_denied' ||
        classified.reason === 'model_not_found'
          ? classified.reason
          : 'error';
      attemptLog.push({ keyIndex, outcome });

      if (classified.reason === 'quota_exhausted') {
        keyCooldownMap.set(keyIndex, Date.now() + COOLDOWN_MS);
        continue;
      }

      if (
        classified.reason === 'invalid_key' ||
        classified.reason === 'permission_denied'
      ) {
        continue;
      }

      // For model_not_found or any other error, stop immediately
      return res.status(classified.status).json({
        success: false,
        reason: classified.reason,
        message: classified.message,
        detail: classified.detail,
        attempts,
        attemptLog,
      });
    }
  }

  return res.status(lastClassified.status).json({
    success: false,
    reason: lastClassified.reason,
    message: lastClassified.message,
    detail: lastClassified.detail,
    attempts,
    attemptLog,
  });
}
