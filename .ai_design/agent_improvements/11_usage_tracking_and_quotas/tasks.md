# 11 — Usage Tracking and Quotas Tasks

## Step 1: Usage Record Types

- [ ] Define `ModelUsageRecord` type in `src/usage/types.ts`
- [ ] Define `ConversationUsage` type
- [ ] Define `CreatorQuota` type
- [ ] Add `src/usage/pricing.ts` — model pricing registry
- [ ] Add pricing lookup function `getCostEstimate(model, inputTokens, outputTokens)`

## Step 2: Request-Level Recording

- [ ] Add `src/usage/UsageRecorder.ts`
- [ ] Capture token counts from every model API response
- [ ] Compute estimated cost using pricing registry
- [ ] Emit usage records to track 07 internal events
- [ ] Include execution context (main vs background) in records

## Step 3: Conversation-Level Accumulation

- [ ] Add `src/usage/ConversationUsageTracker.ts`
- [ ] Accumulate usage across turns in `SessionState`
- [ ] Track breakdown by execution context (main vs background)
- [ ] Track breakdown by model
- [ ] Include in transcript records (track 05)
- [ ] Persist for cold-start restoration

## Step 4: Quota Enforcement

- [ ] Add `src/usage/QuotaEnforcer.ts`
- [ ] Extend creator config with quota settings
- [ ] Pre-turn quota check in `TurnExecutor.ts`
- [ ] Post-turn usage update
- [ ] Graceful refusal message when quota exceeded
- [ ] Warning events when approaching limits (80% threshold)

## Step 5: Cost-Aware Routing Integration

- [ ] Wire quota pressure into track 09 `ModelRouter`
- [ ] Approaching limits → prefer background model
- [ ] Approaching limits → increase compaction aggressiveness (track 02)
- [ ] Exceeded → refuse with creator-configured message
- [ ] Log cost-aware routing decisions

## Step 6: Usage Reporting (optional)

- [ ] Add usage aggregation for platform consumption
- [ ] Per-creator usage breakdown
- [ ] Expose via health endpoint or dedicated endpoint
- [ ] Format suitable for billing system integration
