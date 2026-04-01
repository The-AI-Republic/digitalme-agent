import type { Express } from 'express';

import { Agent } from '../agent/Agent.js';
import { HealthMonitor } from '../health/health-monitor.js';

export function registerHealthRoutes(app: Express, agent: Agent) {
  const monitor = new HealthMonitor(agent);
  app.get('/health', (_req, res) => {
    res.json(monitor.snapshot());
  });
}
