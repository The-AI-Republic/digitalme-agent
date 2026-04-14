# 11 — Usage Tracking and Quotas Tasks

## Step 0: Provider Usage Extraction

- [ ] Extend model usage normalization to support provider-specific fields
- [ ] Update `AnthropicClient` to capture cache read/write token counts when available
- [ ] Update OpenAI-compatible clients to capture reasoning-token details when available
- [ ] Preserve compatibility for existing code that only reads `inputTokens`, `outputTokens`, `totalTokens`

## Step 1: Usage Record Types

- [ ] Define `ModelUsageRecord` type in `src/usage/types.ts`
- [ ] Define `ConversationUsage` type
- [ ] Define `CreatorQuota` type
- [ ] Add `src/usage/pricing.ts` — model pricing registry
- [ ] Add pricing lookup function `getCostEstimate(model, inputTokens, outputTokens)`
- [ ] Use a local usage execution-context enum instead of depending on Track 09 types
- [ ] Remove request-scoped `creatorId` fields from runtime usage types

## Step 2: Request-Level Recording

- [ ] Add `src/usage/UsageRecorder.ts`
- [ ] Hook recording directly into each `ModelClient.generate()` call site in `TurnExecutor.ts`
- [ ] Capture token counts from every model API response
- [ ] Compute estimated cost using pricing registry
- [ ] Emit usage records to track 07 internal events
- [ ] Include execution context (main vs background) in records
- [ ] Append per-call records instead of deriving usage from the final turn result only

## Step 3: Conversation-Level Accumulation

- [ ] Add `src/usage/ConversationUsageTracker.ts`
- [ ] Accumulate usage across turns in `SessionState`
- [ ] Track breakdown by execution context (main vs background)
- [ ] Track breakdown by model
- [ ] Aggregate forked/background usage back into the parent conversation totals
- [ ] Include in transcript records (track 05)
- [ ] Persist for cold-start restoration
- [ ] Add checkpointed conversation totals so restart recovery does not require full transcript replay

## Step 4: Quota Enforcement

- [ ] Add `src/usage/QuotaEnforcer.ts`
- [ ] Extend creator config with quota settings
- [ ] Pre-turn quota check in `TurnExecutor.ts`
- [ ] Post-turn usage update
- [ ] Graceful refusal message when quota exceeded
- [ ] Warning events when approaching limits (80% threshold)
- [ ] Enforce per-conversation quotas in-agent
- [ ] Keep daily/monthly quotas platform-owned unless persisted rolling totals are added locally

## Step 5: Cost-Aware Routing Integration

- [ ] Make this step conditional on Track 09, or pull in minimal Track 09 background-model plumbing first
- [ ] Wire quota pressure into track 09 `ModelRouter`
- [ ] Approaching limits → prefer background model
- [ ] Approaching limits → increase compaction aggressiveness (track 02)
- [ ] Exceeded → refuse with creator-configured message
- [ ] Log cost-aware routing decisions

## Step 6: Usage Reporting (optional)

- [ ] Add usage aggregation for platform consumption
- [ ] Export creator identity from config at reporting time if the platform needs it
- [ ] Expose via health endpoint or dedicated endpoint
- [ ] Format suitable for billing system integration

## Cross-Cutting Notes

- [ ] Load pricing from config or a versioned data file instead of hardcoding business logic constants
- [ ] Document that pricing is approximate and intended for quota guidance and telemetry
