import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import { generateId, type Message, type ToolCall, type ModelStepResult, type ModelClient } from '../models/ModelClient.js';
import type { ModelRouter } from '../models/ModelRouter.js';
import { SystemPromptBuilder } from '../prompts/SystemPromptBuilder.js';
import { TemplateLoader } from '../prompts/TemplateLoader.js';
import type { ISystemPromptBuilder, PromptContext } from '../prompts/types.js';
import { createToolRegistry, type IToolRegistry } from '../tools/registry.js';
import { ToolExecutor, type ToolExecutorCallbacks } from '../tools/execution/ToolExecutor.js';
import { DefaultToolPolicyChecker, type IToolPolicyChecker } from '../tools/execution/ToolPolicyChecker.js';
import { ResultBudget } from '../tools/execution/ResultBudget.js';
import { TurnContext } from './TurnContext.js';
import { TurnExecutionState } from './TurnExecutionState.js';
import type { AgentEvent, ExecutionOptions, ToolSummaryEntry, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';
import { EventQueue } from './EventQueue.js';
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
import type { ITranscriptRecorder } from './transcript/types.js';

/** Shared signal that never fires — avoids per-call AbortController allocation. */
const NEVER_ABORT = new AbortController().signal;

/** Wraps a provider error with buffered recovery events for safe propagation. */
class RecoveryError extends Error {
  override readonly name = 'RecoveryError';
  constructor(
    public readonly cause: unknown,
    public readonly recoveryEvents: AgentEvent[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export interface TurnExecutorDeps {
  systemPromptBuilder?: ISystemPromptBuilder;
  modelClientFactory?: IModelClientFactory;
  modelRouter?: ModelRouter;
  toolRegistry?: IToolRegistry;
  toolPolicyChecker?: IToolPolicyChecker;
  toolExecutor?: ToolExecutor;
  contextDeps?: PrepareContextDeps;
  transcriptRecorder?: ITranscriptRecorder;
}

export class TurnExecutor {
  private readonly systemPromptBuilder: ISystemPromptBuilder;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly modelRouter?: ModelRouter;
  private readonly toolRegistry: IToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly policyChecker: IToolPolicyChecker;
  private readonly contextDeps: PrepareContextDeps;
  private readonly transcriptRecorder?: ITranscriptRecorder;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? createToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
    this.policyChecker = deps.toolPolicyChecker ?? new DefaultToolPolicyChecker();
    this.toolExecutor = deps.toolExecutor ?? new ToolExecutor(this.toolRegistry, this.policyChecker);
    this.contextDeps = deps.contextDeps ?? this.buildDefaultContextDeps();
    this.transcriptRecorder = deps.transcriptRecorder;
    // Initialize router: prefer explicit dep, then factory's getRouter, otherwise undefined
    this.modelRouter = deps.modelRouter ?? this.modelClientFactory.getRouter?.();
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
    const recorder = this.transcriptRecorder;

    const executionState = activeTurn?.executionState ?? new TurnExecutionState();

    // Resolve the model before prompt construction so the prompt can reference the resolved model
    let resolvedModelName = modelName;
    let resolvedProvider = this.config.model.provider;
    let primaryClient: ModelClient;
    if (this.modelRouter) {
      const { client, decision } = this.modelRouter.resolveClient('primary');
      primaryClient = client;
      resolvedModelName = decision.modelConfig.name;
      resolvedProvider = decision.modelConfig.provider;
    } else {
      primaryClient = this.modelClientFactory.createClient();
    }

    const history = submission.promptHistory ?? submission.history.map((item) => ({
      role: item.role as Message['role'],
      content: item.content,
      id: generateId(),
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
      modelName: resolvedModelName,
      providerName: resolvedProvider,
    };

    const builtPrompt = this.systemPromptBuilder.build(promptContext);

    const systemPromptBlocks = builtPrompt.sections.map((s) => ({
      text: s.content,
      cachePolicy: s.cachePolicy,
    }));

    // Initial messages: system prompt + prior history only (no user message yet)
    const initialMessages = [
      { role: 'system' as const, content: builtPrompt.finalSystemPrompt.join('\n\n'), id: generateId() },
      ...history,
    ];

    const context = new TurnContext(submission, initialMessages);
    const recovery = initialRecoveryState();
    const toolSummaries: ToolSummaryEntry[] = [];
    const resultBudget = new ResultBudget(); // fresh per request

    // Record baseline before pushing user message
    const baselineLength = context.messages.length;

    // Push user message after baseline
    const userMsg: Message = {
      role: 'user',
      content: submission.userMessage,
      id: generateId(),
      timestamp: new Date().toISOString(),
    };
    context.messages.push(userMsg);

    // Dual write: record user message to transcript
    if (recorder) {
      await recorder.recordMessage(submission.conversationId, userMsg, {
        taskId: submission.requestId,
        turnId: activeTurn?.turnId,
      });
    }

    while (executionState.getIterationIndex() < maxTurns) {
      this.throwIfAborted(context.signal);
      executionState.incrementIteration();
      executionState.beginModelTurn();

      // Per-model-step context preparation: persistence, microcompact, pressure assessment
      const prepared = await prepareContextForModelCall(
        context.messages,
        modelName,
        executionState.getTokenUsage(),
        context.conversationId,
        this.contextDeps,
      );
      // Replace messages with prepared version (may have cleared stale tool results)
      if (prepared.rewrote) {
        context.messages.length = 0;
        context.messages.push(...prepared.messages);
      }

      // --- Call model (with retry/fallback, error capture) ---
      let callResult: { result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] };
      try {
        callResult = await this.callModelWithRecovery(
          primaryClient,
          { model: resolvedModelName, messages: context.messages, tools: toolRegistry.listDefinitions(), signal: context.signal, systemPromptBlocks, maxOutputTokens },
          recovery,
          resolvedProvider,
        );
      } catch (error) {
        // Emit any buffered recovery events before propagating the original error
        if (error instanceof RecoveryError) {
          for (const event of error.recoveryEvents) {
            yield event;
          }
          throw error.cause;
        }
        throw error;
      }

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
          tokenUsage: executionState.getTokenUsage(),
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          newMessages: context.messages.slice(baselineLength),
        };
      }

      if (result.tokenUsage) {
        executionState.setTokenUsage(result.tokenUsage);
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
          // Preserve the partial assistant text in the conversation for the model
          context.messages.push({ role: 'assistant', content: result.text, id: generateId(), timestamp: new Date().toISOString() });
          recovery.accumulatedText += result.text;
          context.messages.push({
            role: 'user',
            content: 'Output limit reached. Resume exactly where you stopped.',
            id: generateId(),
            timestamp: new Date().toISOString(),
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
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          newMessages: context.messages.slice(baselineLength),
        };
      }

      // --- Normal final text ---
      if (result.type === 'final_text') {
        const fullText = recovery.accumulatedText + result.text;

        // Push final assistant message to context
        const finalMsg: Message = {
          role: 'assistant',
          content: fullText,
          id: generateId(),
          timestamp: new Date().toISOString(),
        };
        context.messages.push(finalMsg);

        // Dual write: record final assistant message
        if (recorder) {
          await recorder.recordMessage(submission.conversationId, finalMsg, {
            taskId: submission.requestId,
            turnId: activeTurn?.turnId,
          });
        }

        if (result.text) {
          yield { type: 'text_delta', content: result.text };
        }
        yield { type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage, terminalReason: { reason: 'completed' } };
        return {
          finalText: fullText,
          tokenUsage: result.tokenUsage,
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          toolSummaries,
          newMessages: context.messages.slice(baselineLength),
        };
      }

      // --- Tool calls (normal continuation) ---
      const assistantMsg: Message = {
        role: 'assistant',
        content: null,
        toolCalls: result.calls,
        id: generateId(),
        timestamp: new Date().toISOString(),
      };
      context.messages.push(assistantMsg);

      // Dual write: record assistant tool-call message
      if (recorder) {
        await recorder.recordMessage(submission.conversationId, assistantMsg, {
          taskId: submission.requestId,
          turnId: activeTurn?.turnId,
        });
      }

      // Delegate all tool execution to ToolExecutor
      const toolContext = {
        conversationId: context.conversationId,
        signal: context.signal ?? NEVER_ABORT,
        policyConfig: {},
      };

      const toolEvents = new EventQueue<AgentEvent>();
      const emittedToolStart = new Set<string>();
      const emittedToolEnd = new Set<string>();

      const callbacks: ToolExecutorCallbacks = {
        onToolStart: (name, callId) => {
          executionState.registerToolCall(callId);
          emittedToolStart.add(callId);
          toolEvents.push({ type: 'tool_start', name, callId });
        },
        onToolEnd: (name, callId, success) => {
          executionState.resolveToolCall(callId);
          emittedToolEnd.add(callId);
          toolEvents.push({ type: 'tool_end', name, callId, success });
        },
      };

      // Use a scoped ToolExecutor when toolRegistry is overridden (e.g. SubagentTool)
      // so the executor resolves tools from the same registry the model sees.
      const activeExecutor = (toolRegistry === this.toolRegistry)
        ? this.toolExecutor
        : new ToolExecutor(toolRegistry, this.policyChecker);
      const recordsPromise = activeExecutor.runTools(
        result.calls, toolContext, resultBudget, callbacks,
      ).finally(() => toolEvents.close());

      for await (const event of toolEvents) {
        yield event;
      }

      const records = await recordsPromise;

      // Collect summaries and push results to message history.
      // Pre-execution failures do not emit callbacks, so emit their terminal events here.
      for (const record of records) {
        toolSummaries.push({
          callId: record.callId,
          toolName: record.toolName,
          summary: record.summary,
          durationMs: record.durationMs,
          success: record.result.success,
        });
        if (!emittedToolStart.has(record.callId)) {
          yield { type: 'tool_start', name: record.toolName, callId: record.callId };
        }
        if (!emittedToolEnd.has(record.callId)) {
          yield {
            type: 'tool_end',
            name: record.toolName,
            callId: record.callId,
            success: record.result.success,
          };
        }
        // Process through ToolResultPersistence for artifact externalization
        let resultContent = record.modelContent;
        let artifactRef: { filePath: string; originalSize: number; preview: string } | undefined;
        const persistence = this.contextDeps.toolResultPersistence;
        if (persistence) {
          const persisted = await persistence.processResultWithRef(
            record.toolName,
            record.callId,
            record.modelContent,
            context.conversationId,
          );
          resultContent = persisted.content;
          artifactRef = persisted.artifactRef;
        }

        const toolMsg: Message = {
          role: 'tool',
          content: resultContent,
          toolCallId: record.callId,
          toolName: record.toolName,
          id: generateId(),
          timestamp: new Date().toISOString(),
        };
        context.messages.push(toolMsg);

        // Dual write: record tool result with parentOverride pointing to spawning assistant
        if (recorder) {
          await recorder.recordMessage(submission.conversationId, toolMsg, {
            taskId: submission.requestId,
            turnId: activeTurn?.turnId,
            parentOverride: assistantMsg.id,
            artifactRef,
          });
        }
      }

      recovery.lastTransition = {
        reason: 'tool_use',
        toolNames: result.calls.map(c => c.function.name),
      };
    }

    // Max turns reached — return gracefully, do not throw.
    const lastText = recovery.accumulatedText || '';
    yield { type: 'done', terminalReason: { reason: 'max_turns' } };
    return {
      finalText: lastText,
      tokenUsage: executionState.getTokenUsage(),
      completedTurns: executionState.getIterationIndex(),
      toolCallCount: executionState.snapshot().toolCallCount,
      newMessages: context.messages.slice(baselineLength),
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
    provider?: string,
  ): Promise<{ result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] }> {
    let consecutive529 = 0;
    let client = primaryClient;
    let request = initialRequest;
    let currentProvider = provider ?? this.config.model.provider;
    const events: AgentEvent[] = [];

    for (let attempt = 0; attempt <= RECOVERY_LIMITS.MAX_API_RETRIES; attempt++) {
      const startTime = Date.now();
      try {
        const result = await client.generate(request);
        // Record success for health tracking
        this.modelRouter?.recordSuccess(currentProvider, request.model, Date.now() - startTime);
        return { result, events };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        const category = categorizeApiError(error);

        // Record failure for health tracking
        this.modelRouter?.recordFailure(currentProvider, request.model, latencyMs, category);

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
            if (this.modelRouter) {
              client = this.modelRouter.getOrCreateClient(this.config.fallback_model);
            } else {
              client = this.modelClientFactory.createFromConfig(this.config.fallback_model);
            }
            currentProvider = this.config.fallback_model.provider;
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

        // Wrap in a RecoveryError so buffered events reach the caller
        throw new RecoveryError(error, events);
      }
    }

    throw new RecoveryError(new Error('api_retries_exhausted'), events);
  }

  /** Returns the ModelRouter if available, for health inspection. */
  getRouter(): ModelRouter | undefined {
    return this.modelRouter;
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error('request_aborted');
    }
  }
}
