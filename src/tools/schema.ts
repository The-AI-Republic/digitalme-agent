/**
 * Shared Zod-to-JSON-Schema derivation for tool definitions.
 *
 * Covers the Zod types actually used by tools in this codebase:
 * ZodString, ZodNumber, ZodBoolean, ZodOptional, ZodEnum, ZodObject.
 * Extend as needed when new tools use richer schemas.
 */

import { z } from 'zod';

function zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap optional/default
  if (zodType instanceof z.ZodOptional || zodType instanceof z.ZodDefault) {
    return zodTypeToJsonSchema(zodType._def.innerType);
  }

  if (zodType instanceof z.ZodString) {
    const prop: Record<string, unknown> = { type: 'string' };
    const checks = zodType._def.checks ?? [];
    for (const check of checks) {
      if (check.kind === 'min') prop.minLength = check.value;
      if (check.kind === 'max') prop.maxLength = check.value;
    }
    if (zodType.description) prop.description = zodType.description;
    return prop;
  }

  if (zodType instanceof z.ZodNumber) {
    const prop: Record<string, unknown> = { type: 'number' };
    if (zodType.description) prop.description = zodType.description;
    return prop;
  }

  if (zodType instanceof z.ZodBoolean) {
    const prop: Record<string, unknown> = { type: 'boolean' };
    if (zodType.description) prop.description = zodType.description;
    return prop;
  }

  if (zodType instanceof z.ZodEnum) {
    return { type: 'string', enum: zodType._def.values };
  }

  if (zodType instanceof z.ZodObject) {
    return zodObjectToJsonSchema(zodType);
  }

  // Fallback for unrecognized types
  return {};
}

export function zodObjectToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    const prop = zodTypeToJsonSchema(zodType);

    // Add description from field name if none exists
    if (!('description' in prop) || !prop.description) {
      if (zodType.description) {
        prop.description = zodType.description;
      }
    }

    properties[key] = prop;

    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
