import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleClient } from './OpenAICompatibleClient.js';

// Build a client subclass that lets us inject a fake OpenAI module
class TestableClient extends OpenAICompatibleClient {
  private readonly fakeResponse: any;

  constructor(fakeResponse: any) {
    super({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://fake.api/v1' });
    this.fakeResponse = fakeResponse;
  }

  // Override the lazy-loaded client with a fake
  private ensureFakeClient() {
    if (!(this as any).client) {
      (this as any).client = {
        chat: {
          completions: {
            create: async (_body: any, _opts: any) => this.fakeResponse,
          },
        },
      };
    }
  }

  async generate(request: any) {
    this.ensureFakeClient();
    return super.generate(request);
  }
}

test('generate returns final_text for a simple text response', async () => {
  const client = new TestableClient({
    choices: [{
      message: { content: 'Hello world', tool_calls: null },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  const result = await client.generate({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.type, 'final_text');
  if (result.type === 'final_text') {
    assert.equal(result.text, 'Hello world');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.tokenUsage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  }
});

test('generate returns truncated when finish_reason is length', async () => {
  const client = new TestableClient({
    choices: [{
      message: { content: 'partial...', tool_calls: null },
      finish_reason: 'length',
    }],
  });

  const result = await client.generate({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.type, 'final_text');
  if (result.type === 'final_text') {
    assert.equal(result.truncated, true);
  }
});

test('generate returns tool_calls when model requests tools', async () => {
  const client = new TestableClient({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"test"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
  });

  const result = await client.generate({
    model: 'test-model',
    messages: [{ role: 'user', content: 'search for test' }],
    tools: [{
      type: 'function',
      function: { name: 'web_search', description: 'search', parameters: {} },
    }],
  });

  assert.equal(result.type, 'tool_calls');
  if (result.type === 'tool_calls') {
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].id, 'call_1');
    assert.equal(result.calls[0].function.name, 'web_search');
    assert.equal(result.calls[0].function.arguments, '{"query":"test"}');
  }
});

test('generate throws when model returns no message', async () => {
  const client = new TestableClient({
    choices: [{ message: null }],
  });

  await assert.rejects(
    () => client.generate({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    { message: 'Model returned no message' },
  );
});

test('generate returns empty string for null content', async () => {
  const client = new TestableClient({
    choices: [{
      message: { content: null, tool_calls: null },
      finish_reason: 'stop',
    }],
  });

  const result = await client.generate({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.type, 'final_text');
  if (result.type === 'final_text') {
    assert.equal(result.text, '');
  }
});

test('generate omits tokenUsage when usage is missing from response', async () => {
  const client = new TestableClient({
    choices: [{
      message: { content: 'no usage', tool_calls: null },
      finish_reason: 'stop',
    }],
  });

  const result = await client.generate({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.type, 'final_text');
  if (result.type === 'final_text') {
    assert.equal(result.tokenUsage, undefined);
  }
});
