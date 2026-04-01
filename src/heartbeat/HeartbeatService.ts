import crypto from 'node:crypto';

import type { Agent } from '../agent/Agent.js';
import type { AgentConfig } from '../config/schema.js';

const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 60_000;

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private currentAbort: AbortController | null = null;
  private intervalMs = 0;
  private currentDelayMs = 0;
  private stopped = true;

  constructor(
    private readonly config: AgentConfig,
    private readonly agent: Agent,
  ) {}

  start() {
    if (!this.config.platform.base_url || !this.stopped) {
      return;
    }

    this.stopped = false;
    this.intervalMs = this.config.platform.heartbeat_interval_seconds * 1000;
    this.currentDelayMs = this.intervalMs;
    void this.runOnce();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentAbort?.abort();
    this.currentAbort = null;
  }

  private async runOnce() {
    await this.sendHeartbeat();
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runOnce();
    }, this.currentDelayMs);
  }

  private async sendHeartbeat() {
    const health = this.agent.getHealth();
    const body = JSON.stringify({
      status: health.draining ? 'draining' : 'ok',
      health,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const abort = new AbortController();
    this.currentAbort = abort;
    const timeout = setTimeout(() => {
      abort.abort();
    }, Math.max(1000, Math.min(this.intervalMs, 10_000)));
    const signature = crypto
      .createHmac('sha256', this.config.auth.signing_secret)
      .update(`${timestamp}:${body}`)
      .digest('hex');

    try {
      const response = await fetch(`${this.config.platform.base_url}/agent-connections/heartbeat`, {
        signal: abort.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DigitalMe-Key': this.config.auth.api_key,
          'X-DigitalMe-Signature': signature,
          'X-DigitalMe-Timestamp': timestamp,
        },
        body,
      });
      if (response.ok) {
        this.currentDelayMs = this.intervalMs;
      } else if (response.status === 409) {
        this.currentDelayMs = Math.min(this.currentDelayMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
        console.warn('heartbeat_not_ready', response.status, '- backing off to', this.currentDelayMs, 'ms');
      } else {
        const text = await response.text().catch(() => '');
        console.error('heartbeat_rejected', response.status, text);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') {
        console.error('heartbeat_failed', error);
      }
    } finally {
      clearTimeout(timeout);
      if (this.currentAbort === abort) {
        this.currentAbort = null;
      }
    }
  }
}
