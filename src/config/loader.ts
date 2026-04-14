import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { agentConfigSchema, type AgentConfig } from './schema.js';

const REMOVED_CONFIG_FIELDS = [
  'routing.task_models',
  'context.summary.model',
  'context.session_memory.extraction_model',
] as const;

function interpolateEnv(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return value;
  });
}

function hasNestedField(input: unknown, fieldPath: string): boolean {
  let current: unknown = input;
  for (const key of fieldPath.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function assertNoRemovedConfigFields(input: unknown): void {
  const removedFields = REMOVED_CONFIG_FIELDS.filter((fieldPath) => hasNestedField(input, fieldPath));
  if (removedFields.length === 0) {
    return;
  }

  throw new Error(
    `Config contains removed fields: ${removedFields.join(', ')}. `
    + 'Remove them from config.yaml and use fast_model plus the current context/routing settings instead.',
  );
}

export function loadConfig(configPath = process.env.DIGITALME_CONFIG ?? path.resolve(process.cwd(), 'config.yaml')): AgentConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(interpolateEnv(raw));
  assertNoRemovedConfigFields(parsed);
  return agentConfigSchema.parse(parsed);
}
