export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  tools: string[] | '*';
  disallowedTools?: string[];
  maxTurns: number;
  model: string | 'inherit';
  getSystemPrompt: () => string | Promise<string>;
}
