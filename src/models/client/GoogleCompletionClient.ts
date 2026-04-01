import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclarationSchema,
  type FunctionDeclarationsTool,
  type Part,
} from '@google/generative-ai';

import type {
  CompletionRequest,
  Message,
  ModelStepResult,
  TokenUsage,
  ToolCall,
} from '../ModelClient.js';
import { ModelClient } from '../ModelClient.js';

interface GoogleCompletionClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class GoogleCompletionClient extends ModelClient {
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: string;
  private readonly baseUrl?: string;
  private callCounter = 0;

  constructor(config: GoogleCompletionClientConfig) {
    super();
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.model;
    this.baseUrl = config.baseUrl;
  }

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    const messages = request.messages;

    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .join('\n\n');

    const tools = this.buildTools(request);

    const genModel = this.genAI.getGenerativeModel(
      {
        model: request.model || this.model,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools } : {}),
      },
      {
        apiVersion: 'v1beta',
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      },
    );

    const contents = this.buildContents(messages.filter((m) => m.role !== 'system'));

    const result = await genModel.generateContent(
      { contents },
      { signal: request.signal },
    );

    const response = result.response;
    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('Model returned no message');
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of candidate.content.parts) {
      if (part.text) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `google_call_${++this.callCounter}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }

    const usage: TokenUsage | undefined = response.usageMetadata ? {
      inputTokens: response.usageMetadata.promptTokenCount,
      outputTokens: response.usageMetadata.candidatesTokenCount,
      totalTokens: response.usageMetadata.totalTokenCount,
    } : undefined;

    if (toolCalls.length > 0) {
      return { type: 'tool_calls', calls: toolCalls, tokenUsage: usage };
    }

    return {
      type: 'final_text',
      text: textParts.join(''),
      tokenUsage: usage,
    };
  }

  private buildTools(request: CompletionRequest): FunctionDeclarationsTool[] | undefined {
    if (!request.tools || request.tools.length === 0) {
      return undefined;
    }
    return [{
      functionDeclarations: request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as unknown as FunctionDeclarationSchema,
      })),
    }];
  }

  buildContents(messages: Message[]): Content[] {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user' as const,
          parts: [{
            functionResponse: {
              name: message.toolName ?? 'tool',
              response: {
                content: message.content ?? '',
              },
            },
          }],
        };
      }

      return {
        role: (message.role === 'assistant' ? 'model' : 'user') as string,
        parts: this.buildParts(message),
      };
    });
  }

  private buildParts(message: Message): Part[] {
    const parts: Part[] = [];
    if (message.content) {
      parts.push({ text: message.content });
    }
    for (const toolCall of message.toolCalls ?? []) {
      parts.push({
        functionCall: {
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>,
        },
      });
    }
    return parts;
  }
}
