import type { Express } from 'express';
import type { Agent } from '../agent/Agent.js';

/**
 * Register the usage reporting endpoint.
 *
 * GET /usage — returns usage aggregates for billing and monitoring.
 * Query params:
 *   - since: Unix timestamp (ms) to filter usage from (optional)
 */
export function registerUsageRoutes(app: Express, agent: Agent) {
  app.get('/usage', (req, res) => {
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
  });
}
