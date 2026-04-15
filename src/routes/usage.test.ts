import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { registerUsageRoutes } from './usage.js';
import { testConfig } from '../test/fixtures.js';

type RouteHandler = (req: FakeRequest, res: FakeResponse) => void;

class FakeResponse {
  statusCode = 200;
  body: unknown = undefined;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(data: unknown) {
    this.body = data;
    return this;
  }
}

class FakeRequest {
  rawBody = '';
  query: Record<string, string> = {};
  private headers: Record<string, string> = {};

  constructor(headers?: Record<string, string>, query?: Record<string, string>) {
    this.headers = headers ?? {};
    this.query = query ?? {};
  }

  header(name: string): string | undefined {
    return this.headers[name] ?? this.headers[name.toLowerCase()];
  }
}

function signRequest(body: string, config = testConfig): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${timestamp}:${body}`;
  const signature = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(payload)
    .digest('hex');

  return {
    'X-DigitalMe-Key': config.auth.api_key,
    'X-DigitalMe-Signature': signature,
    'X-DigitalMe-Timestamp': timestamp,
  };
}

function captureGetRoute(): { handler: RouteHandler } {
  const captured: { handler: RouteHandler } = { handler: () => {} };
  const fakeApp = {
    get(_path: string, handler: RouteHandler) {
      captured.handler = handler;
    },
  };

  const fakeAgent = {
    getUsageSnapshot: (since?: number) => {
      if (since === 999) return undefined;
      return { totalTokens: 1000, since: since ?? 0 };
    },
  };

  registerUsageRoutes(fakeApp as any, testConfig, fakeAgent as any);
  return captured;
}

test('usage route returns snapshot on valid signed request', () => {
  const { handler } = captureGetRoute();
  const headers = signRequest('');
  const req = new FakeRequest(headers);
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { totalTokens: 1000, since: 0 });
});

test('usage route passes since parameter to agent', () => {
  const { handler } = captureGetRoute();
  const headers = signRequest('');
  const req = new FakeRequest(headers, { since: '5000' });
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 200);
  assert.ok((res.body as any).since === 5000);
});

test('usage route returns error when snapshot is null', () => {
  const { handler } = captureGetRoute();
  const headers = signRequest('');
  const req = new FakeRequest(headers, { since: '999' });
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { error: 'Usage tracking not available' });
});

test('usage route returns 401 for missing auth headers', () => {
  const { handler } = captureGetRoute();
  const req = new FakeRequest({});
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 401);
  assert.ok((res.body as any).error);
});

test('usage route returns 401 for wrong api key', () => {
  const { handler } = captureGetRoute();
  const headers = signRequest('');
  headers['X-DigitalMe-Key'] = 'wrong-key';
  const req = new FakeRequest(headers);
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 401);
});

test('usage route ignores non-numeric since param', () => {
  const { handler } = captureGetRoute();
  const headers = signRequest('');
  const req = new FakeRequest(headers, { since: 'not-a-number' });
  const res = new FakeResponse();

  handler(req as any, res as any);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { totalTokens: 1000, since: 0 });
});
