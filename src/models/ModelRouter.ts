import type { AgentConfig, ModelConfig } from '../config/schema.js';
import { createHash } from 'node:crypto';
import type { ModelClient } from './ModelClient.js';
import type { IModelClientFactory } from './ModelClientFactory.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';
import type {
  ModelTask,
  RoutingDecision,
  ProviderHealthSnapshot,
} from './types.js';

/**
 * Central model routing layer.
 *
 * Resolves which model to use for a given task type by consulting:
 *   1. Task-specific model class (`fallback` / `fast`)
 *   2. Primary model config (config.model)
 *   3. Provider health — if the resolved provider is unhealthy and a
 *      fallback is configured, routes to the fallback instead.
 *
 * Also owns a client cache so repeated calls for the same model config
 * reuse the same client instance.
 */
export class ModelRouter {
  private readonly healthTracker: ProviderHealthTracker;
  private readonly clientCache = new Map<string, ModelClient>();

  constructor(
    private readonly config: AgentConfig,
    private readonly clientFactory: IModelClientFactory,
  ) {
    const health = config.routing.health;
    this.healthTracker = new ProviderHealthTracker(
      health.enabled
        ? {
            windowSize: health.window_size,
            failureThreshold: health.failure_threshold,
            recoveryAfterSeconds: health.recovery_after_seconds,
          }
        : undefined,
    );
  }

  /** Whether health-aware routing is enabled. */
  get healthEnabled(): boolean {
    return this.config.routing.health.enabled;
  }

  /**
   * Resolve the best model config for a given task.
   */
  resolve(task: ModelTask): RoutingDecision {
    // 1. Look for a task-specific model override
    const taskModel = this.getTaskModel(task);
    if (taskModel) {
      // Check health of the task-specific provider
      if (!this.healthEnabled || this.healthTracker.isHealthy(taskModel.provider)) {
        return {
          modelConfig: taskModel,
          reason: 'config_task_specific',
          task,
        };
      }
      // Task-specific provider is unhealthy — try fallback
      if (this.config.fallback_model && this.healthTracker.isHealthy(this.config.fallback_model.provider)) {
        return {
          modelConfig: this.config.fallback_model,
          reason: 'fallback_health',
          task,
        };
      }
      // All unhealthy — still use the configured task model (let retries handle it)
      return {
        modelConfig: taskModel,
        reason: 'config_task_specific',
        task,
      };
    }

    // 2. Use primary model
    if (!this.healthEnabled || this.healthTracker.isHealthy(this.config.model.provider)) {
      return {
        modelConfig: this.config.model,
        reason: task === 'primary' ? 'config_primary' : 'fallback_not_configured',
        task,
      };
    }

    // 3. Primary unhealthy — try fallback
    if (this.config.fallback_model && this.healthTracker.isHealthy(this.config.fallback_model.provider)) {
      return {
        modelConfig: this.config.fallback_model,
        reason: 'fallback_health',
        task,
      };
    }

    // 4. Everything unhealthy — use primary anyway
    return {
      modelConfig: this.config.model,
      reason: task === 'primary' ? 'config_primary' : 'fallback_not_configured',
      task,
    };
  }

  /**
   * Resolve a task and create (or reuse) a client for it.
   */
  resolveClient(task: ModelTask): { client: ModelClient; decision: RoutingDecision } {
    const decision = this.resolve(task);
    const client = this.getOrCreateClient(decision.modelConfig);
    return { client, decision };
  }

  /**
   * Get or create a cached client for a given model config.
   * Clients are cached by a composite key of provider + name + base_url + api_key hash.
   */
  getOrCreateClient(modelConfig: ModelConfig): ModelClient {
    const key = this.configKey(modelConfig);
    let client = this.clientCache.get(key);
    if (!client) {
      if (this.clientFactory.createFromConfig) {
        client = this.clientFactory.createFromConfig(modelConfig);
      } else {
        client = this.clientFactory.createClient();
      }
      this.clientCache.set(key, client);
    }
    return client;
  }

  /**
   * Record a successful model call for health tracking.
   */
  recordSuccess(provider: string, model: string, latencyMs: number): void {
    this.healthTracker.recordEvent({
      provider,
      model,
      success: true,
      latencyMs,
      timestamp: Date.now(),
    });
  }

  /**
   * Record a failed model call for health tracking.
   */
  recordFailure(provider: string, model: string, latencyMs: number, errorCategory?: string): void {
    this.healthTracker.recordEvent({
      provider,
      model,
      success: false,
      latencyMs,
      errorCategory,
      timestamp: Date.now(),
    });
  }

  /**
   * Get health snapshot for a specific provider.
   */
  getProviderHealth(provider: string): ProviderHealthSnapshot {
    return this.healthTracker.getSnapshot(provider);
  }

  /**
   * Get health snapshots for all tracked providers.
   */
  getAllProviderHealth(): ProviderHealthSnapshot[] {
    return this.healthTracker.getAllSnapshots();
  }

  /**
   * Check if a specific provider is healthy.
   */
  isProviderHealthy(provider: string): boolean {
    return this.healthTracker.isHealthy(provider);
  }

  /**
   * Reset health data and client cache.
   */
  reset(): void {
    this.healthTracker.reset();
    this.clientCache.clear();
  }

  /**
   * Look up the task-specific model config from the routing configuration.
   */
  private getTaskModel(task: ModelTask): ModelConfig | undefined {
    switch (task) {
      case 'primary':
        return undefined; // Always falls through to config.model
      case 'fallback':
        return this.config.fallback_model;
      case 'fast':
        return this.config.fast_model;
      default:
        return undefined;
    }
  }

  private configKey(config: ModelConfig): string {
    const keyHash = createHash('sha256').update(config.api_key).digest('hex').slice(0, 8);
    return `${config.provider}:${config.name}:${config.base_url ?? ''}:${keyHash}`;
  }
}
