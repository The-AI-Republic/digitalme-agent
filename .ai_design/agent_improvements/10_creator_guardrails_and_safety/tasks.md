# 10 — Creator Guardrails and Safety Tasks

## Layer 1 — Rule-Based (No LLM, <10ms per message)

### Scope decisions required for this PR

- [ ] Apply Layer 1 guardrails only to top-level public/fan-facing turns
- [ ] Add `guardrailScope?: 'public' | 'internal'` to `ExecutionOptions`
- [ ] Default `guardrailScope` to `'public'`
- [ ] Update `SubagentTool` to pass `guardrailScope: 'internal'`
- [ ] Ensure internal/subagent turns bypass fan-facing input/output guardrails

### Step 1: Guardrails Config Schema

- [ ] Add `guardrails` Zod schema to `src/config/schema.ts` (optional, `enabled: false` by default)
  - `blocked_keywords: string[]`
  - `response_rules: { max_response_length, block_external_links }`
  - `pii_detection: { enabled, block_in_input, block_in_output }`
  - `jailbreak_detection: { enabled }`
  - `messages: { input_blocked, output_blocked }`
- [ ] Add `GuardrailConfig` type to `src/guardrails/types.ts` (inferred from Zod schema)
- [ ] Add `InputScreenResult` and `OutputValidationResult` types
- [ ] Update `config.example.yaml` with guardrails example (commented out)
- [ ] Verify backward compat — existing configs without `guardrails` section still load
- [ ] Normalize/ignore empty `blocked_keywords` entries so whitespace-only values have no effect

### Step 2: Pattern Library

- [ ] Add `src/guardrails/patterns.ts` with named pattern sets:
  - Jailbreak patterns (instruction override, role-play attacks, bypass attempts)
  - PII patterns (email, phone, SSN, credit card)
  - External link pattern (http/https URLs)
- [ ] Each pattern has: `name`, `regex`, `category` for logging

### Step 3: InputScreener

- [ ] Add `src/guardrails/InputScreener.ts` — stateless function
- [ ] Check order: jailbreak → PII → blocked keywords (fast to slow, exit on first block)
- [ ] Returns `InputScreenResult` with `safe`, `category`, `action`, `matchedRule`
- [ ] No LLM calls — regex/substring only
- [ ] Unit tests: jailbreak variants, PII formats, blocked keywords, clean messages pass through

### Step 4: OutputValidator

- [ ] Add `src/guardrails/OutputValidator.ts` — stateless function
- [ ] Check order: blocked keywords → PII → external links → length
- [ ] Returns `OutputValidationResult` with violations and action (`send`/`block`/`modify`)
- [ ] On critical violation (keyword, PII): action=`block`, provide `replacementResponse`
- [ ] On medium violation (links): action=`modify`, strip URLs
- [ ] On low violation (length): action=`modify`, truncate
- [ ] Unit tests: keyword violations, PII leakage, link stripping, length truncation

### Step 5: TurnExecutor Integration

- [ ] Add `InputScreener` and `OutputValidator` to `TurnExecutorDeps` interface
- [ ] Default to no-op when `guardrails.enabled` is false
- [ ] Add `guardrailScope` to `ExecutionOptions`
- [ ] **Input hook** (after line 167 in `TurnExecutor.ts`): screen user message before model loop
  - On block: create refusal assistant message, append it to context, record it if transcript recorder exists
  - On block: yield `guardrail_block` event, yield `text_delta` with canned message, yield `done`, return a valid `TurnExecutionResult`
  - On proceed: continue normally
- [ ] **Output hook on truncation recovery path**: validate each partial recovery chunk before `text_delta`
  - On block: yield `guardrail_block`, emit canned blocked response, yield `done`, return a valid `TurnExecutionResult`
  - On modify: emit/store the modified chunk
  - Document that prior emitted chunks cannot be recalled in Layer 1
- [ ] **Output hook** (at line 291 in `TurnExecutor.ts`): validate response before delivery
  - On block: substitute `fullText` with canned `output_blocked` message
  - On modify: use modified text (URLs stripped or truncated)
  - On send: pass through
- [ ] Add `guardrail_block` variant to `AgentEvent` type in `src/agent/types.ts`
- [ ] Fail-closed: if screener/validator throws, block the message
- [ ] Console log guardrail decisions (matches existing `[task]` pattern)
- [ ] Ensure blocked turns return:
  - `finalText` = refusal text
  - `completedTurns` = `0` when input was blocked pre-model
  - `toolCallCount` = `0`
  - `newMessages` includes both the user message and the refusal assistant message

### Step 6: Wiring

- [ ] Wire guardrail deps through `SessionManager`, which currently constructs `TurnExecutor`
- [ ] When `guardrails.enabled` is true, instantiate `InputScreener` and `OutputValidator` in `SessionManager`
- [ ] When `guardrails.enabled` is false, omit those deps entirely
- [ ] Do not wire this through `Agent.ts` unless the construction path changes

### Step 7: Tests

- [ ] `src/guardrails/InputScreener.test.ts`
- [ ] `src/guardrails/OutputValidator.test.ts`
- [ ] `src/guardrails/patterns.test.ts`
- [ ] Integration test: TurnExecutor with guardrails enabled blocks jailbreak input
- [ ] Integration test: TurnExecutor with guardrails enabled blocks PII in output
- [ ] Integration test: blocked input returns a valid `TurnExecutionResult` and persists refusal text
- [ ] Integration test: truncation recovery validates partial chunks
- [ ] Integration test: `guardrailScope: 'internal'` bypasses fan-facing guardrails
- [ ] Integration test: `guardrailScope` defaults to `'public'`

---

## Future — Layer 2: LLM-Based Classification (separate PR)

- [ ] Design classifier for ambiguous content (subtle topic violations, sophisticated jailbreaks, tone drift)
- [ ] Follow Claudy's two-stage pattern: fast block/allow → reasoning if blocked
- [ ] Fail-closed on LLM errors
- [ ] Denial tracking to prevent infinite loops

## Future — Layer 3: Unified Policy Engine (separate PR)

- [ ] Centralized decision point combining creator guardrails + platform policies + tool policy (track 03)
- [ ] Unified `GuardrailDecision` for all policy types
