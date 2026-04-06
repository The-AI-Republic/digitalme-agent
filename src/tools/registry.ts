import type { AgentConfig } from '../config/schema.js';
import type { Tool, ToolDefinition } from './types.js';
import { WebSearchTool } from './web-search.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(config: AgentConfig) {
    if (config.soul.tools.allow_web_search) {
      this.register(new WebSearchTool());
    }
  }

  private register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  listDefinitions() {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  listNames() {
    return Array.from(this.tools.keys());
  }

  get(name: string) {
    return this.tools.get(name);
  }
}

export interface IToolRegistry {
  listDefinitions(): ToolDefinition[];
  listNames(): string[];
  get(name: string): Tool | undefined;
}
