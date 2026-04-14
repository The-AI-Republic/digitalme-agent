# Track 10: Creator Guardrails and Safety -- Gap Analysis

## Summary

Layer 1 (Rule-Based, No LLM) is largely implemented with good test coverage. Core infrastructure (config schema, pattern library, input screener, output validator, TurnExecutor integration) works. Several gaps remain around guardrailScope enforcement, refusal message persistence, and truncation recovery validation.

---

## Step 1: Config Schema

**Status: COMPLETE**

Full Zod schema with all fields, sensible defaults, backward compatibility preserved.

---

## Step 2: Pattern Library

**Status: COMPLETE**

`JAILBREAK_PATTERNS` (7), `PII_PATTERNS` (4: email, phone, SSN, credit card), `EXTERNAL_LINK_PATTERN`. All with name/regex/category. 17 tests.

---

## Step 3: InputScreener

**Status: COMPLETE**

Pure function with correct check order (jailbreak -> PII -> blocked keywords). Boundary-aware keyword matching via `keywordMatcher.ts`. 15 tests.

---

## Step 4: OutputValidator

**Status: COMPLETE**

Correct check order (keywords -> PII -> links -> length). Proper action escalation (block > modify > send). 14 tests.

---

## Step 5: TurnExecutor Integration

**Status: PARTIAL**

| Task | Status | Notes |
|------|--------|-------|
| Input hook: screen before model loop | YES | |
| Input block: yield events + canned message | YES | |
| Input block: persist refusal in context/newMessages | **NO** | No assistant message pushed to `context.messages` |
| Output hook: validate final text | YES | |
| Output block: substitute with canned message | YES | |
| Output modify: use modified text | YES | |
| Output hook on truncation recovery | **NO** | Partial chunks bypass guardrails |
| guardrailScope enforcement | **NO** | Type defined but never read in TurnExecutor |
| Console logging of decisions | **NO** | |
| Fail-closed on screener/validator errors | YES | |

### Bugs

1. **Refusal assistant message not persisted** -- When input is blocked, no assistant message with refusal text is pushed to `context.messages`. The `newMessages` return only includes the user message, losing the refusal.

2. **Truncation recovery partial chunks bypass guardrails** -- Partial text during max-output recovery is streamed as `text_delta` without validation. Blocked content (keywords, PII) could reach the client before final validation.

3. **guardrailScope defined but never enforced** -- `TurnExecutor.ts` runs guardrails unconditionally. Subagent/internal calls via `CreatorSkillTool` will hit fan-facing guardrails, potentially causing false positives.

---

## Step 6: Wiring

**Status: NO (alternative approach)**

Design specified DI through `TurnExecutorDeps` and wiring via `SessionManager`. Implementation uses direct function imports in TurnExecutor. Functionally equivalent but less testable/mockable.

---

## Step 7: Tests

| Test | Status |
|------|--------|
| Unit: InputScreener (15 tests) | YES |
| Unit: OutputValidator (14 tests) | YES |
| Unit: patterns (17 tests) | YES |
| Integration: input block | YES |
| Integration: output block/modify | YES |
| Integration: TurnExecutionResult shape | PARTIAL |
| Integration: truncation recovery | **NO** |
| Integration: guardrailScope bypass | **NO** |
| Integration: guardrailScope default | **NO** |

---

## Priority Remediation

1. **HIGH** -- Persist refusal assistant message in context when input is blocked
2. **HIGH** -- Validate partial chunks during truncation recovery
3. **MEDIUM** -- Enforce `guardrailScope` in TurnExecutor (skip guardrails for `'internal'` scope)
4. **LOW** -- Add console logging for guardrail decisions
5. **LOW** -- Add missing integration tests
