import type { AgentDefinition } from './AgentDefinition.js';

export const builtInAgents: AgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse: 'General-purpose agent for complex, multi-step tasks.',
    tools: '*',
    maxTurns: 50,
    model: 'inherit',
    getSystemPrompt: () =>
      'You are a general-purpose agent. Complete the task described in the prompt.',
  },
];

export function getBuiltInAgent(agentType: string): AgentDefinition | undefined {
  return builtInAgents.find((a) => a.agentType === agentType);
}
