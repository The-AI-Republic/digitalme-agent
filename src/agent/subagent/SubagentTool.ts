import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { generateId } from '../../models/ModelClient.js';
import type { IToolRegistry } from '../../tools/registry.js';
import type { Tool, ToolContext, ToolDefinition, ToolExecutionResult, ToolMetadata } from '../../tools/types.js';
import { DEFAULT_TOOL_METADATA } from '../../tools/types.js';
import type { AgentEvent, ExecutionOptions, TurnExecutorLike, TurnSubmission } from '../types.js';
import { consumeGenerator } from '../types.js';
import type { AgentDefinition } from './AgentDefinition.js';
import { getBuiltInAgent } from './BuiltInAgents.js';
import type {
  ITranscriptRecorder,
  SubagentStartedEntry,
  SubagentCompletedEntry,
  SubagentFailedEntry,
} from '../transcript/types.js';
import { startSubagentSpan, endSpan, endSpanWithError } from '../../telemetry/spans.js';
import type { Span } from '@opentelemetry/api';

export interface SubagentToolDeps {
  turnExecutor: TurnExecutorLike;
  parentToolRegistry: IToolRegistry;
  modelName: string;
  transcriptRecorder?: ITranscriptRecorder;
  interactionSpan?: Span;
}

const subagentInputSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  subagent_type: z.string(),
  model: z.string().optional(),
});

type SubagentInput = z.infer<typeof subagentInputSchema>;

export function resolveSubagentTools(
  definition: AgentDefinition,
  parentRegistry: IToolRegistry,
): IToolRegistry {
  const parentNames = new Set(parentRegistry.listNames());
  const disallowed = new Set(definition.disallowedTools ?? []);

  let allowed: Set<string>;
  if (definition.tools === '*') {
    allowed = new Set(parentNames);
  } else {
    allowed = new Set(definition.tools.filter((t) => parentNames.has(t)));
  }

  for (const name of disallowed) {
    allowed.delete(name);
  }

  return {
    listDefinitions() {
      return parentRegistry
        .listDefinitions()
        .filter((d) => allowed.has(d.function.name));
    },
    listNames() {
      return [...allowed];
    },
    get(name: string) {
      return allowed.has(name) ? parentRegistry.get(name) : undefined;
    },
  };
}

export function createSubagentTool(deps: SubagentToolDeps): Tool<SubagentInput> {
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Task',
      description: 'Launch a specialized agent to handle a complex task. Returns the agent\'s final text output.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Short (3-5 word) description of the task.',
          },
          prompt: {
            type: 'string',
            description: 'Detailed prompt for the agent to execute.',
          },
          subagent_type: {
            type: 'string',
            description: 'Agent type to use (e.g., "general-purpose").',
          },
          model: {
            type: 'string',
            description: 'Optional model override.',
          },
        },
        required: ['description', 'prompt', 'subagent_type'],
      },
    },
  };

  const metadata: ToolMetadata = {
    ...DEFAULT_TOOL_METADATA,
    timeoutMs: 300_000, // 5 minutes — subagents make many model calls
    policyCategory: 'action',
  };

  return {
    name: 'Task',
    definition,
    metadata,
    inputSchema: subagentInputSchema,
    async execute(args: SubagentInput, context: ToolContext): Promise<ToolExecutionResult> {
      const agentDef = getBuiltInAgent(args.subagent_type);
      if (!agentDef) {
        const errorMsg = `Unknown agent type: ${args.subagent_type}`;
        return {
          success: false,
          data: { error: errorMsg },
          renderForModel: () => errorMsg,
        };
      }

      const systemPrompt = await agentDef.getSystemPrompt();
      const toolRegistry = resolveSubagentTools(agentDef, deps.parentToolRegistry);

      const modelName = args.model
        ?? (agentDef.model === 'inherit' ? deps.modelName : agentDef.model);

      const options: ExecutionOptions = {
        maxTurns: agentDef.maxTurns,
        model: modelName,
        toolRegistry,
      };

      const submission: TurnSubmission = {
        requestId: `subagent-${args.subagent_type}-${Date.now()}`,
        conversationId: context.conversationId,
        userMessage: args.prompt,
        history: [],
        signal: context.signal,
        promptHistory: [
          { role: 'system', content: systemPrompt, id: generateId() },
          { role: 'user', content: args.prompt, id: generateId() },
        ],
      };

      const toolCount = toolRegistry.listNames().length;
      const recorder = deps.transcriptRecorder;

      // Record subagent_started
      if (recorder) {
        const startedEntry: SubagentStartedEntry = {
          type: 'subagent_started',
          conversationId: context.conversationId,
          taskId: submission.requestId,
          timestamp: new Date().toISOString(),
          subagentType: args.subagent_type,
          model: modelName,
          toolCount,
        };
        recorder.recordLifecycleEvent(startedEntry).catch(() => {});
      }

      const startTime = Date.now();

      // Start a child span for the subagent (if parent interaction span available)
      const subagentSpan = deps.interactionSpan
        ? startSubagentSpan(args.subagent_type, modelName, deps.interactionSpan)
        : undefined;

      try {
        const result = await consumeGenerator(
          deps.turnExecutor.run(submission, options),
          (_event: AgentEvent) => { /* discard */ },
        );

        const durationMs = Date.now() - startTime;

        // Record sidechain transcript for the subagent's internal history
        if (deps.transcriptRecorder && result.newMessages.length > 0) {
          try {
            const agentId = `subagent-${args.subagent_type}-${randomUUID()}`;
            await deps.transcriptRecorder.insertMessageChain(
              context.conversationId,
              result.newMessages,
              true,  // isSidechain
              agentId,
            );
            await deps.transcriptRecorder.writeAgentMetadata(context.conversationId, {
              agentId,
              agentType: args.subagent_type,
              description: args.description,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Best effort — recording failure should not fail the tool result
          }
        }

        // Record subagent_completed
        if (recorder) {
          const completedEntry: SubagentCompletedEntry = {
            type: 'subagent_completed',
            conversationId: context.conversationId,
            taskId: submission.requestId,
            timestamp: new Date().toISOString(),
            subagentType: args.subagent_type,
            tokenUsage: result.tokenUsage,
            toolCallCount: result.toolCallCount,
            completedTurns: result.completedTurns,
            durationMs,
            model: modelName,
          };
          recorder.recordLifecycleEvent(completedEntry).catch(() => {});
        }

        // End subagent span
        if (subagentSpan) {
          endSpan(subagentSpan, {
            'subagent.type': args.subagent_type,
            'subagent.duration_ms': durationMs,
            'subagent.tool_call_count': result.toolCallCount,
            'model.name': modelName,
          });
        }

        return {
          success: true,
          data: { finalText: result.finalText },
          renderForModel: () => result.finalText,
        };
      } catch (err) {
        // Record subagent_failed
        if (recorder) {
          const failedEntry: SubagentFailedEntry = {
            type: 'subagent_failed',
            conversationId: context.conversationId,
            taskId: submission.requestId,
            timestamp: new Date().toISOString(),
            subagentType: args.subagent_type,
            error: err instanceof Error ? err.message : String(err),
          };
          recorder.recordLifecycleEvent(failedEntry).catch(() => {});
        }

        // End subagent span with error
        if (subagentSpan) {
          endSpanWithError(subagentSpan, err, {
            'subagent.type': args.subagent_type,
            'subagent.duration_ms': Date.now() - startTime,
          });
        }

        const errorMsg = `Subagent failed: ${err instanceof Error ? err.message : String(err)}`;
        return {
          success: false,
          data: { error: errorMsg },
          renderForModel: () => errorMsg,
        };
      }
    },
  };
}
