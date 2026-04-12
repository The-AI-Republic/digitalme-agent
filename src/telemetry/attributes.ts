import type { AttributeValue } from '@opentelemetry/api';

/**
 * Allowlist of attribute keys that are safe for telemetry export.
 * Only operational data — no conversation content, fan names, or creator config values.
 */
const ALLOWED_PREFIXES = [
  'model.',
  'tool.',
  'fork.',
  'hook.',
  'subagent.',
  'terminal.',
  'conversation.id',
  'turns.',
  'tools.',
  'error.',
  'agent.',
  'service.',
  'deployment.',
] as const;

const ALLOWED_VALUE_TYPES = new Set(['string', 'number', 'boolean']);

function isAllowedKey(key: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isAllowedValue(value: unknown): value is AttributeValue {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (ALLOWED_VALUE_TYPES.has(t)) return true;
  if (Array.isArray(value)) {
    return value.every((v) => ALLOWED_VALUE_TYPES.has(typeof v));
  }
  return false;
}

/**
 * Filters raw attributes to only include PII-safe keys and values.
 * Strips anything that could contain conversation content, fan names,
 * or creator config values. Allows only: token counts, latencies,
 * error codes, model names, tool names, and enum values.
 */
export function safeAttributes(raw: Record<string, unknown>): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isAllowedKey(key) && isAllowedValue(value)) {
      result[key] = value;
    }
  }
  return result;
}
