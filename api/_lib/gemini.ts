import { GoogleGenAI } from '@google/genai';

// Chosen model: gemini-3.1-flash-lite
// Supports multimodal generateContent (image + text) with minimal thinking latency
// and the highest free-tier RPM/RPD quota limits among current Gemini 3 models.
export const GEMINI_MODEL = 'gemini-3.1-flash-lite';

export type GeminiFailureReason =
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exhausted'
  | 'model_not_found'
  | 'error';

export interface ClassifiedGeminiError {
  status: number;
  reason: GeminiFailureReason;
  message: string;
  detail: string;
}

export function parseGeminiKeys(): string[] {
  return (process.env.GEMINI_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function classifyGeminiError(err: unknown): ClassifiedGeminiError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  const detail = raw.slice(0, 200);
  const upper = raw.toUpperCase();

  if (
    upper.includes('404') ||
    upper.includes('NOT_FOUND') ||
    raw.toLowerCase().includes('not found')
  ) {
    return {
      status: 404,
      reason: 'model_not_found',
      message: `Model '${GEMINI_MODEL}' was not found or is unsupported.`,
      detail,
    };
  }

  if (
    upper.includes('API_KEY_INVALID') ||
    raw.includes('API key not valid') ||
    raw.includes('invalid_api_key') ||
    upper.includes('INVALID_ARGUMENT')
  ) {
    return {
      status: 400,
      reason: 'invalid_key',
      message: 'Gemini API key is invalid.',
      detail,
    };
  }

  if (
    upper.includes('403') ||
    upper.includes('PERMISSION_DENIED') ||
    raw.toLowerCase().includes('permission denied') ||
    raw.toLowerCase().includes('does not have permission') ||
    raw.includes('Generative Language API has not been used')
  ) {
    return {
      status: 403,
      reason: 'permission_denied',
      message: 'Permission denied for Gemini API key.',
      detail,
    };
  }

  if (
    upper.includes('429') ||
    upper.includes('RESOURCE_EXHAUSTED') ||
    raw.toLowerCase().includes('quota') ||
    raw.toLowerCase().includes('rate limit')
  ) {
    return {
      status: 429,
      reason: 'quota_exhausted',
      message: 'Gemini API key quota exhausted (429).',
      detail,
    };
  }

  return {
    status: 502,
    reason: 'error',
    message: 'Gemini API request failed.',
    detail,
  };
}
