import type {
  CompletionRequest,
  ModelStepResult,
  TokenUsage,
  ToolCall,
} from '../ModelClient.js';
import { ModelClient } from '../ModelClient.js';

interface OpenAICompatibleClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class OpenAICompatibleClient extends ModelClient {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private client: any | undefined;

  constructor(config: OpenAICompatibleClientConfig) {
    super();
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: request.model || this.model,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
        tool_call_id: message.toolCallId,
      })) as any,
      tools: request.tools?.map((tool) => ({
        type: 'function',
        function: tool.function,
      })) as any,
    }, {
      signal: request.signal,
    });

    const choice = response.choices[0];
    if (!choice?.message) {
      throw new Error('Model returned no message');
    }

    const thinkingTokens = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const usage: TokenUsage | undefined = response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
    } : undefined;

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      const calls: ToolCall[] = choice.message.tool_calls
        .filter((toolCall: any): toolCall is { id: string; type: 'function'; function: { name: string; arguments: string } } => toolCall.type === 'function')
        .map((toolCall: any) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        }));
      return { type: 'tool_calls', calls, tokenUsage: usage };
    }

    return {
      type: 'final_text',
      text: typeof choice.message.content === 'string' ? choice.message.content : '',
      truncated: choice.finish_reason === 'length',
      tokenUsage: usage,
    };
  }

  private async getClient() {
    if (this.client) {
      return this.client;
    }

    const module = await import('openai');
    // Handle both ESM default export shapes: { default: class } and { default: { default: class } }
    const OpenAI = (typeof module.default === 'function' ? module.default : (module.default as any).default) as new (opts: { apiKey: string; baseURL?: string }) => any;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
    });
    return this.client;
  }
}
