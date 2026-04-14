import test from 'node:test';
import assert from 'node:assert/strict';

import { WebSearchTool } from './web-search.js';

const tool = new WebSearchTool();

test('WebSearchTool.inputSchema rejects empty query', () => {
  const result = tool.inputSchema.safeParse({ query: '' });
  assert.equal(result.success, false);
});

test('WebSearchTool.inputSchema accepts valid query', () => {
  const result = tool.inputSchema.safeParse({ query: 'hello world' });
  assert.equal(result.success, true);
});

test('WebSearchTool.isConcurrencySafe returns true', () => {
  assert.equal(tool.isConcurrencySafe!({ query: 'test' }), true);
});

test('WebSearchTool.definition.parameters matches schema shape', () => {
  const params = tool.definition.function.parameters;
  assert.equal((params as any).type, 'object');
  assert.ok((params as any).properties.query);
  assert.deepEqual((params as any).required, ['query']);
});

test('WebSearchTool.metadata has correct values', () => {
  assert.equal(tool.metadata.timeoutMs, 5_000);
  assert.equal(tool.metadata.maxResultChars, 4_000);
  assert.equal(tool.metadata.policyCategory, 'search');
});

test('WebSearchTool.summarizeResult produces summary', () => {
  const result = {
    success: true,
    data: { query: 'test', results: [{ text: 'a' }, { text: 'b' }] },
    renderForModel: () => 'rendered',
  };
  const summary = tool.summarizeResult!({ query: 'test' }, result);
  assert.ok(summary.includes('web_search'));
  assert.ok(summary.includes('2 results'));
});

// --- Execution path tests ---

const NEVER_ABORT = new AbortController().signal;

test('WebSearchTool.execute returns success with parsed upstream response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    Heading: 'Node.js',
    AbstractText: 'A JavaScript runtime.',
    AbstractURL: 'https://nodejs.org',
    RelatedTopics: [
      { Text: 'Node is event-driven', FirstURL: 'https://example.com/1' },
      { Text: 'Built on V8 engine', FirstURL: 'https://example.com/2' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await tool.execute({ query: 'nodejs' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    assert.equal(result.success, true);
    assert.equal(result.data.heading, 'Node.js');
    assert.equal(result.data.abstract, 'A JavaScript runtime.');
    assert.equal(result.data.results.length, 2);
    assert.equal(result.data.results[0].text, 'Node is event-driven');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSearchTool.execute renderForModel includes heading and results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    Heading: 'Test',
    AbstractText: 'Abstract text here.',
    AbstractURL: 'https://example.com',
    RelatedTopics: [
      { Text: 'Topic one', FirstURL: 'https://example.com/1' },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await tool.execute({ query: 'test' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    const rendered = result.renderForModel();
    assert.ok(rendered.includes('Test: Abstract text here.'));
    assert.ok(rendered.includes('Topic one'));
    assert.ok(rendered.includes('https://example.com/1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSearchTool.execute returns failure on non-2xx response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Server Error', { status: 503 });

  try {
    const result = await tool.execute({ query: 'fail' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    assert.equal(result.success, false);
    assert.ok(result.data.error?.includes('503'));
    assert.ok(result.renderForModel().includes('503'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSearchTool.execute returns failure on invalid JSON response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } });

  try {
    const result = await tool.execute({ query: 'bad' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    assert.equal(result.success, false);
    assert.ok(result.data.error?.includes('invalid response'));
    assert.ok(result.renderForModel().includes('invalid response'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSearchTool.execute returns failure on fetch error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };

  try {
    const result = await tool.execute({ query: 'err' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    assert.equal(result.success, false);
    assert.ok(result.data.error?.includes('network down'));
    assert.ok(result.renderForModel().includes('network down'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSearchTool.execute handles empty topics gracefully', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    RelatedTopics: [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await tool.execute({ query: 'obscure' }, { conversationId: 'c1', signal: NEVER_ABORT, policyConfig: {} });
    assert.equal(result.success, true);
    assert.equal(result.data.results.length, 0);
    assert.ok(result.renderForModel().includes('No useful public web results'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
