import crypto from 'node:crypto';
import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import { SystemPromptBuilder } from '../prompts/SystemPromptBuilder.js';
import { TemplateLoader } from '../prompts/TemplateLoader.js';
import type { ISystemPromptBuilder, PromptContext } from '../prompts/types.js';
import { createToolRegistry, type IToolRegistry } from '../tools/registry.js';
import { ToolExecutor, type ToolExecutorCallbacks } from '../tools/execution/ToolExecutor.js';
import { DefaultToolPolicyChecker, type IToolPolicyChecker } from '../tools/execution/ToolPolicyChecker.js';
import { ResultBudget } from '../tools/execution/ResultBudget.js';
import { TurnContext } from './TurnContext.js';
import type { AgentEvent, ExecutionOptions, ToolSummaryEntry, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';
import { prepareContextForModelCall, type PrepareContextDeps } from './context/prepareContextForModelCall.js';
import { TokenBudget } from './context/TokenBudget.js';
import { ToolResultPersistence } from './context/ToolResultPersistence.js';
import { Microcompact } from './context/Microcompact.js';

/** Shared signal that never fires — avoids per-call AbortController allocation. */
const NEVER_ABORT = new AbortController().signal;

interface TurnExecutorDeps {
  systemPromptBuilder?: ISystemPromptBuilder;
  modelClientFactory?: IModelClientFactory;
  toolRegistry?: IToolRegistry;
  toolPolicyChecker?: IToolPolicyChecker;
  toolExecutor?: ToolExecutor;
  contextDeps?: PrepareContextDeps;
}

export class TurnExecutor {
  private readonly systemPromptBuilder: ISystemPromptBuilder;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly toolRegistry: IToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly policyChecker: IToolPolicyChecker;
  private readonly contextDeps: PrepareContextDeps;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? createToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
    this.policyChecker = deps.toolPolicyChecker ?? new DefaultToolPolicyChecker();
    this.toolExecutor = deps.toolExecutor ?? new ToolExecutor(this.toolRegistry, this.policyChecker);
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
    const toolSummaries: ToolSummaryEntry[] = [];
    const resultBudget = new ResultBudget(); // fresh per request

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
          toolSummaries,
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

      // Delegate all tool execution to ToolExecutor
      const toolContext = {
        conversationId: context.conversationId,
        signal: context.signal ?? NEVER_ABORT,
        policyConfig: {},
      };

      // Collect events in real-time order via callbacks, replay after await
      type ToolEvent =
        | { type: 'tool_start'; name: string; callId: string }
        | { type: 'tool_end'; name: string; callId: string; success: boolean };
      const eventLog: ToolEvent[] = [];

      const callbacks: ToolExecutorCallbacks = {
        onToolStart: (name, callId) => {
          activeTurn?.turnState.registerToolCall(callId);
          eventLog.push({ type: 'tool_start', name, callId });
        },
        onToolEnd: (name, callId, success) => {
          activeTurn?.turnState.resolveToolCall(callId);
          eventLog.push({ type: 'tool_end', name, callId, success });
        },
      };

      // Use a scoped ToolExecutor when toolRegistry is overridden (e.g. SubagentTool)
      // so the executor resolves tools from the same registry the model sees.
      const activeExecutor = (toolRegistry === this.toolRegistry)
        ? this.toolExecutor
        : new ToolExecutor(toolRegistry, this.policyChecker);
      const records = await activeExecutor.runTools(
        result.calls, toolContext, resultBudget, callbacks,
      );

      // Yield events in the order they actually fired during execution.
      // Note: events are replayed after runTools() completes, not during execution.
      // This is an inherent limitation of async generators — the generator cannot
      // yield while awaiting runTools(). The eventLog preserves callback-order
      // semantics (completion order for concurrent tools), but consumers see all
      // events batched after execution rather than truly interleaved.
      for (const event of eventLog) {
        yield event;
      }

      // Collect summaries and push results to message history
      for (const record of records) {
        toolCallCount += 1;
        toolSummaries.push({
          callId: record.callId,
          toolName: record.toolName,
          summary: record.summary,
          durationMs: record.durationMs,
          success: record.result.success,
        });
        context.messages.push({
          role: 'tool',
          content: record.modelContent,
          toolCallId: record.callId,
          toolName: record.toolName,
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
      }
    }

    throw new Error('max_turns_exceeded');
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error('request_aborted');
    }
  }
}
