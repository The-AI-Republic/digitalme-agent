import test from 'node:test';
import assert from 'node:assert/strict';

import { generateId, ModelClient } from './ModelClient.js';
import type { CompletionRequest, ModelStepResult } from './ModelClient.js';

test('generateId returns a valid UUID string', () => {
  const id = generateId();
  assert.ok(typeof id === 'string');
  // UUID v4 format
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('generateId produces unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId()));
  assert.equal(ids.size, 100);
});

test('ModelClient can be subclassed and generate called', async () => {
  class TestClient extends ModelClient {
    async generate(_request: CompletionRequest): Promise<ModelStepResult> {
      return { type: 'final_text', text: 'hello' };
    }
  }

  const client = new TestClient();
  const result = await client.generate({
    model: 'test',
    messages: [{ role: 'user', content: 'hi', id: generateId() }],
  });

  assert.equal(result.type, 'final_text');
  if (result.type === 'final_text') {
    assert.equal(result.text, 'hello');
  }
});

test('ModelClient subclass can return tool_calls', async () => {
  class ToolClient extends ModelClient {
    async generate(_request: CompletionRequest): Promise<ModelStepResult> {
      return {
        type: 'tool_calls',
        calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' },
        }],
      };
    }
  }

  const client = new ToolClient();
  const result = await client.generate({
    model: 'test',
    messages: [],
  });

  assert.equal(result.type, 'tool_calls');
  if (result.type === 'tool_calls') {
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, 'search');
  }
});
