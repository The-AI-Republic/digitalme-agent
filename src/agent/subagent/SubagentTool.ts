import type { IToolRegistry } from '../../tools/registry.js';
import type { Tool, ToolContext, ToolDefinition, ToolExecutionResult } from '../../tools/types.js';
import type { TurnExecutor } from '../TurnExecutor.js';
import type { AgentEvent, ExecutionOptions, TurnExecutionResult, TurnSubmission } from '../types.js';
import { consumeGenerator } from '../types.js';
import type { AgentDefinition } from './AgentDefinition.js';
import { getBuiltInAgent } from './BuiltInAgents.js';

type TurnExecutorLike = {
  run: TurnExecutor['run'];
};

export interface SubagentToolDeps {
  turnExecutor: TurnExecutorLike;
  parentToolRegistry: IToolRegistry;
  modelName: string;
}

interface SubagentInput {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
}

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

export function createSubagentTool(deps: SubagentToolDeps): Tool {
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

  return {
    name: 'Task',
    definition,
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
      const input = args as unknown as SubagentInput;

      const agentDef = getBuiltInAgent(input.subagent_type);
      if (!agentDef) {
        return {
          success: false,
          content: `Unknown agent type: ${input.subagent_type}`,
        };
      }

      const systemPrompt = await agentDef.getSystemPrompt();
      const toolRegistry = resolveSubagentTools(agentDef, deps.parentToolRegistry);

      const modelName = input.model
        ?? (agentDef.model === 'inherit' ? deps.modelName : agentDef.model);

      const options: ExecutionOptions = {
        maxTurns: agentDef.maxTurns,
        model: modelName,
        toolRegistry,
      };

      const submission: TurnSubmission = {
        requestId: `subagent-${input.subagent_type}-${Date.now()}`,
        conversationId: context.conversationId,
        userMessage: input.prompt,
        history: [],
        promptHistory: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input.prompt },
        ],
      };

      try {
        const result = await consumeGenerator(
          deps.turnExecutor.run(submission, options),
          (_event: AgentEvent) => { /* discard */ },
        );
        return {
          success: true,
          content: result.finalText,
        };
      } catch (err) {
        return {
          success: false,
          content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
