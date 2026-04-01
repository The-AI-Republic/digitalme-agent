import { OpenAICompatibleClient } from './OpenAICompatibleClient.js';

interface OpenAIChatCompletionClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class OpenAIChatCompletionClient extends OpenAICompatibleClient {
  constructor(config: OpenAIChatCompletionClientConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    });
  }
}
