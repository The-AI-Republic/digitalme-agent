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
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
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

  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  if (rawBody === undefined) {
    throw new Error('missing_body');
  }

  const expected = crypto
    .createHmac('sha256', config.auth.signing_secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');

  if (!timingSafeEqualString(signature, expected)) {
    throw new Error('unauthorized');
  }
}
