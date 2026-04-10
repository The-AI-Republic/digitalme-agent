# 10 — Creator Guardrails and Safety Tasks

## Step 1: Structured Boundaries Schema

- [ ] Define `GuardrailConfig` type with `blocked_topics`, `response_rules`, `interaction_rules`, `escalation`
- [ ] Extend creator config schema with `guardrails` section
- [ ] Parse structured boundaries at config load time
- [ ] Maintain backward compat with free-text `boundaries` field
- [ ] Define `GuardrailDecision` type (`allow`, `block`, `modify`, `warn`)

## Step 2: Input Screening

- [ ] Add `src/guardrails/InputScreener.ts`
- [ ] Implement pattern-based PII detection (email, phone, SSN patterns)
- [ ] Implement blocked keyword/topic matching against creator config
- [ ] Implement basic spam/gibberish detection
- [ ] Integrate into `TurnExecutor.ts` before model call
- [ ] Return canned response on blocked input
- [ ] Log screening decisions

## Step 3: Output Validation

- [ ] Add `src/guardrails/OutputValidator.ts`
- [ ] Check responses against creator boundary rules
- [ ] Check for PII leakage in responses
- [ ] Check external link policy
- [ ] Check response length limits
- [ ] Integrate into response streaming path
- [ ] Define action on violation: block+substitute vs log warning

## Step 4: Jailbreak Detection

- [ ] Add `src/guardrails/JailbreakDetector.ts`
- [ ] Build extensible pattern library for known jailbreak techniques
- [ ] Detect instruction override attempts
- [ ] Detect role-play attacks
- [ ] Integrate into input screening pipeline
- [ ] Log attempts without revealing detection to fan

## Step 5: Guardrail Logging & Analytics

- [ ] Add `src/guardrails/GuardrailLogger.ts`
- [ ] Integrate with track 05 transcript storage
- [ ] Emit guardrail events to track 07 internal event bus
- [ ] Record decision context (truncated previews, not full content)

## Step 6: Unified Policy Engine (higher maturity)

- [ ] Add `src/guardrails/PolicyEngine.ts`
- [ ] Combine input screening + output validation + tool policy (track 03)
- [ ] Add platform-level policy overrides
- [ ] Unified `GuardrailDecision` for all policy types
- [ ] Central decision logging
