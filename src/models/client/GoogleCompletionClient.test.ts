import assert from 'node:assert/strict';
import test from 'node:test';

import { generateId, type CompletionRequest, type Message } from '../ModelClient.js';
import { GoogleCompletionClient } from './GoogleCompletionClient.js';

test('GoogleCompletionClient uses the tool name when serializing function responses', () => {
  const client = new GoogleCompletionClient({
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
  });

  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      id: generateId(),
      toolCalls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'web_search',
          arguments: '{"query":"hello"}',
        },
      }],
    },
    {
      role: 'tool',
      content: '{"results":[]}',
      toolCallId: 'call_1',
      toolName: 'web_search',
      id: generateId(),
    },
  ];

  const contents = client.buildContents(messages);
  assert.equal(contents[1].parts[0].functionResponse?.name, 'web_search');
});

test('GoogleCompletionClient passes tool parameters to Google function declarations', () => {
  const client = new GoogleCompletionClient({
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
  });

  const request: CompletionRequest = {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi', id: generateId() }],
    tools: [{
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
    }],
  };

  const tools = (client as any).buildTools(request);
  const decl = tools[0].functionDeclarations[0];
  assert.equal(decl.name, 'web_search');
  assert.deepEqual(decl.parameters.properties, {
    query: { type: 'string', description: 'The search query' },
  });
  assert.deepEqual(decl.parameters.required, ['query']);
});
