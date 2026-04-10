# 09 — Model Routing and Intelligence

## What This Track Covers

Multi-model selection, effort-aware routing, automatic fallback chains, cost-optimized model assignment for different execution contexts, and model capability detection.

## Why This Is Not Covered by Existing Tracks

Track 04 (Recovery and Continuation) mentions "fallback model" as one recovery path but treats it as a single binary switch. This track designs a full model routing subsystem that makes intelligent model decisions _before_ failure, not only _after_ failure.

## What Claudy Does

Claudy has a sophisticated model layer:

- **Model registry** with named roles: `getMainLoopModel()`, `getSmallFastModel()`, `getDefaultSonnetModel()`, `getDefaultOpusModel()`
- **Effort levels**: `resolveAppliedEffort()` adjusts model behavior (e.g., thinking budget, response depth) based on task complexity
- **Thinking configuration**: Per-model extended thinking support with configurable token budgets (`thinkingConfig`, `shouldEnableThinkingByDefault()`)
- **Automatic downgrade**: After repeated 529 errors, switches from expensive to cheaper model automatically
- **Cost-aware subagent routing**: Background/forked agents use cheaper models than the main conversation loop
- **Model feature detection**: Runtime checks for vision, prompt caching eligibility, thinking support
- **Model string normalization**: `getModelStrings()` handles alias resolution and display names
- **Dynamic model override**: Live model switching per-session and per-request

Key files:
- Model selection logic scattered across `query.ts`, `QueryEngine.ts`
- Model metadata in `services/api/` and configuration
- Effort resolution in query config

## Current DigitalMe Agent Situation

The agent has a basic model abstraction:

- `src/models/` with a factory pattern supporting OpenAI, Anthropic, xAI, Groq, Google AI, Fireworks, Together
- Creator config specifies a single `model` field
- No runtime model switching
- No effort-level awareness
- No cost-aware routing for subagents vs main loop
- Fallback model is mentioned in recovery but not designed as a system

## What To Borrow

### 1. Model Role Assignment

Define named model roles rather than a single model field:

```typescript
interface ModelRoles {
  /** Primary model for fan-facing conversation */
  primary: ModelSpec;
  /** Cheaper model for background work (summaries, memory extraction) */
  background: ModelSpec;
  /** Fallback model when primary is unavailable */
  fallback?: ModelSpec;
}

interface ModelSpec {
  provider: string;
  model: string;
  /** Max context window tokens */
  contextWindow: number;
  /** Whether this model supports extended thinking */
  supportsThinking: boolean;
  /** Whether this model supports vision/images */
  supportsVision: boolean;
  /** Relative cost tier: 'low' | 'medium' | 'high' */
  costTier: CostTier;
}
```

**Why:** Today the agent uses the same model for fan conversation and background work (session memory extraction, forked agents). Background work should use cheaper models automatically.

### 2. Model Capability Detection

Before sending a request, verify the model supports the required capabilities:

- If the conversation includes images, verify `supportsVision`
- If extended thinking is requested, verify `supportsThinking`
- If the prompt exceeds the model's context window, route to a model with a larger window or trigger compaction first

```typescript
interface ModelCapabilities {
  supportsVision: boolean;
  supportsThinking: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  supportsCaching: boolean;
}

function resolveModel(
  roles: ModelRoles,
  requirements: ModelRequirements,
): ModelSpec {
  // 1. Check primary meets requirements
  // 2. If not, check if fallback does
  // 3. If neither, degrade gracefully (strip images, disable thinking)
}
```

### 3. Cost-Aware Routing for Execution Contexts

Different execution contexts should use different models:

| Context | Preferred Model Role | Rationale |
|---------|---------------------|-----------|
| Fan conversation (main loop) | `primary` | Best quality for user-facing output |
| Session memory extraction | `background` | Internal work, doesn't need best model |
| Forked agent background work | `background` | Fire-and-forget, cost-sensitive |
| Tool-use summary generation | `background` | Short structured output |
| Reactive compaction summary | `background` | Emergency recovery, speed matters |

```typescript
type ExecutionContext =
  | 'main_conversation'
  | 'memory_extraction'
  | 'forked_agent'
  | 'tool_summary'
  | 'compaction';

function getModelForContext(
  roles: ModelRoles,
  context: ExecutionContext,
): ModelSpec {
  switch (context) {
    case 'main_conversation':
      return roles.primary;
    case 'memory_extraction':
    case 'forked_agent':
    case 'tool_summary':
    case 'compaction':
      return roles.background;
  }
}
```

### 4. Automatic Fallback on Failure

Extend track 04's recovery with model-level intelligence:

```typescript
interface ModelFallbackState {
  consecutiveFailures: number;
  lastFailureTimestamp: number;
  currentRole: 'primary' | 'fallback';
  /** Auto-recover to primary after this duration */
  recoveryWindowMs: number;
}
```

Rules:
- After N consecutive 529/5xx errors on primary → switch to fallback
- After `recoveryWindowMs` elapses with no failures → attempt primary again
- If fallback also fails → terminal error (don't cascade further)
- Record model switches in internal events (track 07)

### 5. Effort-Level Routing

Not all fan messages need the same depth of response. Claudy's `resolveAppliedEffort()` pattern can be adapted:

```typescript
type EffortLevel = 'low' | 'medium' | 'high';

interface EffortConfig {
  /** Max tokens the model should generate */
  maxOutputTokens: number;
  /** Thinking budget if supported */
  thinkingBudget?: number;
  /** Temperature override */
  temperature?: number;
}

function resolveEffort(
  message: string,
  conversationLength: number,
  creatorConfig: CreatorConfig,
): EffortLevel {
  // Simple heuristics:
  // - Short casual messages → low effort
  // - Questions requiring context → medium effort
  // - Complex multi-part requests → high effort
  // Creator can set a default floor
}
```

**Why:** This directly reduces cost for simple exchanges ("hi", "thanks", "ok") while preserving quality for substantive questions.

## What NOT To Borrow

- **Interactive model selection UI** — no user-facing model picker needed
- **Per-session model override** — creators configure, fans don't choose models
- **Feature gate integration for model selection** — over-engineered for current scale
- **Prompt caching eligibility tracking** — provider-specific optimization, premature

## Implementation

### Step 1: Model Spec and Roles (types only)

Add:
- `src/models/types.ts` — `ModelSpec`, `ModelRoles`, `ModelCapabilities`, `ExecutionContext`
- Extend creator config schema to support `models.primary`, `models.background`, `models.fallback`
- Keep backward compat: single `model` field maps to `primary` only

### Step 2: Execution Context Routing

Add:
- `src/models/ModelRouter.ts` — `getModelForContext(roles, context)` with capability checks
- Update `TurnExecutor.ts` to use `ModelRouter` instead of direct model access
- Update forked agent and session memory extraction to request `background` context

### Step 3: Fallback State Machine

Add:
- `src/models/ModelFallbackTracker.ts` — tracks consecutive failures, manages primary↔fallback transitions
- Integrate with track 04 recovery paths
- Emit model switch events to track 07 internal event bus

### Step 4: Effort-Level Resolution (optional, lower priority)

Add:
- `src/models/EffortResolver.ts` — heuristic effort classification
- Wire into model call parameters (maxOutputTokens, temperature)
- Allow creator config to set effort floor/ceiling

## Config Schema Extension

```yaml
models:
  primary:
    provider: anthropic
    model: claude-sonnet-4-6
  background:
    provider: anthropic
    model: claude-haiku-4-5-20251001
  fallback:
    provider: openai
    model: gpt-4o

model_routing:
  fallback_after_consecutive_failures: 3
  recovery_window_seconds: 300
  effort:
    default: medium
    min: low
```

## Dependencies

- Track 04 (Recovery) — fallback model recovery path
- Track 07 (Events) — model switch events
- Track 08 (Forked Agents) — background model assignment

## Success Criteria

- Background work (memory extraction, forked agents, summaries) uses cheaper models automatically
- Primary model failure triggers automatic fallback with bounded recovery
- Model capabilities are checked before sending requests (no wasted calls with unsupported features)
- Creator can configure model roles in YAML config
- Cost reduction is measurable: background work should cost ≤50% of primary model cost
