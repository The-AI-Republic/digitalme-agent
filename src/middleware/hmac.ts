import crypto from 'node:crypto';

import type { Request } from 'express';

import type { AgentConfig } from '../config/schema.js';

function getHeader(req: Request, name: string): string {
  const value = req.header(name);
  if (!value) {
    throw new Error(`missing_header:${name}`);
  }
  return value;
}

function timingSafeEqualString(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyRequestSignature(req: Request, config: AgentConfig) {
  const key = getHeader(req, 'X-DigitalMe-Key');
  const signature = getHeader(req, 'X-DigitalMe-Signature');
  const timestamp = getHeader(req, 'X-DigitalMe-Timestamp');

  if (!timingSafeEqualString(key, config.auth.api_key)) {
    throw new Error('unauthorized');
  }

  const now = Math.floor(Date.now() / 1000);
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || Math.abs(now - numericTimestamp) > config.security.hmac_tolerance_seconds) {
    throw new Error('replay_rejected');
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';

  const expected = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');

  if (!timingSafeEqualString(signature, expected)) {
    throw new Error('unauthorized');
  }
}
