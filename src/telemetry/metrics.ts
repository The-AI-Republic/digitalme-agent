import { metrics, type Meter, type Counter, type Histogram, type ObservableGauge, type Attributes } from '@opentelemetry/api';

const METER_NAME = 'digitalme-agent';

let turnCounter: Counter;
let turnDuration: Histogram;
let modelCallCounter: Counter;
let tokenCounter: Counter;
let toolCallCounter: Counter;
let toolDuration: Histogram;
let forkCounter: Counter;
let hookCounter: Counter;
let errorCounter: Counter;
let activeSessionsGauge: ObservableGauge;

let initialized = false;

export function initMetrics(
  getActiveSessions?: () => number,
): void {
  if (initialized) return;
  initialized = true;

  const meter = metrics.getMeter(METER_NAME);

  turnCounter = meter.createCounter('agent.turns.total', {
    description: 'Total turns processed',
  });
  turnDuration = meter.createHistogram('agent.turns.duration_ms', {
    description: 'Turn latency distribution',
    unit: 'ms',
  });
  modelCallCounter = meter.createCounter('agent.model_calls.total', {
    description: 'Model API calls',
  });
  tokenCounter = meter.createCounter('agent.model_calls.tokens', {
    description: 'Token usage',
  });
  toolCallCounter = meter.createCounter('agent.tool_calls.total', {
    description: 'Tool invocations',
  });
  toolDuration = meter.createHistogram('agent.tool_calls.duration_ms', {
    description: 'Tool execution latency',
    unit: 'ms',
  });
  forkCounter = meter.createCounter('agent.forks.total', {
    description: 'Fork executions',
  });
  hookCounter = meter.createCounter('agent.hooks.total', {
    description: 'Hook executions',
  });
  errorCounter = meter.createCounter('agent.errors.total', {
    description: 'Errors',
  });

  activeSessionsGauge = meter.createObservableGauge('agent.sessions.active', {
    description: 'Currently active sessions',
  });

  if (getActiveSessions) {
    activeSessionsGauge.addCallback((result) => {
      result.observe(getActiveSessions());
    });
  }
}

// ----- Recording helpers -----

export function recordTurnCompleted(model: string, durationMs: number, success: boolean): void {
  if (!initialized) return;
  turnCounter.add(1, { model, success: String(success) });
  turnDuration.record(durationMs, { model });
}

export function recordModelCall(model: string, success: boolean): void {
  if (!initialized) return;
  modelCallCounter.add(1, { model, success: String(success) });
}

export function recordTokens(model: string, inputTokens: number, outputTokens: number): void {
  if (!initialized) return;
  tokenCounter.add(inputTokens, { model, direction: 'input' });
  tokenCounter.add(outputTokens, { model, direction: 'output' });
}

export function recordToolCall(toolName: string, durationMs: number, success: boolean): void {
  if (!initialized) return;
  toolCallCounter.add(1, { tool_name: toolName, success: String(success) });
  toolDuration.record(durationMs, { tool_name: toolName });
}

export function recordFork(forkLabel: string, outcome: 'success' | 'failed' | 'rejected'): void {
  if (!initialized) return;
  forkCounter.add(1, { fork_label: forkLabel, outcome });
}

export function recordHook(hookName: string, outcome: string): void {
  if (!initialized) return;
  hookCounter.add(1, { hook_name: hookName, outcome });
}

export function recordError(errorCategory: string): void {
  if (!initialized) return;
  errorCounter.add(1, { error_category: errorCategory });
}
