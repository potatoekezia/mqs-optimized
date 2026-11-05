import {
  GEMINI_MODEL,
  GEMINI_GENERATION_CONFIG,
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
const MAX_ATTEMPTS = 2;
const PER_ATTEMPT_TIMEOUT_MS = 3500;
const HEDGE_DELAY_MS = 2000;

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
  | 'timeout'
  | 'error'
  | 'skipped_cooldown';

export interface AttemptLogEntry {
  keyIndex: number;
  outcome: AttemptOutcome;
}

interface SingleAttemptSuccess {
  ok: true;
  keyIndex: number;
  text: string;
}

interface SingleAttemptFailure {
  ok: false;
  keyIndex: number;
  outcome: AttemptOutcome;
  classified: ClassifiedGeminiError;
}

type SingleAttemptResult = SingleAttemptSuccess | SingleAttemptFailure;

function startAttempt(
  keyIndex: number,
  apiKey: string,
  contentPayload: unknown[]
): { promise: Promise<SingleAttemptResult>; abort: () => void } {
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let cancelledByWinner = false;

  const abort = () => {
    cancelledByWinner = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    abortController.abort();
  };

  const promise = (async (): Promise<SingleAttemptResult> => {
    const ai = createGeminiClient(apiKey);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new Error('PER_ATTEMPT_TIMEOUT'));
      }, PER_ATTEMPT_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: contentPayload,
          config: {
            ...GEMINI_GENERATION_CONFIG,
            abortSignal: abortController.signal,
          },
        }),
        timeoutPromise,
      ]);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      const text = response?.text ? response.text.trim() : '';
      if (!text) {
        console.warn(`[Gemini key #${keyIndex}] Empty response from ${GEMINI_MODEL}`);
        return {
          ok: false,
          keyIndex,
          outcome: 'error',
          classified: {
            status: 502,
            reason: 'error',
            message: `Empty response from ${GEMINI_MODEL} using key #${keyIndex}.`,
            detail: 'Model returned empty text.',
          },
        };
      }

      return {
        ok: true,
        keyIndex,
        text,
      };
    } catch (err: unknown) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (!cancelledByWinner) {
        const rawMsg =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : JSON.stringify(err);
        console.warn(`[Gemini key #${keyIndex}] ${rawMsg.slice(0, 300)}`);
      }

      const classified = classifyGeminiError(err);
      if (classified.reason === 'quota_exhausted') {
        keyCooldownMap.set(keyIndex, Date.now() + COOLDOWN_MS);
      }

      const outcome: AttemptOutcome =
        classified.reason === 'quota_exhausted' ||
        classified.reason === 'invalid_key' ||
        classified.reason === 'permission_denied' ||
        classified.reason === 'model_not_found' ||
        classified.reason === 'timeout'
          ? classified.reason
          : 'error';

      return {
        ok: false,
        keyIndex,
        outcome,
        classified,
      };
    }
  })();

  return { promise, abort };
}

function isRetryableOutcome(outcome: AttemptOutcome): boolean {
  return (
    outcome === 'quota_exhausted' ||
    outcome === 'invalid_key' ||
    outcome === 'permission_denied' ||
    outcome === 'timeout'
  );
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

  const key0 = candidateIndices[0];
  const attempt0 = startAttempt(key0, keys[key0], contentPayload);

  // Single candidate key available
  if (candidateIndices.length === 1) {
    const res0 = await attempt0.promise;
    if (res0.ok) {
      attemptLog.push({ keyIndex: res0.keyIndex, outcome: 'ok' });
      return res.status(200).json({
        success: true,
        text: res0.text,
        keyIndex: res0.keyIndex,
        attemptLog,
      });
    }
    attemptLog.push({ keyIndex: res0.keyIndex, outcome: res0.outcome });
    return res.status(res0.classified.status).json({
      success: false,
      reason: res0.classified.reason,
      message: res0.classified.message,
      detail: res0.classified.detail,
      attempts: 1,
      attemptLog,
    });
  }

  // Two candidate keys: wait up to HEDGE_DELAY_MS (2000ms) before hedging with key #2
  let hedgeTimerId: ReturnType<typeof setTimeout> | null = null;
  const raceBeforeHedge = await Promise.race([
    attempt0.promise.then((result) => ({ kind: 'attempt0' as const, result })),
    new Promise<{ kind: 'hedge_timer' }>((resolve) => {
      hedgeTimerId = setTimeout(() => resolve({ kind: 'hedge_timer' }), HEDGE_DELAY_MS);
    }),
  ]);
  if (hedgeTimerId) {
    clearTimeout(hedgeTimerId);
    hedgeTimerId = null;
  }

  // Case 1: Key #1 settled before 2000ms hedge timer
  if (raceBeforeHedge.kind === 'attempt0') {
    const res0 = raceBeforeHedge.result;
    if (res0.ok) {
      attemptLog.push({ keyIndex: res0.keyIndex, outcome: 'ok' });
      return res.status(200).json({
        success: true,
        text: res0.text,
        keyIndex: res0.keyIndex,
        attemptLog,
      });
    }

    attemptLog.push({ keyIndex: res0.keyIndex, outcome: res0.outcome });
    if (!isRetryableOutcome(res0.outcome)) {
      return res.status(res0.classified.status).json({
        success: false,
        reason: res0.classified.reason,
        message: res0.classified.message,
        detail: res0.classified.detail,
        attempts: 1,
        attemptLog,
      });
    }

    // Retry immediately with key #2
    const key1 = candidateIndices[1];
    const attempt1 = startAttempt(key1, keys[key1], contentPayload);
    const res1 = await attempt1.promise;
    if (res1.ok) {
      attemptLog.push({ keyIndex: res1.keyIndex, outcome: 'ok' });
      return res.status(200).json({
        success: true,
        text: res1.text,
        keyIndex: res1.keyIndex,
        attemptLog,
      });
    }
    attemptLog.push({ keyIndex: res1.keyIndex, outcome: res1.outcome });
    return res.status(res1.classified.status).json({
      success: false,
      reason: res1.classified.reason,
      message: res1.classified.message,
      detail: res1.classified.detail,
      attempts: 2,
      attemptLog,
    });
  }

  // Case 2: 2000ms elapsed and Key #1 is still in flight -> launch hedged Key #2 in parallel
  const key1 = candidateIndices[1];
  const attempt1 = startAttempt(key1, keys[key1], contentPayload);

  const firstSettled = await Promise.race([
    attempt0.promise.then((result) => ({ which: 0 as const, result })),
    attempt1.promise.then((result) => ({ which: 1 as const, result })),
  ]);

  if (firstSettled.result.ok) {
    // Abort the loser so we don't wait for it
    if (firstSettled.which === 0) {
      attempt1.abort();
    } else {
      attempt0.abort();
    }
    attemptLog.push({ keyIndex: firstSettled.result.keyIndex, outcome: 'ok' });
    return res.status(200).json({
      success: true,
      text: firstSettled.result.text,
      keyIndex: firstSettled.result.keyIndex,
      attemptLog,
    });
  }

  // First finisher failed -> record its failure and wait for the remaining in-flight attempt
  attemptLog.push({
    keyIndex: firstSettled.result.keyIndex,
    outcome: firstSettled.result.outcome,
  });

  const secondResult =
    firstSettled.which === 0 ? await attempt1.promise : await attempt0.promise;

  if (secondResult.ok) {
    attemptLog.push({ keyIndex: secondResult.keyIndex, outcome: 'ok' });
    return res.status(200).json({
      success: true,
      text: secondResult.text,
      keyIndex: secondResult.keyIndex,
      attemptLog,
    });
  }

  attemptLog.push({ keyIndex: secondResult.keyIndex, outcome: secondResult.outcome });
  return res.status(secondResult.classified.status).json({
    success: false,
    reason: secondResult.classified.reason,
    message: secondResult.classified.message,
    detail: secondResult.classified.detail,
    attempts: 2,
    attemptLog,
  });
}
