import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolContext, ToolDefinition, ToolExecutionResult, ToolMetadata } from './types.js';
import { DEFAULT_TOOL_METADATA } from './types.js';
import type { IToolRegistry } from './registry.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import type { LoadedSkill } from '../skills/types.js';
import type { ExecutionOptions, ForkedAgentResult, TurnExecutorLike, TurnSubmission } from '../agent/types.js';
import type { SessionRuntime } from '../agent/SessionRuntime.js';
import { launchForkedAgent } from '../agent/fork/ForkedAgent.js';

const creatorSkillInputSchema = z.object({
  skill: z.string().min(1),
  args: z.string().optional(),
});

type CreatorSkillInput = z.infer<typeof creatorSkillInputSchema>;

export interface CreatorSkillToolDeps {
  skillRegistry: SkillRegistry;
  turnExecutor: TurnExecutorLike;
  parentToolRegistry: IToolRegistry;
  defaultModelName: string;
  getSessionRuntime: (conversationId: string) => SessionRuntime | undefined;
}

function expandArguments(prompt: string, args: string): string {
  const escapedArgs = args
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const wrappedArgs = `<skill-arguments>\n${escapedArgs}\n</skill-arguments>`;

  if (prompt.includes('$ARGUMENTS')) {
    return prompt.replace(/\$ARGUMENTS/g, wrappedArgs);
  }

  if (!args.trim()) {
    return prompt;
  }

  return `${prompt}\n\nSkill arguments:\n${wrappedArgs}`;
}

function buildSkillPrompt(skill: LoadedSkill, args: string): string {
  const expanded = expandArguments(skill.prompt, args);
  return skill.supporting_context.length > 0
    ? `${expanded}\n\n${skill.supporting_context.join('\n\n')}`
    : expanded;
}

function buildForkedSkillToolRegistry(
  skill: LoadedSkill,
  parentToolRegistry: IToolRegistry,
): IToolRegistry {
  const allowed = new Set(
    skill.allowed_tools.filter((name) => name !== 'CreatorSkill' && parentToolRegistry.get(name)),
  );

  return {
    listDefinitions() {
      return parentToolRegistry
        .listDefinitions()
        .filter((definition) => allowed.has(definition.function.name));
    },
    listNames() {
      return [...allowed];
    },
    get(name: string) {
      return allowed.has(name) ? parentToolRegistry.get(name) : undefined;
    },
  };
}

function buildForkedSkillSubmission(
  conversationId: string,
  prompt: string,
  signal: AbortSignal,
  skillName: string,
): TurnSubmission {
  return {
    requestId: `skill-${skillName}-${randomUUID()}`,
    conversationId,
    userMessage: prompt,
    history: [],
    signal,
  };
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          onTimeout();
          reject(new Error('Skill execution timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function createCreatorSkillTool(deps: CreatorSkillToolDeps): Tool<CreatorSkillInput> {
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CreatorSkill',
      description: 'Invoke a creator-defined skill to handle a specific task.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Name of the skill to invoke.' },
          args: { type: 'string', description: 'Relevant context from the fan message.' },
        },
        required: ['skill'],
      },
    },
  };

  const metadata: ToolMetadata = {
    ...DEFAULT_TOOL_METADATA,
    timeoutMs: 60_000,
    policyCategory: 'action',
  };

  return {
    name: 'CreatorSkill',
    definition,
    metadata,
    inputSchema: creatorSkillInputSchema,
    isConcurrencySafe: () => false,
    async execute(args: CreatorSkillInput, context: ToolContext): Promise<ToolExecutionResult> {
      const skill = deps.skillRegistry.get(args.skill);
      if (!skill) {
        const error = `Unknown skill: ${args.skill}`;
        return { success: false, data: { error }, renderForModel: () => error };
      }

      const prompt = buildSkillPrompt(skill, args.args ?? '');
      if (skill.context === 'inline') {
        return {
          success: true,
          data: { prompt },
          renderForModel: () => [
            `Skill instructions for ${skill.name}:`,
            prompt,
            '',
            'Follow these instructions now in the current conversation.',
          ].join('\n'),
        };
      }

      const sessionRuntime = deps.getSessionRuntime(context.conversationId);
      if (!sessionRuntime) {
        const error = 'Skill execution unavailable (session runtime not found)';
        return { success: false, data: { error }, renderForModel: () => error };
      }

      const toolRegistry = buildForkedSkillToolRegistry(skill, deps.parentToolRegistry);
      const submission = buildForkedSkillSubmission(
        context.conversationId,
        prompt,
        context.signal,
        skill.name,
      );
      const modelName = skill.model === 'inherit'
        ? (context.currentModelName ?? deps.defaultModelName)
        : skill.model;
      const options: ExecutionOptions = {
        maxTurns: skill.max_turns,
        model: modelName,
        toolRegistry,
        guardrailScope: 'internal',
      };

      const handle = launchForkedAgent({
        submission,
        turnExecutor: deps.turnExecutor,
        options,
        sessionRuntime,
        forkSemaphore: sessionRuntime.forkSemaphore,
        config: {
          forkLabel: `skill:${skill.name}`,
          skipTranscript: false,
        },
      });

      if (!handle) {
        const error = 'Skill execution unavailable (concurrency limit reached)';
        return { success: false, data: { error }, renderForModel: () => error };
      }

      try {
        const result = await awaitWithTimeout<ForkedAgentResult>(
          handle.promise,
          skill.timeout_seconds * 1000,
          () => handle.abort(),
        );

        return {
          success: true,
          data: { finalText: result.finalText },
          renderForModel: () => result.finalText,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          data: { error: message },
          renderForModel: () => message,
        };
      }
    },
  };
}
