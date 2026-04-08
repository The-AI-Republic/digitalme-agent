import assert from 'node:assert/strict';
import test from 'node:test';
import { initSse, writeSse } from './sse.js';

function createFakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  const written: string[] = [];
  let flushed = false;

  return {
    status(code: number) { statusCode = code; },
    setHeader(name: string, value: string) { headers[name] = value; },
    flushHeaders() { flushed = true; },
    write(data: string) { written.push(data); },
    _getStatus: () => statusCode,
    _getHeaders: () => headers,
    _getWritten: () => written,
    _getFlushed: () => flushed,
  };
}

test('initSse sets correct status and headers', () => {
  const res = createFakeResponse();
  initSse(res as any);

  assert.equal(res._getStatus(), 200);
  assert.equal(res._getHeaders()['Content-Type'], 'text/event-stream');
  assert.equal(res._getHeaders()['Cache-Control'], 'no-cache');
  assert.equal(res._getHeaders()['Connection'], 'keep-alive');
  assert.equal(res._getFlushed(), true);
});

test('writeSse writes JSON with SSE format', () => {
  const res = createFakeResponse();
  writeSse(res as any, { type: 'text_delta', content: 'hello' });

  const written = res._getWritten();
  assert.equal(written.length, 1);
  assert.equal(written[0], 'data: {"type":"text_delta","content":"hello"}\n\n');
});

test('writeSse handles nested objects', () => {
  const res = createFakeResponse();
  writeSse(res as any, { nested: { a: 1 } });

  const written = res._getWritten();
  assert.ok(written[0].startsWith('data: '));
  assert.ok(written[0].endsWith('\n\n'));
  const parsed = JSON.parse(written[0].slice(6));
  assert.deepEqual(parsed, { nested: { a: 1 } });
});
