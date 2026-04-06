import type { AgentConfig } from '../config/schema.js';
import { AnthropicClient } from './client/AnthropicClient.js';
import { GoogleCompletionClient } from './client/GoogleCompletionClient.js';
import { OpenAICompatibleClient } from './client/OpenAICompatibleClient.js';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient.js';
import { ModelClient } from './ModelClient.js';

const PROVIDER_BASE_URLS = {
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  together: 'https://api.together.xyz/v1',
} as const;

export class ModelClientFactory {
  private client: ModelClient | undefined;

  constructor(private readonly config: AgentConfig) {}

  /** Returns the singleton client, creating it on first call. */
  createClient(): ModelClient {
    if (this.client) {
      return this.client;
    }

    const provider = this.config.model.provider;
    const model = this.config.model.name;
    const apiKey = this.config.model.api_key;
    const baseUrl = this.config.model.base_url ?? undefined;

    if (provider === 'openai') {
      this.client = new OpenAIChatCompletionClient({
        apiKey,
        model,
        baseUrl,
      });
      return this.client;
    }

    if (provider === 'anthropic') {
      this.client = new AnthropicClient({
        apiKey,
        model,
        baseUrl,
      });
      return this.client;
    }

    if (provider === 'google-ai-studio') {
      this.client = new GoogleCompletionClient({
        apiKey,
        model,
        baseUrl,
      });
      return this.client;
    }

    if (provider === 'xai' || provider === 'groq' || provider === 'fireworks' || provider === 'together') {
      this.client = new OpenAICompatibleClient({
        apiKey,
        model,
        baseUrl: baseUrl ?? PROVIDER_BASE_URLS[provider],
      });
      return this.client;
    }

    throw new Error(`Unsupported model provider: ${provider}`);
  }
}

export interface IModelClientFactory {
  createClient(): ModelClient;
}
