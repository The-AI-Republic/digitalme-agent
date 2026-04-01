import type { Express } from 'express';

import type { AgentConfig } from '../config/schema.js';
import { verifyRequestSignature } from '../middleware/hmac.js';
import { verifyRequestSchema } from '../protocol/schemas.js';

export function registerVerifyRoutes(app: Express, config: AgentConfig) {
  app.post('/verify', (req, res) => {
    try {
      verifyRequestSignature(req, config);
      const payload = verifyRequestSchema.parse(req.body);
      res.json({ challenge: payload.challenge });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unauthorized';
      const status = message === 'unauthorized' || message === 'replay_rejected' || message.startsWith('missing_header:') ? 401 : 422;
      res.status(status).json({ error: message });
    }
  });
}
