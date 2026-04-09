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
import type { AgentEvent, ExecutionOptions, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';

interface TurnExecutorDeps {
  systemPromptBuilder?: ISystemPromptBuilder;
  modelClientFactory?: IModelClientFactory;
  toolRegistry?: IToolRegistry;
  toolPolicyChecker?: IToolPolicyChecker;
  toolExecutor?: ToolExecutor;
}

export class TurnExecutor {
  private readonly systemPromptBuilder: ISystemPromptBuilder;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly toolRegistry: IToolRegistry;
  private readonly toolExecutor: ToolExecutor;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? createToolRegistry(config);
    this.systemPromptBuilder = deps.systemPromptBuilder ??
      new SystemPromptBuilder(new TemplateLoader());
    this.modelClientFactory = deps.modelClientFactory ?? new ModelClientFactory(config);
    const policyChecker = deps.toolPolicyChecker ?? new DefaultToolPolicyChecker();
    this.toolExecutor = deps.toolExecutor ?? new ToolExecutor(this.toolRegistry, policyChecker);
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
      { role: 'user' as const, content: submission.userMessage },
    ];

    const context = new TurnContext(submission, initialMessages);
    const client = this.modelClientFactory.createClient();
    let toolCallCount = 0;
    const resultBudget = new ResultBudget(); // fresh per request

    while (context.turnCount < maxTurns) {
      this.throwIfAborted(context.signal);
      context.turnCount += 1;
      activeTurn?.turnState.beginModelTurn();

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
      });

      // Delegate all tool execution to ToolExecutor
      const toolContext = {
        conversationId: context.conversationId,
        signal: context.signal ?? new AbortController().signal,
        policyConfig: {},
      };

      const callbacks: ToolExecutorCallbacks = {
        onToolStart: (name, callId) => {
          activeTurn?.turnState.registerToolCall(callId);
        },
        onToolEnd: (name, callId) => {
          activeTurn?.turnState.resolveToolCall(callId);
        },
      };

      const records = await this.toolExecutor.runTools(
        result.calls, toolContext, resultBudget, callbacks,
      );

      // Yield events and push results to message history
      for (const record of records) {
        toolCallCount += 1;
        yield { type: 'tool_start', name: record.toolName, callId: record.callId };
        yield {
          type: 'tool_end',
          name: record.toolName,
          callId: record.callId,
          success: record.result.success,
        };
        context.messages.push({
          role: 'tool',
          content: record.modelContent,
          toolCallId: record.callId,
          toolName: record.toolName,
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
