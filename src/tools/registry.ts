import type { AgentConfig } from '../config/schema.js';
import type { Tool, ToolDefinition } from './types.js';
import { WebSearchTool } from './web-search.js';

export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  listDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

export interface IToolRegistry {
  listDefinitions(): ToolDefinition[];
  listNames(): string[];
  get(name: string): Tool | undefined;
}

export function createToolRegistry(config: AgentConfig): ToolRegistry {
  const registry = new ToolRegistry();
  if (config.soul.tools.allow_web_search) {
    registry.register(new WebSearchTool());
  }
  return registry;
}
