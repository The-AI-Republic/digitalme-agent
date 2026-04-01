import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { agentConfigSchema, type AgentConfig } from './schema.js';

function interpolateEnv(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return value;
  });
}

export function loadConfig(configPath = process.env.DIGITALME_CONFIG ?? path.resolve(process.cwd(), 'config.yaml')): AgentConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(interpolateEnv(raw));
  return agentConfigSchema.parse(parsed);
}
