/**
 * Tests for shared Zod-to-JSON-Schema derivation (Track 03).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { zodObjectToJsonSchema } from './schema.js';

test('zodObjectToJsonSchema handles string with min/max', () => {
  const schema = z.object({
    query: z.string().min(1).max(500),
  });
  const result = zodObjectToJsonSchema(schema);
  assert.equal(result.type, 'object');
  const props = result.properties as Record<string, any>;
  assert.equal(props.query.type, 'string');
  assert.equal(props.query.minLength, 1);
  assert.equal(props.query.maxLength, 500);
  assert.deepEqual(result.required, ['query']);
});

test('zodObjectToJsonSchema handles optional fields', () => {
  const schema = z.object({
    name: z.string(),
    desc: z.string().optional(),
  });
  const result = zodObjectToJsonSchema(schema);
  assert.deepEqual(result.required, ['name']);
  const props = result.properties as Record<string, any>;
  assert.ok(props.name);
  assert.ok(props.desc);
});

test('zodObjectToJsonSchema handles boolean and number', () => {
  const schema = z.object({
    count: z.number(),
    active: z.boolean(),
  });
  const result = zodObjectToJsonSchema(schema);
  const props = result.properties as Record<string, any>;
  assert.equal(props.count.type, 'number');
  assert.equal(props.active.type, 'boolean');
});

test('zodObjectToJsonSchema handles enum', () => {
  const schema = z.object({
    mode: z.enum(['fast', 'slow', 'auto']),
  });
  const result = zodObjectToJsonSchema(schema);
  const props = result.properties as Record<string, any>;
  assert.equal(props.mode.type, 'string');
  assert.deepEqual(props.mode.enum, ['fast', 'slow', 'auto']);
});

test('zodObjectToJsonSchema handles descriptions', () => {
  const schema = z.object({
    name: z.string().describe('The name of the skill.'),
  });
  const result = zodObjectToJsonSchema(schema);
  const props = result.properties as Record<string, any>;
  assert.equal(props.name.description, 'The name of the skill.');
});

test('zodObjectToJsonSchema handles no required fields', () => {
  const schema = z.object({
    a: z.string().optional(),
    b: z.number().optional(),
  });
  const result = zodObjectToJsonSchema(schema);
  assert.equal(result.required, undefined);
});
