import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSearchTool } from './web-search.js';

const tool = new WebSearchTool();
const context = { conversationId: 'conv-1' };

test('WebSearchTool has correct name and definition', () => {
  assert.equal(tool.name, 'web_search');
  assert.equal(tool.definition.type, 'function');
  assert.equal(tool.definition.function.name, 'web_search');
  assert.ok(tool.definition.function.description.length > 0);
  assert.deepEqual(tool.definition.function.parameters.required, ['query']);
});

test('execute returns failure for empty query', async () => {
  const result = await tool.execute({ query: '' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('query is required'));
});

test('execute returns failure for missing query', async () => {
  const result = await tool.execute({}, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('query is required'));
});

test('execute returns failure for whitespace-only query', async () => {
  const result = await tool.execute({ query: '   ' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('query is required'));
});

test('execute returns results from DuckDuckGo abstract', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(JSON.stringify({
    Heading: 'TypeScript',
    AbstractText: 'TypeScript is a programming language.',
    AbstractURL: 'https://en.wikipedia.org/wiki/TypeScript',
    RelatedTopics: [],
  }), { status: 200 });

  const result = await tool.execute({ query: 'TypeScript' }, context);
  assert.equal(result.success, true);
  assert.ok(result.content.includes('TypeScript'));
  assert.ok(result.content.includes('programming language'));
  assert.ok(result.content.includes('https://en.wikipedia.org/wiki/TypeScript'));
});

test('execute returns results from RelatedTopics', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(JSON.stringify({
    Heading: '',
    AbstractText: '',
    RelatedTopics: [
      { Text: 'Topic 1', FirstURL: 'https://example.com/1' },
      { Text: 'Topic 2' },
      { Topics: [{ Text: 'Nested topic', FirstURL: 'https://example.com/nested' }] },
    ],
  }), { status: 200 });

  const result = await tool.execute({ query: 'test' }, context);
  assert.equal(result.success, true);
  assert.ok(result.content.includes('Topic 1'));
  assert.ok(result.content.includes('https://example.com/1'));
  assert.ok(result.content.includes('Topic 2'));
  assert.ok(result.content.includes('Nested topic'));
});

test('execute returns no results message when empty response', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(JSON.stringify({
    Heading: '',
    AbstractText: '',
    RelatedTopics: [],
  }), { status: 200 });

  const result = await tool.execute({ query: 'obscure' }, context);
  assert.equal(result.success, true);
  assert.ok(result.content.includes('No useful public web results'));
});

test('execute handles HTTP errors', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response('', { status: 500 });

  const result = await tool.execute({ query: 'test' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('HTTP 500'));
});

test('execute handles fetch errors', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => { throw new Error('network failure'); };

  const result = await tool.execute({ query: 'test' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('network failure'));
});

test('execute handles invalid JSON response', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response('not json', { status: 200 });

  const result = await tool.execute({ query: 'test' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('invalid response'));
});

test('execute handles AbortError as timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    throw err;
  };

  const result = await tool.execute({ query: 'test' }, context);
  assert.equal(result.success, false);
  assert.ok(result.content.includes('timed out'));
});
