import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import type { ToolCall } from '../models/ModelClient.js';
import { SystemPromptBuilder } from '../prompts/SystemPromptBuilder.js';
import { TemplateLoader } from '../prompts/TemplateLoader.js';
import type { ISystemPromptBuilder, PromptContext } from '../prompts/types.js';
import { ToolRegistry, type IToolRegistry } from '../tools/registry.js';
import type { Tool, ToolExecutionResult } from '../tools/types.js';
import { EventQueue } from './EventQueue.js';
import { TurnContext } from './TurnContext.js';
import type { AgentEvent, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';

interface TurnExecutorDeps {
  systemPromptBuilder?: ISystemPromptBuilder;
  modelClientFactory?: IModelClientFactory;
  toolRegistry?: IToolRegistry;
}

export class TurnExecutor {
  private readonly systemPromptBuilder: ISystemPromptBuilder;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly toolRegistry: IToolRegistry;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? new ToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
  }

  async execute(submission: TurnSubmission, events: EventQueue<AgentEvent>): Promise<void> {
    await this.run(submission, events);
  }

  async run(
    submission: TurnSubmission,
    events: EventQueue<AgentEvent>,
    activeTurn?: ActiveTurn,
  ): Promise<TurnExecutionResult> {
    const history = submission.promptHistory ?? submission.history.map((item) => ({
      role: item.role,
      content: item.content,
    }));

    const promptContext: PromptContext = {
      creatorName: this.config.persona.name,
      creatorDefaultSystemPrompt: this.config.persona.default_system_prompt,
      creatorSystemPromptOverride: this.config.persona.system_prompt_override ?? null,
      creatorSystemPromptAppend: this.config.persona.system_prompt_append ?? null,
      approvedToolNames: this.toolRegistry.listNames(),
      modelName: this.config.model.name,
      providerName: this.config.model.provider,
    };

    const builtPrompt = this.systemPromptBuilder.build(promptContext);

    const initialMessages = [
      { role: 'system' as const, content: builtPrompt.finalSystemPrompt.join('\n\n') },
      ...history,
      { role: 'user' as const, content: submission.userMessage },
    ];

    const context = new TurnContext(submission, initialMessages);
    const client = this.modelClientFactory.createClient();
    let toolCallCount = 0;

    while (context.turnCount < this.config.limits.max_turns) {
      this.throwIfAborted(context.signal);
      context.turnCount += 1;
      activeTurn?.turnState.beginModelTurn();

      const result = await client.generate({
        model: this.config.model.name,
        messages: context.messages,
        tools: this.toolRegistry.listDefinitions(),
        signal: context.signal,
      });

      if (result.tokenUsage) {
        context.tokenUsage = result.tokenUsage;
        activeTurn?.turnState.setTokenUsage(result.tokenUsage);
      }

      if (result.type === 'final_text') {
        const finalText = result.text ?? '';
        if (result.text) {
          events.push({ type: 'text_delta', content: result.text });
        }
        events.push({ type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage });
        return {
          finalText,
          tokenUsage: result.tokenUsage,
          completedTurns: context.turnCount,
          toolCallCount,
          promptMessages: [
            { role: 'user', content: submission.userMessage },
            ...context.messages.slice(initialMessages.length),
            { role: 'assistant', content: finalText },
          ],
        };
      }

      context.messages.push({
        role: 'assistant',
        content: null,
        toolCalls: result.calls,
      });

      for (const call of result.calls) {
        this.throwIfAborted(context.signal);
        toolCallCount += 1;
        activeTurn?.turnState.registerToolCall(call.id);
        const tool = this.toolRegistry.get(call.function.name);
        if (!tool) {
          throw new Error(`Unknown tool: ${call.function.name}`);
        }

        events.push({ type: 'tool_start', name: call.function.name, callId: call.id });
        const toolResult = await this.executeTool(call, context.conversationId, context.signal, tool);
        events.push({
          type: 'tool_end',
          name: call.function.name,
          callId: call.id,
          success: toolResult.success,
        });
        activeTurn?.turnState.resolveToolCall(call.id);

        context.messages.push({
          role: 'tool',
          content: toolResult.content,
          toolCallId: call.id,
          toolName: call.function.name,
        });
      }
    }

    throw new Error('max_turns_exceeded');
  }

  private async executeTool(
    call: ToolCall,
    conversationId: string,
    signal: AbortSignal | undefined,
    tool: Tool,
  ): Promise<ToolExecutionResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return { success: false, content: `Invalid arguments for tool ${call.function.name}.` };
    }
    return tool.execute(args, { conversationId, signal });
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error('request_aborted');
    }
  }
}
