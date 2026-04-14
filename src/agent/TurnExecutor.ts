import type { AgentConfig } from '../config/schema.js';
import { ModelClientFactory, type IModelClientFactory } from '../models/ModelClientFactory.js';
import type { ToolCall } from '../models/ModelClient.js';
import { PromptComposer, type IPromptComposer } from '../prompts/PromptComposer.js';
import { ToolRegistry, type IToolRegistry } from '../tools/registry.js';
import type { Tool, ToolExecutionResult } from '../tools/types.js';
import { EventQueue } from './EventQueue.js';
import { TurnContext } from './TurnContext.js';
import type { AgentEvent, TurnExecutionResult, TurnSubmission } from './types.js';
import type { ActiveTurn } from './ActiveTurn.js';
import { screenInput } from '../guardrails/InputScreener.js';
import { validateOutput } from '../guardrails/OutputValidator.js';

export interface TurnExecutorDeps {
  promptComposer?: IPromptComposer;
  modelClientFactory?: IModelClientFactory;
  toolRegistry?: IToolRegistry;
}

export class TurnExecutor {
  private readonly promptComposer: IPromptComposer;
  private readonly modelClientFactory: IModelClientFactory;
  private readonly toolRegistry: IToolRegistry;

  constructor(private readonly config: AgentConfig, deps: TurnExecutorDeps = {}) {
    this.toolRegistry = deps.toolRegistry ?? new ToolRegistry(config);
    this.promptComposer = deps.promptComposer ?? new PromptComposer(config, this.toolRegistry.listNames());
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
    const initialMessages = this.promptComposer.compose(history, submission.userMessage);
    const context = new TurnContext(submission, initialMessages);
    const client = this.modelClientFactory.createClient();
    let toolCallCount = 0;

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
      events.push({
        type: 'guardrail_block',
        phase: 'input',
        category: inputScreenResult.category ?? 'unknown',
        rule: inputScreenResult.matchedRule ?? 'unknown',
      });
      events.push({ type: 'text_delta', content: guardrailConfig.messages.input_blocked });
      events.push({ type: 'done' });
      return {
        finalText: guardrailConfig.messages.input_blocked,
        completedTurns: 0,
        toolCallCount: 0,
        promptMessages: [],
      };
    }

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
        let finalText = result.text ?? '';

        // --- Output guardrail: validate response before delivery ---
        let outputResult;
        try {
          outputResult = validateOutput(finalText, guardrailConfig);
        } catch {
          // Fail-closed: if validator throws, block the response
          outputResult = {
            violations: [{ rule: 'validator_error', severity: 'critical' as const, category: 'error' as const }],
            action: 'block' as const,
            replacementResponse: guardrailConfig.messages.output_blocked,
          };
        }

        if (outputResult.action === 'block') {
          events.push({
            type: 'guardrail_block',
            phase: 'output',
            category: outputResult.violations[0]?.category ?? 'unknown',
            rule: outputResult.violations[0]?.rule ?? 'unknown',
          });
          finalText = outputResult.replacementResponse ?? guardrailConfig.messages.output_blocked;
        } else if (outputResult.action === 'modify' && outputResult.modifiedText !== undefined) {
          for (const violation of outputResult.violations) {
            events.push({
              type: 'guardrail_modify',
              category: violation.category,
              rule: violation.rule,
            });
          }
          finalText = outputResult.modifiedText;
        }

        if (finalText) {
          events.push({ type: 'text_delta', content: finalText });
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
