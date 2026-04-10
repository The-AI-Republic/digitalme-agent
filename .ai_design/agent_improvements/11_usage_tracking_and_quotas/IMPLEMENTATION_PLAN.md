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
interface ModelUsageRecord {
  requestId: string;
  conversationId: string;
  creatorId: string;
  timestamp: number;

  // Model details
  provider: string;
  model: string;
  executionContext: ExecutionContext;  // from track 09

  // Token counts
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;

  // Cost (computed from token counts + pricing)
  estimatedCostUsd: number;

  // Context
  turnNumber: number;
  toolCallCount: number;
  isRetry: boolean;
  isFallback: boolean;
}
```

### 2. Conversation-Level Cost Accumulation

Track cumulative cost per conversation:

```typescript
interface ConversationUsage {
  conversationId: string;
  creatorId: string;
  startedAt: number;
  lastUpdatedAt: number;

  totalInputTokens: number;
  totalOutputTokens: number;
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
  topCreatorsByUsage: Array<{
    creatorId: string;
    totalCostUsd: number;
    conversationCount: number;
  }>;
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

## What NOT To Borrow

- **Real-time cost display UI** — platform concern, not agent concern
- **Credit grant API** — billing is a platform responsibility
- **Interactive budget prompts** — no user interaction for budgets
- **Per-request rate limiting from API headers** — handled at the HTTP layer already

## Implementation

### Step 1: Usage Record Types

- Add `src/usage/types.ts` — `ModelUsageRecord`, `ConversationUsage`, `CreatorQuota`
- Add `src/usage/pricing.ts` — pricing registry with lookup

### Step 2: Request-Level Recording

- Add `src/usage/UsageRecorder.ts`
- Capture token counts from every model API response
- Compute estimated cost using pricing registry
- Emit to track 07 internal events

### Step 3: Conversation-Level Accumulation

- Add `src/usage/ConversationUsageTracker.ts`
- Accumulate usage across turns within `SessionState`
- Include in transcript records (track 05)
- Persist to allow cold-start restoration

### Step 4: Quota Enforcement

- Add `src/usage/QuotaEnforcer.ts`
- Pre-turn quota check integrated into `TurnExecutor.ts`
- Post-turn usage update
- Graceful refusal message when quota exceeded

### Step 5: Cost-Aware Routing Integration

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
- Conversation-level cost is tracked and available to the runtime
- Creator quota limits are enforced before model calls
- Quota exceeded results in graceful degradation, not silent failure
- Background work uses cheaper models (measurable cost difference)
- Usage data is available for platform billing integration
- Cost estimation is within 10% of actual provider billing
