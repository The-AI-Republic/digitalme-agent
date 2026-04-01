import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifyRequestSignature } from './hmac.js';
import { testConfig as config } from '../test/fixtures.js';

function makeRequest(body: string, signature: string, timestamp: string) {
  const headers: Record<string, string> = {
    'X-DigitalMe-Key': 'key',
    'X-DigitalMe-Signature': signature,
    'X-DigitalMe-Timestamp': timestamp,
  };

  return {
    headers,
    header(name: string) {
      return this.headers[name];
    },
    rawBody: body,
  };
}

test('verifyRequestSignature accepts a valid signature', () => {
  const body = JSON.stringify({ hello: 'world' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(`${timestamp}:${body}`)
    .digest('hex');

  assert.doesNotThrow(() => verifyRequestSignature(makeRequest(body, signature, timestamp) as never, config));
});

test('verifyRequestSignature rejects an invalid signature', () => {
  const body = JSON.stringify({ hello: 'world' });
  const timestamp = String(Math.floor(Date.now() / 1000));

  assert.throws(
    () => verifyRequestSignature(makeRequest(body, 'bad-signature', timestamp) as never, config),
    /unauthorized/,
  );
});

test('verifyRequestSignature rejects a stale timestamp', () => {
  const body = JSON.stringify({ hello: 'world' });
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - config.security.hmac_tolerance_seconds - 10);
  const signature = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(`${staleTimestamp}:${body}`)
    .digest('hex');

  assert.throws(
    () => verifyRequestSignature(makeRequest(body, signature, staleTimestamp) as never, config),
    /replay_rejected/,
  );
});

test('verifyRequestSignature rejects an invalid API key', () => {
  const body = JSON.stringify({ hello: 'world' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(`${timestamp}:${body}`)
    .digest('hex');

  const req = makeRequest(body, signature, timestamp) as never as {
    headers: Record<string, string>;
    header(name: string): string | undefined;
    rawBody: string;
  };
  req.headers['X-DigitalMe-Key'] = 'wrong-key';

  assert.throws(() => verifyRequestSignature(req as never, config), /unauthorized/);
});
