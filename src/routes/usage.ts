import type { Express } from 'express';
import type { AgentConfig } from '../config/schema.js';
import type { Agent } from '../agent/Agent.js';
import { verifyRequestSignature } from '../middleware/hmac.js';

/**
 * Register the usage reporting endpoint.
 *
 * GET /usage — returns usage aggregates for billing and monitoring.
 * Query params:
 *   - since: Unix timestamp (ms) to filter usage from (optional)
 */
export function registerUsageRoutes(app: Express, config: AgentConfig, agent: Agent) {
  app.get('/usage', (req, res) => {
    try {
      // GET requests do not pass through the JSON parser, so sign an empty body.
      (req as typeof req & { rawBody?: string }).rawBody = '';
      verifyRequestSignature(req, config);

      const sinceParam = req.query.since;
      const since = typeof sinceParam === 'string' ? parseInt(sinceParam, 10) : undefined;
      const snapshot = agent.getUsageSnapshot(
        since && !isNaN(since) ? since : undefined,
      );
      if (!snapshot) {
        res.json({ error: 'Usage tracking not available' });
        return;
      }
      res.json(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unauthorized';
      const status = message === 'unauthorized' || message === 'replay_rejected' || message.startsWith('missing_header:')
        ? 401
        : 422;
      res.status(status).json({ error: message });
    }
  });
}
