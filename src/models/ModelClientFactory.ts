import type { AgentConfig, ModelConfig } from '../config/schema.js';
import { AnthropicClient } from './client/AnthropicClient.js';
import { GoogleCompletionClient } from './client/GoogleCompletionClient.js';
import { OpenAICompatibleClient } from './client/OpenAICompatibleClient.js';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient.js';
import { ModelClient } from './ModelClient.js';
import { ModelRouter } from './ModelRouter.js';
import type { ModelTask, RoutingDecision } from './types.js';

const PROVIDER_BASE_URLS: Record<string, string> = {
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  together: 'https://api.together.xyz/v1',
};

export function createClientFromModelConfig(modelConfig: ModelConfig): ModelClient {
  const provider = modelConfig.provider;
  const model = modelConfig.name;
  const apiKey = modelConfig.api_key;
  const baseUrl = modelConfig.base_url ?? undefined;

  if (provider === 'openai') {
    return new OpenAIChatCompletionClient({ apiKey, model, baseUrl });
  }

  if (provider === 'anthropic') {
    return new AnthropicClient({ apiKey, model, baseUrl });
  }

  if (provider === 'google-ai-studio') {
    return new GoogleCompletionClient({ apiKey, model, baseUrl });
  }

  if (provider === 'xai' || provider === 'groq' || provider === 'fireworks' || provider === 'together') {
    return new OpenAICompatibleClient({
      apiKey,
      model,
      baseUrl: baseUrl ?? PROVIDER_BASE_URLS[provider],
    });
  }

  throw new Error(`Unsupported model provider: ${provider}`);
}

export class ModelClientFactory {
  private client: ModelClient | undefined;
  private router: ModelRouter | undefined;

  constructor(private readonly config: AgentConfig) {}

  /** Returns the singleton client, creating it on first call. */
  createClient(): ModelClient {
    if (this.client) {
      return this.client;
    }
    this.client = createClientFromModelConfig(this.config.model);
    return this.client;
  }

  /** Creates a fresh (non-singleton) client from an arbitrary model config. */
  createFromConfig(modelConfig: ModelConfig): ModelClient {
    return createClientFromModelConfig(modelConfig);
  }

  /**
   * Returns a ModelRouter instance, creating it on first call.
   * The router uses this factory for client creation and caches clients.
   */
  getRouter(): ModelRouter {
    if (this.router) {
      return this.router;
    }
    this.router = new ModelRouter(this.config, this);
    return this.router;
  }
}

export interface IModelClientFactory {
  createClient(): ModelClient;
  createFromConfig?(modelConfig: ModelConfig): ModelClient;
  getRouter?(): ModelRouter;
}

export type { ModelTask, RoutingDecision };
