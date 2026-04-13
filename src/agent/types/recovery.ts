// --- Continuation reasons (why the loop iterated again) ---

export type ContinuationReason =
  | { reason: 'tool_use'; toolNames: string[] }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_recovery'; attempt: number }
  | { reason: 'api_retry'; attempt: number; errorType: ApiErrorCategory }
  | { reason: 'fallback_model'; fromModel: string; toModel: string };

// --- Terminal reasons (why the loop stopped) ---

export type TerminalReason =
  | { reason: 'completed' }
  | { reason: 'max_turns' }
  | { reason: 'prompt_too_long' }
  | { reason: 'model_error'; error: string }
  | { reason: 'aborted'; phase: 'streaming' | 'tools' }
  | { reason: 'max_output_exhausted' }
  | { reason: 'quota_exceeded' };

// --- API error categories (for retry decisions) ---

export type ApiErrorCategory =
  | 'rate_limit'       // 429
  | 'overloaded'       // 529
  | 'server_error'     // 5xx
  | 'context_overflow' // 413
  | 'auth_error'       // 401/403
  | 'unknown';

// --- Recovery state tracked across loop iterations ---

export interface RecoveryState {
  hasAttemptedReactiveCompact: boolean;
  maxOutputRecoveryCount: number;
  accumulatedText: string;
  fallbackAttempted: boolean;
  lastTransition: ContinuationReason | undefined;
}

export const RECOVERY_LIMITS = {
  MAX_OUTPUT_RECOVERY_ATTEMPTS: 3,
  MAX_API_RETRIES: 3,
  FALLBACK_AFTER_CONSECUTIVE_529: 3,
} as const;

export function initialRecoveryState(): RecoveryState {
  return {
    hasAttemptedReactiveCompact: false,
    maxOutputRecoveryCount: 0,
    accumulatedText: '',
    fallbackAttempted: false,
    lastTransition: undefined,
  };
}
