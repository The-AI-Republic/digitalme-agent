import { z } from 'zod';
import { generateId } from '../../models/ModelClient.js';
import type { IToolRegistry } from '../../tools/registry.js';
import type { Tool, ToolContext, ToolDefinition, ToolExecutionResult, ToolMetadata } from '../../tools/types.js';
import { DEFAULT_TOOL_METADATA } from '../../tools/types.js';
import type { AgentEvent, ExecutionOptions, TurnExecutionResult, TurnExecutorLike, TurnSubmission } from '../types.js';
import { consumeGenerator } from '../types.js';
import type { AgentDefinition } from './AgentDefinition.js';
import { getBuiltInAgent } from './BuiltInAgents.js';

export interface SubagentToolDeps {
  turnExecutor: TurnExecutorLike;
  parentToolRegistry: IToolRegistry;
  modelName: string;
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

      try {
        const result = await consumeGenerator(
          deps.turnExecutor.run(submission, options),
          (_event: AgentEvent) => { /* discard */ },
        );
        return {
          success: true,
          data: { finalText: result.finalText },
          renderForModel: () => result.finalText,
        };
      } catch (err) {
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
