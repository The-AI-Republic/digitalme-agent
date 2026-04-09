import crypto from 'node:crypto';
import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import type { ToolCall } from '../models/ModelClient.js';
import { SystemPromptBuilder } from '../prompts/SystemPromptBuilder.js';
import { TemplateLoader } from '../prompts/TemplateLoader.js';
import type { ISystemPromptBuilder, PromptContext } from '../prompts/types.js';
import { ToolRegistry, type IToolRegistry } from '../tools/registry.js';
import type { Tool, ToolExecutionResult } from '../tools/types.js';
import { TurnContext } from './TurnContext.js';
import type { AgentEvent, ExecutionOptions, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';
import { prepareContextForModelCall, type PrepareContextDeps } from './context/prepareContextForModelCall.js';
import { TokenBudget } from './context/TokenBudget.js';
import { ToolResultPersistence } from './context/ToolResultPersistence.js';
import { Microcompact } from './context/Microcompact.js';

interface TurnExecutorDeps {
  systemPromptBuilder?: ISystemPromptBuilder;
  modelClientFactory?: IModelClientFactory;
  toolRegistry?: IToolRegistry;
  contextDeps?: PrepareContextDeps;
}

export class TurnExecutor {
  private readonly systemPromptBuilder: ISystemPromptBuilder;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly toolRegistry: IToolRegistry;
  private readonly contextDeps: PrepareContextDeps;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? new ToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
    this.contextDeps = deps.contextDeps ?? this.buildDefaultContextDeps();
  }

  private buildDefaultContextDeps(): PrepareContextDeps {
    const ctx = this.config.context;
    return {
      tokenBudget: new TokenBudget({
        modelMetadata: Object.fromEntries(
          Object.entries(ctx.model_metadata).map(([k, v]) => [k, {
            contextWindowSize: v.context_window_size,
            maxOutputTokens: v.max_output_tokens,
          }]),
        ),
        defaultContextWindowSize: ctx.default_context_window_size,
        defaultMaxOutputTokens: ctx.default_max_output_tokens,
        microcompactRatio: ctx.thresholds.microcompact_ratio,
        projectionRatio: ctx.thresholds.projection_ratio,
        overflowRatio: ctx.thresholds.overflow_ratio,
        safetyMargin: ctx.thresholds.safety_margin,
      }),
      toolResultPersistence: new ToolResultPersistence({
        defaultMaxResultChars: ctx.tool_result_persistence.default_max_result_chars,
        perMessageBudgetChars: ctx.tool_result_persistence.per_message_budget_chars,
        previewSizeBytes: ctx.tool_result_persistence.preview_size_bytes,
        storageDir: ctx.tool_result_persistence.storage_dir,
      }),
      microcompact: new Microcompact({
        gapThresholdMinutes: ctx.microcompact.gap_threshold_minutes,
        keepRecentResults: ctx.microcompact.keep_recent_results,
        compactableTools: new Set(['web_search']),
        clearedMarker: '[Previous tool output cleared]',
      }),
    };
  }

  async *run(
    submission: TurnSubmission,
    options?: ExecutionOptions,
    activeTurn?: ActiveTurn,
  ): AsyncGenerator<AgentEvent, TurnExecutionResult> {
    const maxTurns = options?.maxTurns ?? this.config.limits.max_turns;
    const maxOutputTokens = options?.maxOutputTokens ?? this.config.model.max_output_tokens;
    const modelName = options?.model ?? this.config.model.name;
    const toolRegistry = options?.toolRegistry ?? this.toolRegistry;

    const history = submission.promptHistory ?? submission.history.map((item) => ({
      role: item.role,
      content: item.content,
    }));

    const promptContext: PromptContext = {
      soulName: this.config.soul.name,
      soulDescription: this.config.soul.description,
      soulTone: this.config.soul.tone ?? null,
      soulBoundaries: this.config.soul.boundaries ?? null,
      soulKnowledge: this.config.soul.knowledge ?? null,
      soulOthers: this.config.soul.others ?? null,
      soulSystemPromptOverride: this.config.soul.system_prompt_override ?? null,
      soulSystemPromptAppend: this.config.soul.system_prompt_append ?? null,
      approvedToolNames: toolRegistry.listNames(),
      modelName,
      providerName: this.config.model.provider,
    };

    const builtPrompt = this.systemPromptBuilder.build(promptContext);

    const systemPromptBlocks = builtPrompt.sections.map((s) => ({
      text: s.content,
      cachePolicy: s.cachePolicy,
    }));

    const initialMessages = [
      { role: 'system' as const, content: builtPrompt.finalSystemPrompt.join('\n\n') },
      ...history,
      { role: 'user' as const, content: submission.userMessage, id: crypto.randomUUID(), timestamp: new Date().toISOString() },
    ];

    const context = new TurnContext(submission, initialMessages);
    const client = this.modelClientFactory.createClient();
    let toolCallCount = 0;

    while (context.turnCount < maxTurns) {
      this.throwIfAborted(context.signal);
      context.turnCount += 1;
      activeTurn?.turnState.beginModelTurn();

      // Per-model-step context preparation: persistence, microcompact, pressure assessment
      const prepared = await prepareContextForModelCall(
        context.messages,
        modelName,
        context.tokenUsage,
        context.conversationId,
        this.contextDeps,
      );
      // Replace messages with prepared version (may have cleared stale tool results)
      if (prepared.rewrote) {
        context.messages.length = 0;
        context.messages.push(...prepared.messages);
      }

      const result = await client.generate({
        model: modelName,
        messages: context.messages,
        tools: toolRegistry.listDefinitions(),
        signal: context.signal,
        systemPromptBlocks,
        maxOutputTokens,
      });

      if (result.tokenUsage) {
        context.tokenUsage = result.tokenUsage;
        activeTurn?.turnState.setTokenUsage(result.tokenUsage);
      }

      if (result.type === 'final_text') {
        const finalText = result.text ?? '';
        if (result.text) {
          yield { type: 'text_delta', content: result.text };
        }
        yield { type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage };
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
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      });

      for (const call of result.calls) {
        this.throwIfAborted(context.signal);
        toolCallCount += 1;
        activeTurn?.turnState.registerToolCall(call.id);
        const tool = toolRegistry.get(call.function.name);
        if (!tool) {
          throw new Error(`Unknown tool: ${call.function.name}`);
        }

        yield { type: 'tool_start', name: call.function.name, callId: call.id };
        const toolResult = await this.executeTool(call, context.conversationId, context.signal, tool);
        yield {
          type: 'tool_end',
          name: call.function.name,
          callId: call.id,
          success: toolResult.success,
        };
        activeTurn?.turnState.resolveToolCall(call.id);

        context.messages.push({
          role: 'tool',
          content: toolResult.content,
          toolCallId: call.id,
          toolName: call.function.name,
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
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
