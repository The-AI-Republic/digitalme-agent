import type { ToolCall } from '../../models/ModelClient.js';
import type { IToolRegistry } from '../registry.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { IToolPolicyChecker } from './ToolPolicyChecker.js';
import type { ResultBudget } from './ResultBudget.js';
import { truncateResult } from './ResultBudget.js';
import type {
  ToolExecutionRecord,
  NormalizedToolResult,
  ParsedToolCall,
  Batch,
  ToolErrorCategory,
} from './types.js';

const MAX_CONCURRENCY = 5;

export interface ToolExecutorCallbacks {
  /**
   * Events fire in real time: under concurrency, tool_start/tool_end
   * events arrive in completion order (reflecting actual execution).
   * The returned ToolExecutionRecord[] array is always in the model's
   * original call order.
   */
  onToolStart: (name: string, callId: string) => void;
  onToolEnd: (name: string, callId: string, success: boolean) => void;
}

/**
 * Create a per-tool AbortSignal that composes request signal + tool timeout.
 */
function createToolAbortSignal(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

  const onRequestAbort = () => controller.abort('request_aborted');
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      requestSignal?.removeEventListener('abort', onRequestAbort);
    },
  };
}

function classifyError(error: unknown): ToolErrorCategory {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message === 'request_aborted') {
      return 'aborted';
    }
  }
  if (typeof error === 'string') {
    if (error === 'timeout') return 'timeout';
    if (error === 'request_aborted') return 'aborted';
  }
  return 'execution_error';
}

function makeErrorRecord(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
  errorCategory: ToolErrorCategory,
  message: string,
  durationMs: number,
): ToolExecutionRecord {
  return {
    callId,
    toolName,
    args,
    result: {
      success: false,
      truncated: false,
      originalChars: message.length,
      errorCategory,
    },
    modelContent: message,
    durationMs,
    summary: `${toolName} → ${errorCategory}: ${message.slice(0, 80)}`,
  };
}

function defaultSummary(
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
): string {
  const argPreview = Object.keys(args).slice(0, 2).join(', ');
  return `${toolName}(${argPreview}) → ${success ? 'ok' : 'failed'}`;
}

/**
 * Single entry point for all tool execution. Owns validation, policy check,
 * timeout, result rendering, normalization, and budget enforcement.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: IToolRegistry,
    private readonly policyChecker: IToolPolicyChecker,
  ) {}

  async runTools(
    calls: ToolCall[],
    context: ToolContext,
    budget: ResultBudget,
    callbacks: ToolExecutorCallbacks,
  ): Promise<ToolExecutionRecord[]> {
    // Phase 1: Parse, validate, and check policy (ALL SERIAL)
    const parsed = this.preprocessCalls(calls, context);

    // Collect immediate error records for failed preprocessing
    const errorRecords: ToolExecutionRecord[] = [];
    const passingCalls: ParsedToolCall[] = [];

    for (const item of parsed) {
      if (!item.tool) {
        errorRecords.push(makeErrorRecord(
          item.callId, item.toolName, {}, 'unknown_tool',
          `Unknown tool: ${item.toolName}`, 0,
        ));
      } else if (item.parseError) {
        errorRecords.push(makeErrorRecord(
          item.callId, item.toolName, {}, 'validation_error', item.parseError, 0,
        ));
      } else if (item.validationError) {
        errorRecords.push(makeErrorRecord(
          item.callId, item.toolName, item.parsedInput as Record<string, unknown>,
          'validation_error', item.validationError, 0,
        ));
      } else if (item.policyDecision && !item.policyDecision.allowed) {
        errorRecords.push(makeErrorRecord(
          item.callId, item.toolName, item.parsedInput as Record<string, unknown>,
          'policy_rejected', item.policyDecision.reason ?? 'Policy denied', 0,
        ));
      } else {
        passingCalls.push(item);
      }
    }

    // Phase 2: Partition passing calls into batches
    const batches = partitionIntoBatches(passingCalls);

    // Phase 3: Execute batches in order
    const executionRecords: ToolExecutionRecord[] = [];

    for (const batch of batches) {
      if (batch.concurrent && batch.items.length > 1) {
        const batchRecords = await this.executeConcurrentBatch(
          batch.items, context, callbacks,
        );
        // Phase 4 (concurrent): post-execution aggregate budget normalization
        // Apply per-tool truncation first
        for (const record of batchRecords) {
          const tool = this.registry.get(record.toolName);
          const maxChars = tool?.metadata.maxResultChars ?? 20_000;
          const truncated = truncateResult(record.modelContent, maxChars);
          record.modelContent = truncated.content;
          if (truncated.truncated) {
            record.result = { ...record.result, truncated: true, originalChars: truncated.originalChars };
          }
        }
        budget.normalizeBatch(batchRecords);
        executionRecords.push(...batchRecords);
      } else {
        // Serial execution
        for (const item of batch.items) {
          const record = await this.executeSingleTool(item, context, callbacks);
          // Phase 4 (serial): truncate modelContent against per-tool limit and aggregate
          const maxChars = item.tool?.metadata.maxResultChars ?? 20_000;
          const truncated = budget.truncateAndConsume(record.modelContent, maxChars);
          record.modelContent = truncated.content;
          if (truncated.truncated) {
            record.result = { ...record.result, truncated: true, originalChars: truncated.originalChars };
          }
          executionRecords.push(record);
        }
      }
    }

    // Merge error records and execution records in original call order
    const allRecords: ToolExecutionRecord[] = [];
    const errorMap = new Map(errorRecords.map(r => [r.callId, r]));
    const execMap = new Map(executionRecords.map(r => [r.callId, r]));

    for (const call of calls) {
      const record = errorMap.get(call.id) ?? execMap.get(call.id);
      if (record) {
        allRecords.push(record);
      }
    }

    return allRecords;
  }

  /**
   * Phase 1: Parse all inputs, validate, check policy, evaluate concurrency safety.
   * All serial — policy state is never accessed concurrently.
   */
  private preprocessCalls(calls: ToolCall[], context: ToolContext): ParsedToolCall[] {
    return calls.map((call) => {
      const toolName = call.function.name;
      const tool = this.registry.get(toolName);

      if (!tool) {
        return {
          callId: call.id,
          toolName,
          rawArguments: call.function.arguments,
          tool: undefined,
          parsedInput: undefined,
          parseError: `Unknown tool: ${toolName}`,
          safe: false,
        };
      }

      // Parse JSON
      let rawArgs: Record<string, unknown>;
      try {
        rawArgs = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        return {
          callId: call.id,
          toolName,
          rawArguments: call.function.arguments,
          tool,
          parsedInput: undefined,
          parseError: `Invalid JSON arguments for tool ${toolName}.`,
          safe: false,
        };
      }

      // Schema validation
      const parseResult = tool.inputSchema.safeParse(rawArgs);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map(i => i.message).join('; ');
        return {
          callId: call.id,
          toolName,
          rawArguments: call.function.arguments,
          tool,
          parsedInput: rawArgs,
          parseError: `Schema validation failed for ${toolName}: ${issues}`,
          safe: false,
        };
      }

      const parsedInput = parseResult.data;

      // Semantic validation
      if (tool.validateInput) {
        const error = tool.validateInput(parsedInput as Record<string, unknown>, context);
        if (error) {
          return {
            callId: call.id,
            toolName,
            rawArguments: call.function.arguments,
            tool,
            parsedInput,
            validationError: error,
            safe: false,
          };
        }
      }

      // Policy check
      const policyDecision = this.policyChecker.checkPolicy(
        toolName,
        tool.metadata.policyCategory,
        parsedInput as Record<string, unknown>,
        context,
      );
      if (!policyDecision.allowed) {
        return {
          callId: call.id,
          toolName,
          rawArguments: call.function.arguments,
          tool,
          parsedInput,
          policyDecision,
          safe: false,
        };
      }

      // Concurrency safety
      let safe = false;
      if (tool.isConcurrencySafe) {
        try {
          safe = tool.isConcurrencySafe(parsedInput as Record<string, unknown>);
        } catch {
          safe = false;
        }
      }

      return {
        callId: call.id,
        toolName,
        rawArguments: call.function.arguments,
        tool,
        parsedInput,
        policyDecision,
        safe,
      };
    });
  }

  private async executeSingleTool(
    item: ParsedToolCall,
    context: ToolContext,
    callbacks: ToolExecutorCallbacks,
  ): Promise<ToolExecutionRecord> {
    const { callId, toolName, tool, parsedInput } = item;
    if (!tool) {
      return makeErrorRecord(callId, toolName, {}, 'unknown_tool', `Unknown tool: ${toolName}`, 0);
    }

    callbacks.onToolStart(toolName, callId);
    const start = Date.now();
    const { signal, cleanup } = createToolAbortSignal(context.signal, tool.metadata.timeoutMs);

    try {
      const toolContext: ToolContext = {
        conversationId: context.conversationId,
        signal,
        policyConfig: context.policyConfig,
      };

      const result: ToolExecutionResult = await tool.execute(
        parsedInput as Record<string, unknown>,
        toolContext,
      );

      const durationMs = Date.now() - start;
      const modelContent = result.renderForModel();

      const summary = tool.summarizeResult
        ? tool.summarizeResult(parsedInput as Record<string, unknown>, result)
        : defaultSummary(toolName, parsedInput as Record<string, unknown>, result.success);

      const record: ToolExecutionRecord = {
        callId,
        toolName,
        args: parsedInput as Record<string, unknown>,
        result: {
          success: result.success,
          truncated: false,
          originalChars: modelContent.length,
        },
        modelContent,
        durationMs,
        summary,
      };

      callbacks.onToolEnd(toolName, callId, result.success);
      return record;
    } catch (error: unknown) {
      const durationMs = Date.now() - start;
      const category = classifyAbortReason(signal, error);
      const message = category === 'timeout'
        ? `Tool ${toolName} timed out after ${tool.metadata.timeoutMs}ms.`
        : category === 'aborted'
          ? `Tool ${toolName} was aborted.`
          : `Tool ${toolName} failed: ${error instanceof Error ? error.message : String(error)}`;

      callbacks.onToolEnd(toolName, callId, false);
      return makeErrorRecord(callId, toolName, parsedInput as Record<string, unknown>, category, message, durationMs);
    } finally {
      cleanup();
    }
  }

  private async executeConcurrentBatch(
    items: ParsedToolCall[],
    context: ToolContext,
    callbacks: ToolExecutorCallbacks,
  ): Promise<ToolExecutionRecord[]> {
    // Limit concurrency
    const results: ToolExecutionRecord[] = new Array(items.length);
    const executing: Promise<void>[] = [];
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        const item = items[idx]!;
        const record = await this.executeSingleTool(item, context, callbacks);
        results[idx] = record;
      }
    };

    const workers = Math.min(MAX_CONCURRENCY, items.length);
    for (let i = 0; i < workers; i++) {
      executing.push(runNext());
    }
    await Promise.allSettled(executing);

    // Fill any gaps from rejected promises with error records
    for (let i = 0; i < items.length; i++) {
      if (!results[i]) {
        results[i] = makeErrorRecord(
          items[i]!.callId, items[i]!.toolName, {},
          'execution_error', 'Concurrent execution failed unexpectedly.', 0,
        );
      }
    }

    return results;
  }
}

function classifyAbortReason(signal: AbortSignal, error: unknown): ToolErrorCategory {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason === 'timeout') return 'timeout';
    if (reason === 'request_aborted') return 'aborted';
  }
  return classifyError(error);
}

function partitionIntoBatches(parsed: ParsedToolCall[]): Batch[] {
  const batches: Batch[] = [];

  for (const item of parsed) {
    const last = batches[batches.length - 1];
    if (last && last.concurrent && item.safe) {
      last.items.push(item);
    } else {
      batches.push({ concurrent: item.safe, items: [item] });
    }
  }

  return batches;
}
