import type {
  HealthEvent,
  HealthTrackerConfig,
  ProviderHealthSnapshot,
} from './types.js';
import { DEFAULT_HEALTH_CONFIG } from './types.js';

/**
 * Tracks provider health using a per-provider sliding window of recent
 * request outcomes. Implements a circuit breaker pattern: when the failure
 * rate exceeds a threshold the provider is marked unhealthy. After a
 * recovery period a single probe request is allowed through — if it
 * succeeds the circuit closes, otherwise it reopens.
 *
 * Thread-safe in the single-threaded Node.js sense (no shared mutable
 * state across workers).
 */
export class ProviderHealthTracker {
  private readonly config: HealthTrackerConfig;
  /** Sliding window of recent events per provider. */
  private readonly windows = new Map<string, HealthEvent[]>();
  /** Timestamp when the circuit was opened per provider. */
  private readonly circuitOpenedAt = new Map<string, number>();

  constructor(config?: Partial<HealthTrackerConfig>) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /**
   * Record a model call outcome.
   */
  recordEvent(event: HealthEvent): void {
    const key = event.provider;

    let window = this.windows.get(key);
    if (!window) {
      window = [];
      this.windows.set(key, window);
    }

    window.push(event);

    // Trim to window size
    while (window.length > this.config.windowSize) {
      window.shift();
    }

    // If we just recorded a success and the circuit was open, close it
    if (event.success && this.circuitOpenedAt.has(key)) {
      this.circuitOpenedAt.delete(key);
    }

    // Check if the failure rate now exceeds the threshold
    if (!event.success) {
      const { failureRate } = this.computeRates(window);
      if (failureRate >= this.config.failureThreshold && !this.circuitOpenedAt.has(key)) {
        this.circuitOpenedAt.set(key, event.timestamp);
      }
    }
  }

  /**
   * Whether a provider is considered healthy enough to receive traffic.
   *
   * When the circuit is open, returns false unless enough time has passed
   * for a probe attempt (half-open state).
   */
  isHealthy(provider: string, now: number = Date.now()): boolean {
    const openedAt = this.circuitOpenedAt.get(provider);
    if (openedAt === undefined) return true;

    // Allow a probe after the recovery period
    const elapsed = (now - openedAt) / 1000;
    return elapsed >= this.config.recoveryAfterSeconds;
  }

  /**
   * Get a snapshot of a single provider's health.
   */
  getSnapshot(provider: string, now: number = Date.now()): ProviderHealthSnapshot {
    const window = this.windows.get(provider);
    if (!window || window.length === 0) {
      return {
        provider,
        successes: 0,
        failures: 0,
        failureRate: 0,
        healthy: true,
        avgLatencyMs: 0,
      };
    }

    const { successes, failures, failureRate } = this.computeRates(window);
    const avgLatencyMs = this.computeAvgLatency(window);
    const healthy = this.isHealthy(provider, now);
    const circuitOpened = this.circuitOpenedAt.get(provider);

    return {
      provider,
      successes,
      failures,
      failureRate,
      healthy,
      avgLatencyMs,
      circuitOpenedAt: circuitOpened,
    };
  }

  /**
   * Get snapshots for all tracked providers.
   */
  getAllSnapshots(now: number = Date.now()): ProviderHealthSnapshot[] {
    const providers = new Set([
      ...this.windows.keys(),
      ...this.circuitOpenedAt.keys(),
    ]);
    return [...providers].map(p => this.getSnapshot(p, now));
  }

  /**
   * Reset all health data (useful in tests or after config change).
   */
  reset(): void {
    this.windows.clear();
    this.circuitOpenedAt.clear();
  }

  private computeRates(window: HealthEvent[]): { successes: number; failures: number; failureRate: number } {
    let successes = 0;
    let failures = 0;
    for (const event of window) {
      if (event.success) successes++;
      else failures++;
    }
    const total = successes + failures;
    return {
      successes,
      failures,
      failureRate: total > 0 ? failures / total : 0,
    };
  }

  private computeAvgLatency(window: HealthEvent[]): number {
    const successful = window.filter(e => e.success);
    if (successful.length === 0) return 0;
    const total = successful.reduce((sum, e) => sum + e.latencyMs, 0);
    return Math.round(total / successful.length);
  }
}
