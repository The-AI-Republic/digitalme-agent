import type {
  CompletionRequest,
  Message,
  ModelStepResult,
  TokenUsage,
  ToolCall,
} from '../ModelClient.js';
import { ModelClient } from '../ModelClient.js';

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

// TODO: Replace these local type stubs with SDK types (TextBlockParam, MessageParam)
// once the Anthropic SDK ESM import issue with ts-node is resolved.
// The SDK is dynamically imported in getClient() to work around the load-time crash.
type TextBlockParam = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type AnthropicMessageParam = { role: 'user' | 'assistant'; content: string | any[] };

export class AnthropicClient extends ModelClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl?: string;
  private client: any | undefined;

  constructor(config: AnthropicClientConfig) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
  }

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    const client = await this.getClient();
    const system = this.buildSystemBlocks(request);
    const messages = this.buildMessages(request.messages);

    const response = await client.messages.create({
      model: request.model || this.model,
      max_tokens: request.maxOutputTokens ?? 8192,
      system,
      messages,
      ...(request.tools && request.tools.length > 0 ? {
        tools: request.tools.map((tool: any) => ({
          name: tool.function.name,
          description: tool.function.description ?? '',
          input_schema: tool.function.parameters,
        })),
      } : {}),
    }, {
      signal: request.signal ?? undefined,
    });

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_calls', calls: toolCalls, tokenUsage: usage };
    }

    return {
      type: 'final_text',
      text: textParts.join(''),
      truncated: response.stop_reason === 'max_tokens',
      tokenUsage: usage,
    };
  }

  /**
   * Builds system prompt as TextBlockParam[] with cache_control on stable blocks.
   * If systemPromptBlocks is provided, each block gets its own TextBlockParam
   * with cache_control: { type: 'ephemeral' } for stable sections.
   * Otherwise falls back to extracting system messages as a single block.
   */
  buildSystemBlocks(request: CompletionRequest): TextBlockParam[] {
    if (request.systemPromptBlocks && request.systemPromptBlocks.length > 0) {
      return request.systemPromptBlocks.map((block) => ({
        type: 'text' as const,
        text: block.text,
        ...(block.cachePolicy === 'stable'
          ? { cache_control: { type: 'ephemeral' as const } }
          : {}),
      }));
    }

    // Fallback: extract system messages and send as a single uncached block
    const systemContent = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .join('\n\n');

    if (!systemContent) return [];
    return [{ type: 'text', text: systemContent }];
  }

  buildMessages(messages: Message[]): AnthropicMessageParam[] {
    const result: AnthropicMessageParam[] = [];

    for (const message of messages) {
      if (message.role === 'system') continue;

      if (message.role === 'tool') {
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? '',
            content: message.content ?? '',
          }],
        });
        continue;
      }

      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        const content: any[] = [];
        if (message.content) {
          content.push({ type: 'text', text: message.content });
        }
        for (const call of message.toolCalls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: JSON.parse(call.function.arguments || '{}'),
          });
        }
        result.push({ role: 'assistant', content });
        continue;
      }

      result.push({
        role: message.role as 'user' | 'assistant',
        content: message.content ?? '',
      });
    }

    return result;
  }

  private async getClient() {
    if (this.client) {
      return this.client;
    }

    const module = await import('@anthropic-ai/sdk');
    const Anthropic = (typeof module.default === 'function'
      ? module.default
      : (module.default as any).default) as new (opts: { apiKey: string; baseURL?: string }) => any;
    this.client = new Anthropic({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
    });
    return this.client;
  }
}
