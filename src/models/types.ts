import type { ModelConfig } from '../config/schema.js';

// --- Model task types (what is the model being used for?) ---

export type ModelTask =
  | 'primary'      // Main conversation model
  | 'fallback'     // Fallback on consecutive failures
  | 'summary'      // Conversation summarization
  | 'extraction'   // Session memory extraction
  | 'forked';      // Background forked agent tasks

// --- Provider health tracking ---

export interface ProviderHealthSnapshot {
  /** Provider identifier (e.g. 'openai', 'anthropic') */
  provider: string;
  /** Number of successes in the current window */
  successes: number;
  /** Number of failures in the current window */
  failures: number;
  /** Failure rate (0–1) across the window */
  failureRate: number;
  /** Whether the provider is currently considered healthy */
  healthy: boolean;
  /** Average latency in milliseconds from successful events (0 if no data) */
  avgLatencyMs: number;
  /** Timestamp when the circuit was opened (undefined if healthy) */
  circuitOpenedAt?: number;
}

export interface HealthEvent {
  provider: string;
  model: string;
  success: boolean;
  latencyMs: number;
  errorCategory?: string;
  timestamp: number;
}

// --- Routing decisions ---

export interface RoutingDecision {
  /** The resolved model config to use */
  modelConfig: ModelConfig;
  /** Why this model was chosen */
  reason: RoutingReason;
  /** The task this model was resolved for */
  task: ModelTask;
}

export type RoutingReason =
  | 'config_primary'           // Direct config match for this task
  | 'config_task_specific'     // Task-specific model configured
  | 'fallback_health'          // Primary unhealthy, fell back
  | 'fallback_not_configured'; // No task-specific model, using primary

// --- Health tracker configuration ---

export interface HealthTrackerConfig {
  /** Maximum number of events in the sliding window */
  windowSize: number;
  /** Failure rate threshold (0–1) to trip the circuit breaker */
  failureThreshold: number;
  /** Seconds after circuit opens before allowing a probe request */
  recoveryAfterSeconds: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthTrackerConfig = {
  windowSize: 20,
  failureThreshold: 0.5,
  recoveryAfterSeconds: 60,
};

// --- Model capabilities (future use) ---
// Intentionally omitted from implementation scope.
// When model-specific capabilities (vision, function calling, streaming)
// need to influence routing decisions, define a ModelCapability interface here
// and add a `capabilities` field to the routing types above.
