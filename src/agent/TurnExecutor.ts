import crypto from 'node:crypto';
import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import type { ToolCall, ModelStepResult } from '../models/ModelClient.js';
import { type ModelClient } from '../models/ModelClient.js';
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
import {
  initialRecoveryState,
  RECOVERY_LIMITS,
  type RecoveryState,
} from './types/recovery.js';
import { categorizeApiError, exponentialBackoff } from './apiRetry.js';
import { tryReactiveCompact } from './reactiveCompact.js';

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
    const primaryClient = this.modelClientFactory.createClient();
    let toolCallCount = 0;
    const recovery = initialRecoveryState();
    // Track indices of internal continuation messages (partial assistant + "Resume..."
    // prompts) so they can be stripped from promptMessages before persisting.
    const continuationIndices = new Set<number>();

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

      // --- Call model (with retry/fallback, error capture) ---
      const callResult: { result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] } =
        await this.callModelWithRecovery(
          primaryClient,
          { model: modelName, messages: context.messages, tools: toolRegistry.listDefinitions(), signal: context.signal, systemPromptBlocks, maxOutputTokens },
          recovery,
        );

      // Emit any recovery events from retry/fallback
      for (const event of callResult.events) {
        yield event;
      }

      const result = callResult.result;

      // --- Handle context overflow (413) ---
      if (result.type === 'context_overflow') {
        if (!recovery.hasAttemptedReactiveCompact) {
          const compacted = tryReactiveCompact(context.messages);
          if (compacted) {
            recovery.hasAttemptedReactiveCompact = true;
            recovery.lastTransition = { reason: 'reactive_compact_retry' };
            yield { type: 'recovery', reason: 'reactive_compact_retry' };
            continue;
          }
        }
        // Recovery exhausted
        const lastText = recovery.accumulatedText || '';
        yield { type: 'done', terminalReason: { reason: 'prompt_too_long' } };
        return {
          finalText: lastText,
          tokenUsage: context.tokenUsage,
          completedTurns: context.turnCount,
          toolCallCount,
          promptMessages: [
            { role: 'user', content: submission.userMessage },
            ...context.messages.slice(initialMessages.length),
          ],
        };
      }

      if (result.tokenUsage) {
        context.tokenUsage = result.tokenUsage;
        activeTurn?.turnState.setTokenUsage(result.tokenUsage);
      }

      // --- Handle max output truncation ---
      // Known trade-off: blind concatenation. Models sometimes repeat a few
      // tokens at seams. Accepted for v1, same as claudy.
      if (result.type === 'final_text' && result.truncated) {
        if (recovery.maxOutputRecoveryCount < RECOVERY_LIMITS.MAX_OUTPUT_RECOVERY_ATTEMPTS) {
          recovery.maxOutputRecoveryCount += 1;
          // Emit partial text immediately so callers see progress
          if (result.text) {
            yield { type: 'text_delta', content: result.text };
          }
          // Preserve the partial assistant text in the conversation for the model,
          // but mark these indices so they're excluded from persisted promptMessages.
          continuationIndices.add(context.messages.length);
          context.messages.push({ role: 'assistant', content: result.text });
          recovery.accumulatedText += result.text;
          continuationIndices.add(context.messages.length);
          context.messages.push({
            role: 'user',
            content: 'Output limit reached. Resume exactly where you stopped.',
          });
          recovery.lastTransition = {
            reason: 'max_output_recovery',
            attempt: recovery.maxOutputRecoveryCount,
          };
          yield { type: 'recovery', reason: 'max_output_recovery', detail: { attempt: recovery.maxOutputRecoveryCount } };
          continue;
        }
        // Exhausted — return what we have (accumulated + final partial)
        recovery.accumulatedText += result.text;
        if (result.text) {
          yield { type: 'text_delta', content: result.text };
        }
        yield { type: 'done', terminalReason: { reason: 'max_output_exhausted' }, tokenUsage: result.tokenUsage };
        return {
          finalText: recovery.accumulatedText,
          tokenUsage: result.tokenUsage,
          completedTurns: context.turnCount,
          toolCallCount,
          promptMessages: this.buildCleanPromptMessages(
            submission.userMessage, context.messages, initialMessages.length,
            continuationIndices, recovery.accumulatedText,
          ),
        };
      }

      // --- Normal final text ---
      if (result.type === 'final_text') {
        const fullText = recovery.accumulatedText + result.text;
        if (result.text) {
          yield { type: 'text_delta', content: result.text };
        }
        yield { type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage, terminalReason: { reason: 'completed' } };
        return {
          finalText: fullText,
          tokenUsage: result.tokenUsage,
          completedTurns: context.turnCount,
          toolCallCount,
          promptMessages: this.buildCleanPromptMessages(
            submission.userMessage, context.messages, initialMessages.length,
            continuationIndices, fullText,
          ),
        };
      }

      // --- Tool calls (normal continuation) ---
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

      recovery.lastTransition = {
        reason: 'tool_use',
        toolNames: result.calls.map(c => c.function.name),
      };
      recovery.apiRetryCount = 0;
    }

    // Max turns reached — return gracefully, do not throw.
    const lastText = recovery.accumulatedText || '';
    yield { type: 'done', terminalReason: { reason: 'max_turns' } };
    return {
      finalText: lastText,
      tokenUsage: context.tokenUsage,
      completedTurns: context.turnCount,
      toolCallCount,
      promptMessages: [
        { role: 'user', content: submission.userMessage },
        ...context.messages.slice(initialMessages.length),
      ],
    };
  }

  /**
   * Call the model with bounded retry and optional fallback.
   *
   * Returns the model result or { type: 'context_overflow' } for 413 errors.
   * Collects recovery events in a buffer (since this is not a generator).
   */
  private async callModelWithRecovery(
    primaryClient: ModelClient,
    initialRequest: Parameters<ModelClient['generate']>[0],
    recovery: RecoveryState,
  ): Promise<{ result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] }> {
    let consecutive529 = 0;
    let client = primaryClient;
    let request = initialRequest;
    const events: AgentEvent[] = [];

    for (let attempt = 0; attempt <= RECOVERY_LIMITS.MAX_API_RETRIES; attempt++) {
      try {
        const result = await client.generate(request);
        return { result, events };
      } catch (error) {
        const category = categorizeApiError(error);

        if (category === 'context_overflow') {
          return { result: { type: 'context_overflow' as const }, events };
        }

        if (category === 'overloaded') {
          consecutive529++;
          if (consecutive529 >= RECOVERY_LIMITS.FALLBACK_AFTER_CONSECUTIVE_529
              && this.config.fallback_model
              && !recovery.fallbackAttempted
              && this.modelClientFactory.createFromConfig) {
            recovery.fallbackAttempted = true;
            // Create a new client via factory — don't mutate the primary client
            client = this.modelClientFactory.createFromConfig(this.config.fallback_model);
            // Switch to the fallback model name so the client uses it
            request = { ...request, model: this.config.fallback_model.name };
            // Reset retry budget so fallback gets a full chance
            // -1 because the for-loop increment runs before the next iteration
            attempt = -1;
            consecutive529 = 0;
            recovery.lastTransition = {
              reason: 'fallback_model',
              fromModel: this.config.model.name,
              toModel: this.config.fallback_model.name,
            };
            events.push({
              type: 'recovery',
              reason: 'fallback_model',
              detail: { from: this.config.model.name, to: this.config.fallback_model.name },
            });
            continue;
          }
        }

        if ((category === 'rate_limit' || category === 'overloaded' || category === 'server_error')
            && attempt < RECOVERY_LIMITS.MAX_API_RETRIES) {
          await exponentialBackoff(attempt);
          recovery.apiRetryCount++;
          recovery.lastTransition = {
            reason: 'api_retry',
            attempt: attempt + 1,
            errorType: category,
          };
          events.push({
            type: 'recovery',
            reason: 'api_retry',
            detail: { attempt: attempt + 1, errorType: category },
          });
          continue;
        }

        throw error; // Non-retryable or retries exhausted
      }
    }

    throw new Error('api_retries_exhausted');
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

  /**
   * Build promptMessages for persisting, excluding internal continuation
   * artifacts (partial assistant texts and "Resume..." prompts).
   */
  private buildCleanPromptMessages(
    userMessage: string,
    messages: Array<Record<string, unknown>>,
    initialMessagesLength: number,
    continuationIndices: Set<number>,
    finalAssistantText: string,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [
      { role: 'user', content: userMessage },
    ];
    for (let i = initialMessagesLength; i < messages.length; i++) {
      if (!continuationIndices.has(i)) {
        result.push(messages[i]!);
      }
    }
    result.push({ role: 'assistant', content: finalAssistantText });
    return result;
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error('request_aborted');
    }
  }
}
