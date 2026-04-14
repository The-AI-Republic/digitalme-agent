# 11 — Usage Tracking and Quotas

## What This Track Covers

Per-creator and per-conversation token/cost accounting, usage quotas and budget enforcement, usage analytics for billing and optimization, and cost visibility for platform operations.

## Why This Is Not Covered by Existing Tracks

Track 02 (Context Management) includes `TokenBudget` for prompt-size management within a single conversation. That is about _prompt engineering_ — keeping the prompt within the model's context window.

This track is about _business-level cost management_ — tracking how much each creator's agent costs, enforcing spending limits, and providing usage data for billing and optimization. These are different concerns with different data models.

## What Claudy Does

Claudy has comprehensive cost and quota management:

### Cost Tracking (`cost-tracker.ts`)
- Per-request token usage recording (input tokens, output tokens, cache reads/writes)
- Cumulative session cost calculation
- Model-specific pricing (cost per input token, cost per output token)
- Real-time cost display in UI

### Quota Management (`services/claudeAiLimits.ts`)
- Quota status extraction from API response headers
- Remaining quota tracking (tokens, requests)
- Overage handling (credit grant API, reject if over)
- Rate limit detection from 429 headers

### Usage Analytics
- Token usage per request logged to analytics
- Session-level usage aggregation
- Model selection influenced by remaining budget

### Budget Controls
- Token budget tracking per turn
- Budget downgrade on retry (cheaper model when budget is tight)
- Maximum cost per session (implicit through model selection)

## Current DigitalMe Agent Situation

- Token usage is captured from API responses but not aggregated
- No per-creator cost tracking
- No conversation-level cost accumulation
- No spending limits or quota enforcement
- No usage data exposed for billing
- No cost-aware decision making
- The platform has no visibility into agent-side costs

## What To Borrow

### 1. Request-Level Usage Recording

Every model call should produce a structured usage record:

```typescript
type UsageExecutionContext = 'primary_turn' | 'fallback_turn' | 'background_turn';

interface ModelUsageRecord {
  requestId: string;
  conversationId: string;
  timestamp: number;

  // Model details
  provider: string;
  model: string;
  executionContext: UsageExecutionContext;

  // Token counts
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Optional provider-specific usage extensions
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;

  // Cost (computed from token counts + pricing)
  estimatedCostUsd: number;

  // Context
  modelCallIndex: number;
  turnNumber: number;
  toolCallCount: number;
  isRetry: boolean;
  isFallback: boolean;
}
```

Important integration detail:
- Recording must happen immediately after every `ModelClient.generate()` call returns, before the ReAct loop continues.
- This is not derived from the final turn result, because one turn may contain multiple model calls from tool loops, retries, max-output recovery, or fallback attempts.
- `TurnExecutionState.tokenUsage` can remain as a summary field for compatibility, but usage accounting must append per-call `ModelUsageRecord`s instead of overwriting a single value.

To support this, usage extraction needs an explicit provider-normalization layer:

```typescript
interface ExtendedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

Each model client should map provider-specific response fields into `ExtendedTokenUsage`. For example:
- Anthropic: include cache read/write token counts when present
- OpenAI-compatible providers: include reasoning token details when exposed
- Providers without extended fields still populate the base `input/output/total` fields

### 2. Conversation-Level Cost Accumulation

Track cumulative cost per conversation:

```typescript
interface ConversationUsage {
  conversationId: string;
  startedAt: number;
  lastUpdatedAt: number;

  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;

  turnCount: number;
  modelCallCount: number;
  toolCallCount: number;

  // Breakdown by execution context
  mainConversationCost: number;
  backgroundWorkCost: number;

  // Breakdown by model
  costByModel: Record<string, number>;
}
```

`creatorId` is intentionally omitted from per-request and per-conversation runtime types. Each agent process serves a single creator, so creator identity comes from loaded config and can be attached only when exporting usage to the platform.

### 3. Creator-Level Quota Enforcement

Enforce spending limits at the creator level:

```typescript
interface CreatorQuota {
  /** Max USD spend per conversation */
  maxCostPerConversation?: number;
  /** Max USD spend per day across all conversations */
  maxCostPerDay?: number;
  /** Max USD spend per month */
  maxCostPerMonth?: number;
  /** Max total tokens per conversation */
  maxTokensPerConversation?: number;
  /** Max turns per conversation */
  maxTurnsPerConversation?: number;
}

interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  remainingBudget?: number;
  suggestedAction?: 'proceed' | 'downgrade_model' | 'refuse';
}
```

Enforcement points:
- **Before model call**: Check if estimated cost would exceed quota
- **After model call**: Update usage counters, check if limits reached
- **Before next turn**: Verify conversation hasn't exceeded turn/cost limits

Scope split:
- The agent is the source of truth for per-conversation quotas (`maxCostPerConversation`, `maxTokensPerConversation`, `maxTurnsPerConversation`)
- Daily and monthly quotas require durable aggregation across restarts
- The cleanest long-term split is for the platform to enforce daily/monthly creator budgets, while the agent still emits durable usage data needed for that enforcement
- If temporary agent-side daily/monthly enforcement is needed before platform support exists, it must use persisted rolling totals rather than in-memory counters

### 4. Model Pricing Registry

Maintain a pricing table for cost estimation:

```typescript
interface ModelPricing {
  provider: string;
  model: string;
  inputTokenCostPer1M: number;   // USD per 1M input tokens
  outputTokenCostPer1M: number;  // USD per 1M output tokens
  cacheReadCostPer1M?: number;
  cacheWriteCostPer1M?: number;
}

const PRICING: ModelPricing[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokenCostPer1M: 3.0, outputTokenCostPer1M: 15.0 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokenCostPer1M: 0.8, outputTokenCostPer1M: 4.0 },
  { provider: 'openai', model: 'gpt-4o', inputTokenCostPer1M: 2.5, outputTokenCostPer1M: 10.0 },
  // ...
];
```

Pricing should not be hardcoded in business logic. Preferred shape:
- Store pricing in config or a versioned data file loaded at startup
- Document that estimates are approximate and intended for quota guidance and billing telemetry, not exact invoice reconciliation
- Preserve the success criterion that estimates stay within roughly 10% of provider billing

### 5. Usage Reporting API

Expose usage data for the platform:

```typescript
// New endpoint or extension to existing health endpoint
interface UsageReport {
  period: { start: number; end: number };
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
  conversationCount: number;
  avgCostPerConversation: number;
  creatorId?: string;
}
```

### 6. Cost-Aware Runtime Decisions

Usage data should influence runtime behavior:

| Situation | Action |
|-----------|--------|
| Creator approaching daily limit | Switch to background model for all calls |
| Conversation cost > 80% of limit | Warn in internal events, consider model downgrade |
| Conversation cost > limit | Refuse further turns with graceful message |
| Background model much cheaper | Use background model for all non-fan-facing work |
| High token usage in conversation | Trigger more aggressive compaction (track 02) |

This connects to track 09 (Model Routing): quota pressure becomes a routing signal.

Track 09 dependency note:
- Step 5 depends on Track 09 runtime pieces that do not exist yet in the current codebase
- Specifically: `background_model` config support, `ModelClientFactory.createBackgroundClient()`, and model-routing types for execution context
- Tracks 1-4 in this document should be implementable without Track 09 by using the local `UsageExecutionContext` enum above
- Step 5 should remain explicitly conditional until Track 09 lands, or Track 11 should pull in the minimal background-model plumbing as a prerequisite

## What NOT To Borrow

- **Real-time cost display UI** — platform concern, not agent concern
- **Credit grant API** — billing is a platform responsibility
- **Interactive budget prompts** — no user interaction for budgets
- **Per-request rate limiting from API headers** — handled at the HTTP layer already

## Implementation

### Step 0: Provider Usage Extraction

- Extend model usage normalization to support provider-specific token fields
- Update model clients to populate `ExtendedTokenUsage` from API responses
- Preserve backward compatibility for callers that only read `input/output/total`

### Step 1: Usage Record Types

- Add `src/usage/types.ts` — `ModelUsageRecord`, `ConversationUsage`, `CreatorQuota`
- Add `src/usage/pricing.ts` — pricing registry with lookup

### Step 2: Request-Level Recording

- Add `src/usage/UsageRecorder.ts`
- Hook recording directly into every `ModelClient.generate()` call site in `TurnExecutor`
- Capture token counts from every model API response
- Compute estimated cost using pricing registry
- Emit to track 07 internal events
- Track call metadata: retry, fallback, and execution context
- Append per-call records; do not derive usage only from the final turn result

### Step 3: Conversation-Level Accumulation

- Add `src/usage/ConversationUsageTracker.ts`
- Accumulate usage across turns within `SessionState`
- Aggregate forked/background usage into the parent conversation usage totals
- Include in transcript records (track 05)
- Persist to allow cold-start restoration
- Transcript persistence should be append-only per usage record, with checkpointed conversation totals for fast restoration after restart

### Step 4: Quota Enforcement

- Add `src/usage/QuotaEnforcer.ts`
- Pre-turn quota check integrated into `TurnExecutor.ts`
- Post-turn usage update
- Graceful refusal message when quota exceeded
- Enforce per-conversation limits in-agent
- Treat daily/monthly budget enforcement as platform-owned unless temporary persisted rolling totals are added locally

### Step 5: Cost-Aware Routing Integration

- Conditional on Track 09, or pull in its minimal background-model plumbing here
- Wire quota pressure into track 09 `ModelRouter`
- When approaching limits: prefer background model, increase compaction aggressiveness
- When exceeded: refuse with creator-configured message

### Step 6: Usage Reporting (optional)

- Add usage aggregation for platform consumption
- Could be a new endpoint or data export
- Platform can use for billing, dashboards, creator analytics

## Config Schema Extension

```yaml
quotas:
  max_cost_per_conversation_usd: 0.50
  max_cost_per_day_usd: 10.00
  max_tokens_per_conversation: 500000
  max_turns_per_conversation: 50
  on_quota_exceeded: graceful_refuse  # graceful_refuse | downgrade_model | silent_stop
  quota_warning_threshold: 0.8  # warn at 80% of limit
```

## Dependencies

- Track 02 (Context) — compaction aggressiveness influenced by cost
- Track 07 (Events) — usage events emitted as internal events
- Track 09 (Model Routing) — cost-aware model selection

## Success Criteria

- Every model call produces a structured usage record
- Multi-call turns preserve all model-call usage, not just the final call
- Conversation-level cost is tracked and available to the runtime
- Creator quota limits are enforced before model calls
- Quota exceeded results in graceful degradation, not silent failure
- Background work uses cheaper models (measurable cost difference)
- Usage data is available for platform billing integration
- Cost estimation is within 10% of actual provider billing
