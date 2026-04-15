import test from 'node:test';
import assert from 'node:assert/strict';

import { ConversationSummaryBuilder } from './ConversationSummaryBuilder.js';
import { ModelClient, generateId } from '../../models/ModelClient.js';
import type { CompletionRequest, ModelStepResult, Message } from '../../models/ModelClient.js';

class StubModelClient extends ModelClient {
  public lastRequest?: CompletionRequest;
  constructor(private readonly response: string) { super(); }

  async generate(request: CompletionRequest): Promise<ModelStepResult> {
    this.lastRequest = request;
    return { type: 'final_text', text: this.response };
  }
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `Message ${i}`,
    id: generateId(),
  }));
}

test('summarize extracts content from <summary> tags', async () => {
  const raw = '<analysis>Some analysis here.</analysis>\n<summary>The actual summary content.</summary>';
  const client = new StubModelClient(raw);
  const builder = new ConversationSummaryBuilder(client);

  const messages = makeMessages(6);
  const result = await builder.summarize(messages, 4);

  assert.equal(result.text, 'The actual summary content.');
  assert.equal(result.coversMessageCount, 4);
  assert.ok(result.generatedAt <= Date.now());
  assert.ok(result.estimatedTokens > 0);
});

test('summarize strips analysis tags and returns summary body only', async () => {
  const raw = '<analysis>long analysis...</analysis><summary>clean summary</summary>';
  const client = new StubModelClient(raw);
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(4), 3);
  assert.equal(result.text, 'clean summary');
});

test('summarize uses full text when no summary tags present', async () => {
  const raw = 'Just plain text response without tags.';
  const client = new StubModelClient(raw);
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(2), 2);
  assert.equal(result.text, 'Just plain text response without tags.');
});

test('summarize strips analysis but uses remaining text when no summary tags', async () => {
  const raw = '<analysis>some analysis</analysis>remaining text here';
  const client = new StubModelClient(raw);
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(2), 2);
  assert.equal(result.text, 'remaining text here');
});

test('summarize sends only messages up to cutoffIndex to model', async () => {
  const client = new StubModelClient('<summary>ok</summary>');
  const builder = new ConversationSummaryBuilder(client);

  const messages = makeMessages(10);
  await builder.summarize(messages, 5);

  // Should have 5 original messages + 1 summary prompt = 6 messages
  assert.ok(client.lastRequest);
  assert.equal(client.lastRequest.messages.length, 6);
  assert.equal(client.lastRequest.messages[0].content, 'Message 0');
  assert.equal(client.lastRequest.messages[4].content, 'Message 4');
});

test('summarize estimates tokens from summary text length', async () => {
  const summaryText = 'A'.repeat(400); // 400 bytes / 4 = 100 tokens
  const client = new StubModelClient(`<summary>${summaryText}</summary>`);
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(2), 2);
  assert.equal(result.estimatedTokens, 100);
});

test('summarize handles empty model response', async () => {
  const client = new StubModelClient('');
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(2), 2);
  assert.equal(result.text, '');
});

test('summarize handles tool_calls response type gracefully', async () => {
  const client = new (class extends ModelClient {
    async generate(): Promise<ModelStepResult> {
      return { type: 'tool_calls', calls: [] };
    }
  })();
  const builder = new ConversationSummaryBuilder(client);

  const result = await builder.summarize(makeMessages(2), 2);
  assert.equal(result.text, '');
});
