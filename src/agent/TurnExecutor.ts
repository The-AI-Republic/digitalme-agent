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
import type { ITranscriptRecorder, CompactCompletedEntry } from './transcript/types.js';
import {
  startInteractionSpan,
  startModelCallSpan,
  endSpan,
  endSpanWithError,
} from '../telemetry/spans.js';
import {
  recordTurnCompleted,
  recordModelCall,
  recordTokens,
  recordToolCall,
  recordError,
} from '../telemetry/metrics.js';
import type { Span, SpanContext } from '@opentelemetry/api';
import { UsageRecorder } from '../usage/UsageRecorder.js';
import { ConversationUsageTracker } from '../usage/ConversationUsageTracker.js';
import { CostAwareRouter } from '../usage/CostAwareRouter.js';
import type { UsageAggregator } from '../usage/UsageAggregator.js';
import { screenInput } from '../guardrails/InputScreener.js';
import { validateOutput } from '../guardrails/OutputValidator.js';

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
  usageAggregator?: UsageAggregator;
  skillListing?: string | null;
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
  private readonly costAwareRouter?: CostAwareRouter;
  private readonly usageAggregator?: UsageAggregator;
  private readonly skillListing: string | null;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? createToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
    this.policyChecker = deps.toolPolicyChecker ?? new DefaultToolPolicyChecker();
    this.toolExecutor = deps.toolExecutor ?? new ToolExecutor(this.toolRegistry, this.policyChecker);
    this.contextDeps = deps.contextDeps ?? this.buildDefaultContextDeps();
    this.transcriptRecorder = deps.transcriptRecorder;
    this.usageAggregator = deps.usageAggregator;
    this.skillListing = deps.skillListing ?? null;
    // Only auto-enable router behavior when task-specific routing is configured.
    // This preserves existing fallback_model semantics for configs that have only
    // schema-default routing values.
    this.modelRouter = deps.modelRouter
      ?? (this.hasTaskSpecificRouting() ? this.modelClientFactory.getRouter?.() : undefined);

    // Initialize cost-aware routing if quotas are enabled
    const quotas = config.quotas;
    if (quotas?.enabled) {
      this.costAwareRouter = new CostAwareRouter({
        quotaConfig: {
          quota: {
            maxCostPerConversation: quotas.max_cost_per_conversation_usd,
            maxCostPerDay: quotas.max_cost_per_day_usd,
            maxCostPerMonth: quotas.max_cost_per_month_usd,
            maxTokensPerConversation: quotas.max_tokens_per_conversation,
            maxTurnsPerConversation: quotas.max_turns_per_conversation,
          },
          warningThreshold: quotas.quota_warning_threshold,
          onExceeded: quotas.on_quota_exceeded,
          refusalMessage: quotas.refusal_message,
        },
      });
    }
  }

  private hasTaskSpecificRouting(): boolean {
    const taskModels = this.config.routing.task_models;
    return Boolean(taskModels.summary || taskModels.extraction || taskModels.forked);
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
    usageTracker?: ConversationUsageTracker,
  ): AsyncGenerator<AgentEvent, TurnExecutionResult> {
    const maxTurns = options?.maxTurns ?? this.config.limits.max_turns;
    const maxOutputTokens = options?.maxOutputTokens ?? this.config.model.max_output_tokens;
    let modelName = options?.model ?? this.config.model.name;
    const toolRegistry = options?.toolRegistry ?? this.toolRegistry;
    const recorder = this.transcriptRecorder;

    // Start interaction span — capture context for background work
    const interactionSpan: Span = startInteractionSpan(submission.conversationId);
    const capturedSpanContext: SpanContext = interactionSpan.spanContext();
    const turnStartTime = Date.now();
    let spanEnded = false;

    const executionState = activeTurn?.executionState ?? new TurnExecutionState();

    // Usage tracking: create a per-turn recorder
    const usageRecorder = new UsageRecorder({
      provider: this.config.model.provider,
      model: modelName,
      conversationId: submission.conversationId,
      requestId: submission.requestId,
      executionContext: options?.model ? 'background' : 'main',
    });

    // Wire usage recorder to aggregator and tracker
    usageRecorder.onRecord((record) => {
      usageTracker?.addRecord(record);
      this.usageAggregator?.recordUsage(record);
    });

    // Pre-turn quota check
    if (this.costAwareRouter && usageTracker) {
      const usage = usageTracker.getUsage();
      const dailyCost = this.usageAggregator?.getDailyCost();
      const monthlyCost = this.usageAggregator?.getMonthlyCost();
      const decision = this.costAwareRouter.evaluate(usage, dailyCost, monthlyCost);

      if (!decision.allowed) {
        yield { type: 'quota_exceeded', reason: decision.quotaResult.reason ?? 'quota_exceeded', refusalMessage: decision.refusalMessage ?? '' };
        yield { type: 'text_delta', content: decision.refusalMessage ?? '' };
        yield { type: 'done', terminalReason: { reason: 'quota_exceeded' } };
        return {
          finalText: decision.refusalMessage ?? '',
          tokenUsage: undefined,
          completedTurns: 0,
          toolCallCount: 0,
          newMessages: [],
        };
      }

      // Cost-aware model downgrade
      if (decision.useFallbackModel && this.config.fallback_model) {
        modelName = this.config.fallback_model.name;
        yield { type: 'recovery', reason: 'cost_aware_downgrade', detail: { from: this.config.model.name, to: modelName } };
      }
    }

    // Increment turn count
    usageTracker?.incrementTurnCount();

    // Resolve the model before prompt construction so the prompt can reference the resolved model
    let resolvedModelName = modelName;
    let resolvedProvider = this.config.model.provider;
    let primaryClient: ModelClient;
    if (options?.model) {
      primaryClient = this.modelClientFactory.createClient();
    } else if (this.modelRouter) {
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
      skillListing: this.skillListing,
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

    // --- Input guardrail: screen fan message before model call ---
    const guardrailConfig = this.config.guardrails;
    let inputScreenResult;
    try {
      inputScreenResult = screenInput(submission.userMessage, guardrailConfig);
    } catch {
      // Fail-closed: if screener throws, block the message
      inputScreenResult = { safe: false, category: 'error' as const, action: 'block' as const, matchedRule: 'screener_error' };
    }

    if (!inputScreenResult.safe) {
      yield {
        type: 'guardrail_block',
        phase: 'input',
        category: inputScreenResult.category ?? 'unknown',
        rule: inputScreenResult.matchedRule ?? 'unknown',
      };
      yield { type: 'text_delta', content: guardrailConfig.messages.input_blocked };
      yield { type: 'done', terminalReason: { reason: 'completed' } };
      spanEnded = true;
      endSpan(interactionSpan, { 'terminal.reason': 'guardrail_input_blocked' });
      return {
        finalText: guardrailConfig.messages.input_blocked,
        tokenUsage: undefined,
        completedTurns: 0,
        toolCallCount: 0,
        newMessages: context.messages.slice(baselineLength),
        interactionSpanContext: capturedSpanContext,
      };
    }

    try {
    while (executionState.getIterationIndex() < maxTurns) {
      this.throwIfAborted(context.signal);
      executionState.incrementIteration();
      executionState.beginModelTurn();

      // Per-model-step context preparation: persistence, microcompact, pressure assessment
      const prepared = await prepareContextForModelCall(
        context.messages,
        resolvedModelName,
        executionState.getTokenUsage(),
        context.conversationId,
        this.contextDeps,
      );
      // Replace messages with prepared version (may have cleared stale tool results)
      if (prepared.rewrote) {
        context.messages.length = 0;
        context.messages.push(...prepared.messages);
      }

      // Record context compaction to transcript
      if (prepared.compactionType && recorder) {
        const trigger = prepared.compactionType === 'reactive' ? 'reactive' as const : 'proactive' as const;
        const completedEntry: CompactCompletedEntry = {
          type: 'compact_completed',
          conversationId: submission.conversationId,
          taskId: submission.requestId,
          turnId: activeTurn?.turnId,
          timestamp: new Date().toISOString(),
          trigger,
          messagesRemoved: prepared.messagesRemoved,
          tokensSaved: prepared.tokensSaved,
        };
        recorder.recordLifecycleEvent(completedEntry).catch(() => {});

        // Also emit as OTEL span event on the interaction span
        interactionSpan.addEvent('compact', {
          'compact.type': prepared.compactionType,
          'compact.trigger': trigger,
          'compact.pressure_band': prepared.pressure,
          'compact.messages_removed': prepared.messagesRemoved,
          'compact.tokens_saved': prepared.tokensSaved,
        });
      }

      // --- Call model (with retry/fallback, error capture) ---
      let callResult: { result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] };
      try {
        callResult = await this.callModelWithRecovery(
          primaryClient,
          { model: resolvedModelName, messages: context.messages, tools: toolRegistry.listDefinitions(), signal: context.signal, systemPromptBlocks, maxOutputTokens },
          recovery,
          resolvedProvider,
          interactionSpan,
        );
      } catch (error) {
        // Emit any buffered recovery events before propagating the original error
        if (error instanceof RecoveryError) {
          for (const event of error.recoveryEvents) {
            yield event;
          }
          spanEnded = true;
          endSpanWithError(interactionSpan, error.cause);
          throw error.cause;
        }
        spanEnded = true;
        endSpanWithError(interactionSpan, error);
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
        recordTurnCompleted(modelName, Date.now() - turnStartTime, false);
        spanEnded = true;
        endSpan(interactionSpan, { 'terminal.reason': 'prompt_too_long' });
        return {
          finalText: lastText,
          tokenUsage: executionState.getTokenUsage(),
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          newMessages: context.messages.slice(baselineLength),
          interactionSpanContext: capturedSpanContext,
        };
      }

      if (result.tokenUsage) {
        executionState.setTokenUsage(result.tokenUsage);

        // Record usage from this model call
        usageRecorder.setTurnNumber(executionState.getIterationIndex());
        usageRecorder.setToolCallCount(executionState.snapshot().toolCallCount);
        const usageRecord = usageRecorder.record(result.tokenUsage, {
          model: modelName,
          isRetry: recovery.lastTransition?.reason === 'api_retry',
          isFallback: recovery.fallbackAttempted,
        });
        if (usageRecord) {
          yield { type: 'usage', record: usageRecord };
        }
        recordTokens(modelName, result.tokenUsage.inputTokens ?? 0, result.tokenUsage.outputTokens ?? 0);
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
        recordTurnCompleted(modelName, Date.now() - turnStartTime, true);
        spanEnded = true;
        endSpan(interactionSpan, { 'terminal.reason': 'max_output_exhausted' });
        return {
          finalText: recovery.accumulatedText,
          tokenUsage: result.tokenUsage,
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          newMessages: context.messages.slice(baselineLength),
          interactionSpanContext: capturedSpanContext,
        };
      }

      // --- Normal final text ---
      if (result.type === 'final_text') {
        let fullText = recovery.accumulatedText + result.text;

        // --- Output guardrail: validate response before delivery ---
        let outputResult;
        try {
          outputResult = validateOutput(fullText, guardrailConfig);
        } catch {
          // Fail-closed: if validator throws, block the response
          outputResult = {
            violations: [{ rule: 'validator_error', severity: 'critical' as const, category: 'error' as const }],
            action: 'block' as const,
            replacementResponse: guardrailConfig.messages.output_blocked,
          };
        }

        if (outputResult.action === 'block') {
          yield {
            type: 'guardrail_block',
            phase: 'output',
            category: outputResult.violations[0]?.category ?? 'unknown',
            rule: outputResult.violations[0]?.rule ?? 'unknown',
          };
          fullText = outputResult.replacementResponse ?? guardrailConfig.messages.output_blocked;
        } else if (outputResult.action === 'modify' && outputResult.modifiedText !== undefined) {
          for (const violation of outputResult.violations) {
            yield {
              type: 'guardrail_modify',
              category: violation.category,
              rule: violation.rule,
            };
          }
          fullText = outputResult.modifiedText;
        }

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

        if (fullText) {
          yield { type: 'text_delta', content: fullText };
        }
        yield { type: 'done', truncated: result.truncated, tokenUsage: result.tokenUsage, terminalReason: { reason: 'completed' } };
        recordTurnCompleted(modelName, Date.now() - turnStartTime, true);
        spanEnded = true;
        endSpan(interactionSpan, {
          'terminal.reason': 'completed',
          'turns.completed': executionState.getIterationIndex(),
          'tools.call_count': executionState.snapshot().toolCallCount,
        });
        return {
          finalText: fullText,
          tokenUsage: result.tokenUsage,
          completedTurns: executionState.getIterationIndex(),
          toolCallCount: executionState.snapshot().toolCallCount,
          toolSummaries,
          newMessages: context.messages.slice(baselineLength),
          interactionSpanContext: capturedSpanContext,
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
        currentModelName: modelName,
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
        recordToolCall(record.toolName, record.durationMs, record.result.success);
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
    recordTurnCompleted(modelName, Date.now() - turnStartTime, true);
    spanEnded = true;
    endSpan(interactionSpan, { 'terminal.reason': 'max_turns' });
    return {
      finalText: lastText,
      tokenUsage: executionState.getTokenUsage(),
      completedTurns: executionState.getIterationIndex(),
      toolCallCount: executionState.snapshot().toolCallCount,
      newMessages: context.messages.slice(baselineLength),
      interactionSpanContext: capturedSpanContext,
    };
    } finally {
      if (!spanEnded) {
        endSpanWithError(interactionSpan, 'generator_abandoned');
      }
    }
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
    parentSpan?: Span,
  ): Promise<{ result: ModelStepResult | { type: 'context_overflow' }; events: AgentEvent[] }> {
    let consecutive529 = 0;
    let client = primaryClient;
    let request = initialRequest;
    let currentProvider = provider ?? this.config.model.provider;
    let currentModel = initialRequest.model;
    const events: AgentEvent[] = [];

    for (let attempt = 0; attempt <= RECOVERY_LIMITS.MAX_API_RETRIES; attempt++) {
      const startTime = Date.now();
      const attemptSpan = parentSpan ? startModelCallSpan(currentModel, parentSpan) : undefined;
      try {
        const result = await client.generate(request);
        // Record success for health tracking
        this.modelRouter?.recordSuccess(currentProvider, request.model, Date.now() - startTime);
        recordModelCall(currentModel, true);
        if (attemptSpan) endSpan(attemptSpan);
        return { result, events };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        const category = categorizeApiError(error);

        // Only record provider-side failures for health tracking.
        // Request-local errors (context_overflow, auth_error, unknown) are not
        // indicative of provider health and should not trip the circuit breaker.
        if (category === 'overloaded' || category === 'rate_limit' || category === 'server_error') {
          this.modelRouter?.recordFailure(currentProvider, request.model, latencyMs, category);
        }
        recordModelCall(currentModel, false);
        recordError('model_call');
        if (attemptSpan) endSpanWithError(attemptSpan, error);

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
            currentModel = this.config.fallback_model.name;
            request = { ...request, model: currentModel };
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
