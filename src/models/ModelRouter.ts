import type { AgentConfig, ModelConfig } from '../config/schema.js';
import type { ModelClient } from './ModelClient.js';
import type { IModelClientFactory } from './ModelClientFactory.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';
import type {
  HealthTrackerConfig,
  ModelTask,
  RoutingDecision,
  ProviderHealthSnapshot,
} from './types.js';

/**
 * Central model routing layer.
 *
 * Resolves which model to use for a given task type by consulting:
 *   1. Task-specific model config (routing.task_models.*)
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
    healthConfig?: Partial<HealthTrackerConfig>,
  ) {
    const cfgHealth = (config as AgentConfig & { routing?: { health?: Partial<HealthTrackerConfig> } }).routing?.health;
    this.healthTracker = new ProviderHealthTracker(healthConfig ?? cfgHealth);
  }

  /**
   * Resolve the best model config for a given task.
   */
  resolve(task: ModelTask): RoutingDecision {
    // 1. Look for a task-specific model override
    const taskModel = this.getTaskModel(task);
    if (taskModel) {
      // Check health of the task-specific provider
      if (this.healthTracker.isHealthy(taskModel.provider)) {
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
    if (this.healthTracker.isHealthy(this.config.model.provider)) {
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
   * Clients are cached by a composite key of provider + name + base_url.
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
    const routing = (this.config as AgentConfig & { routing?: { task_models?: Record<string, ModelConfig> } }).routing;

    switch (task) {
      case 'primary':
        return undefined; // Always falls through to config.model
      case 'fallback':
        return this.config.fallback_model;
      case 'summary': {
        // Check routing.task_models.summary first, then context.summary.model (legacy)
        const taskModel = routing?.task_models?.summary;
        if (taskModel) return taskModel;
        // Legacy: context.summary.model is just a model name string, not a full ModelConfig
        // So we can't use it directly — return undefined to fall through to primary
        return undefined;
      }
      case 'extraction': {
        const taskModel = routing?.task_models?.extraction;
        if (taskModel) return taskModel;
        return undefined;
      }
      case 'forked': {
        const taskModel = routing?.task_models?.forked;
        if (taskModel) return taskModel;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private configKey(config: ModelConfig): string {
    return `${config.provider}:${config.name}:${config.base_url ?? ''}`;
  }
}
