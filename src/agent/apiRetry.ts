import type { ApiErrorCategory } from './types/recovery.js';

/**
 * Categorize a provider SDK error for retry decisions.
 *
 * Uses duck-typing to handle both OpenAI SDK errors (APIError with .status)
 * and Google AI SDK errors (GoogleGenerativeAIFetchError with .status).
 * Falls back to message pattern matching when .status is absent.
 */
export function categorizeApiError(error: unknown): ApiErrorCategory {
  if (error == null || typeof error !== 'object') {
    const message = String(error ?? '').toLowerCase();
    if (message.includes('rate limit') || message.includes('too many requests')) return 'rate_limit';
    if (message.includes('overloaded')) return 'overloaded';
    return 'unknown';
  }
  const status = (error as { status?: unknown }).status;

  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit';
    if (status === 529) return 'overloaded';
    if (status === 413) return 'context_overflow';
    if (status === 401 || status === 403) return 'auth_error';
    if (status >= 500) return 'server_error';
  }

  // Fall back to message pattern matching for errors without .status
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('too many requests')) return 'rate_limit';
  if (lower.includes('overloaded')) return 'overloaded';
  if (lower.includes('prompt is too long') || lower.includes('context length') || lower.includes('content too large')) return 'context_overflow';
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('authentication')) return 'auth_error';

  return 'unknown';
}

/**
 * Short exponential backoff for user-facing latency.
 * 100ms, 200ms, 400ms — max total 700ms across 3 retries.
 */
export async function exponentialBackoff(attempt: number): Promise<void> {
  const delayMs = 100 * Math.pow(2, attempt);
  await new Promise(resolve => setTimeout(resolve, delayMs));
}
