import type { AgentConfig } from '../config/schema.js';
import type { AgentEvent, TurnExecutorLike, TurnSubmission } from './types.js';
import { EventQueue } from './EventQueue.js';
import { RolloutRecorder, type IRolloutRecorder } from './RolloutRecorder.js';
import { SessionRuntime, type SessionRuntimeConfig } from './SessionRuntime.js';
import { SessionState } from './SessionState.js';
import { TurnExecutor } from './TurnExecutor.js';

interface SessionManagerDeps {
  turnExecutor?: TurnExecutorLike;
  rolloutRecorder?: IRolloutRecorder;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly turnExecutor: TurnExecutorLike;
  private readonly rolloutRecorder: IRolloutRecorder;
  private readonly runtimeConfig: SessionRuntimeConfig;
  private draining = false;

  constructor(
    private readonly config: AgentConfig,
    deps: SessionManagerDeps = {},
  ) {
    this.turnExecutor = deps.turnExecutor ?? new TurnExecutor(config);
    this.rolloutRecorder = deps.rolloutRecorder ?? new RolloutRecorder();
    this.runtimeConfig = {
      forkedAgentsEnabled: config.forked_agents?.enabled ?? true,
      maxConcurrentForks: config.forked_agents?.max_concurrent ?? 2,
      hooksEnabled: config.hooks?.post_turn?.enabled ?? true,
      hookTimeoutMs: config.hooks?.post_turn?.timeout_ms ?? 30_000,
    };
  }

  async execute(submission: TurnSubmission, events: EventQueue<AgentEvent>) {
    if (this.draining) {
      throw new Error('shutting_down');
    }

    this.evictExpiredSessions();
    const runtime = this.getOrCreateRuntime(submission);
    await runtime.execute(submission, events);
  }

  getStats() {
    let activeTurns = 0;
    for (const runtime of this.sessions.values()) {
      if (runtime.hasActiveTurn()) {
        activeTurns += 1;
      }
    }
    return {
      activeSessions: this.sessions.size,
      activeTurns,
      sessionTtlSeconds: this.config.limits.session_ttl_seconds,
      maxActiveSessions: this.config.limits.max_active_sessions,
    };
  }

  beginDrain() {
    this.draining = true;
    for (const runtime of this.sessions.values()) {
      runtime.abortForkedAgents();
    }
  }

  private getOrCreateRuntime(submission: TurnSubmission) {
    const existing = this.sessions.get(submission.conversationId);
    if (existing) {
      return existing;
    }

    this.evictToCapacity();
    const runtime = new SessionRuntime(
      new SessionState(submission.conversationId, submission.history),
      {
        turnExecutor: this.turnExecutor,
        rolloutRecorder: this.rolloutRecorder,
      },
      this.runtimeConfig,
    );
    this.sessions.set(submission.conversationId, runtime);
    return runtime;
  }

  private evictExpiredSessions() {
    const ttlMs = this.config.limits.session_ttl_seconds * 1000;
    const cutoff = Date.now() - ttlMs;
    for (const [conversationId, runtime] of this.sessions.entries()) {
      if (runtime.hasActiveWork()) {
        continue;
      }
      if (runtime.state.getLastAccessedAt() < cutoff) {
        runtime.abortForkedAgents();
        this.sessions.delete(conversationId);
      }
    }
  }

  private evictToCapacity() {
    const maxActiveSessions = this.config.limits.max_active_sessions;
    if (this.sessions.size < maxActiveSessions) {
      return;
    }

    const idleSessions = [...this.sessions.entries()]
      .filter(([, runtime]) => !runtime.hasActiveWork())
      .sort((left, right) => left[1].state.getLastAccessedAt() - right[1].state.getLastAccessedAt());

    while (this.sessions.size >= maxActiveSessions && idleSessions.length > 0) {
      const next = idleSessions.shift();
      if (!next) {
        break;
      }
      next[1].abortForkedAgents();
      this.sessions.delete(next[0]);
    }
  }
}
