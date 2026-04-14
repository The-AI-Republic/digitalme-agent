# Track 11: Usage Tracking and Quotas -- Gap Analysis

## Summary

Core usage tracking infrastructure is in place with good test coverage (1,048 lines across 6 test files). Several critical gaps exist around provider token extraction, usage persistence, quota warnings, and cost-aware routing integration.

---

## Step 0: Provider Usage Extraction

**Status: NO**

| Task | Status | Notes |
|------|--------|-------|
| `AnthropicClient` capture cache read/write tokens | NO | `cache_read_input_tokens` and `cache_creation_input_tokens` ignored |
| OpenAI client capture reasoning tokens | NO | Not extracted |
| `ExtendedTokenUsage` type | NO | `TokenUsage` only has base fields |

**Impact:** Cost estimates for Anthropic with prompt caching are inaccurate -- cache-read tokens billed at lower rate but counted at full input rate.

---

## Step 1: Usage Record Types

**Status: YES (with minor deviations)**

| Task | Status | Notes |
|------|--------|-------|
| `ModelUsageRecord` type | YES | |
| `ConversationUsage` type | YES | Missing `totalTokens` field (derivable) |
| `CreatorQuota` type | YES | |
| Pricing registry | YES | Comprehensive table with Anthropic, OpenAI, xAI, Google, Groq |
| `getCostEstimate()` | YES | Accepts cache params but callers never pass them |
| `creatorId` removed from runtime types | **NO** | Still present in `ModelUsageRecord` and `ConversationUsage` |

---

## Step 2: Request-Level Recording

**Status: YES**

`UsageRecorder` with listener pattern. Recording hooked into `TurnExecutor` after each model call. Yields `usage` events.

---

## Step 3: Conversation-Level Accumulation

**Status: PARTIAL**

| Task | Status | Notes |
|------|--------|-------|
| `ConversationUsageTracker` | YES | Precision rounding, main/background breakdown |
| Aggregate forked agent usage | PARTIAL | Depends on fork wiring |
| Include in transcript records | **NO** | |
| Persist for cold-start restoration | **NO** | `restore()`/`snapshot()` exist but never called |
| Checkpointed conversation totals | **NO** | |

**Critical:** Usage counters reset on process restart. Daily/monthly quota enforcement is unreliable.

---

## Step 4: Quota Enforcement

**Status: PARTIAL**

| Task | Status | Notes |
|------|--------|-------|
| `QuotaEnforcer` | YES | Conversation, daily, monthly checks |
| Pre-turn check in TurnExecutor | YES | Via `CostAwareRouter.evaluate()` |
| Graceful refusal on exceeded | YES | |
| Warning events near limits | **NO** | `QuotaEnforcer.onWarning()` exists but never wired to event stream |
| Daily/monthly quota reliability | **NO** | In-memory only, resets on restart |

**Bug:** `quota_warning` events defined in `AgentEvent` but never emitted by TurnExecutor. No advance warning before hard refusal.

---

## Step 5: Cost-Aware Routing Integration

**Status: PARTIAL**

| Task | Status | Notes |
|------|--------|-------|
| Wire quota pressure into ModelRouter (Track 09) | **NO** | Completely separate systems |
| Approaching limits -> prefer background model | PARTIAL | `CostAwareRouter` returns `useFallbackModel` but independent of Track 09 |
| Approaching limits -> increase compaction | **NO** | `increaseCompaction` flag returned but never consumed |
| Log cost-aware decisions | PARTIAL | Only on actual downgrade |

---

## Step 6: Usage Reporting

**Status: PARTIAL**

| Task | Status | Notes |
|------|--------|-------|
| `UsageAggregator.snapshot()` | YES | |
| `/usage` endpoint (HMAC-authenticated) | YES | |
| Export creator identity at reporting time | **NO** | No `creatorId` in snapshot |
| Daily/monthly breakdowns in endpoint | **NO** | Only available internally |

---

## Critical Gaps

1. **Extended token usage not extracted (Step 0)** -- Cache/reasoning tokens ignored. Cost estimates inaccurate for cached workloads.

2. **Quota warning events not propagated (Step 4)** -- `onWarning` listener exists but never wired. No advance warning before hard refusal.

3. **No persistence for usage data (Step 3)** -- Resets on restart. Daily/monthly quotas unreliable.

4. **Compaction signal ignored (Step 5)** -- `increaseCompaction` flag computed but never acted upon.

5. **Pricing hardcoded (Cross-cutting)** -- Design specified externalized pricing. Currently in source code.

6. **`creatorId` in runtime types** -- Design said to omit from runtime types, attach at export time only.
