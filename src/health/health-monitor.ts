import { Agent } from '../agent/Agent.js';

export class HealthMonitor {
  constructor(private readonly agent: Agent) {}

  snapshot() {
    return {
      status: 'ok',
      ...this.agent.getHealth(),
    };
  }
}
