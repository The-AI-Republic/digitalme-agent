# 10 — Creator Guardrails and Safety

## What This Track Covers

Content safety classification, creator-defined behavioral boundaries, conversation guardrails for public-facing agent interactions, and a policy framework that protects both creators and fans.

## Why This Is Not Covered by Existing Tracks

Track 03 (Tool Runtime) introduces `ToolPolicy` for tool execution decisions. Track 07 mentions policy hooks. But neither designs a comprehensive guardrail system for _conversation content_ — what the agent says, how it handles sensitive topics, and how creator-defined boundaries are enforced across the full response lifecycle.

This is the most important safety gap for a public-facing agent. Claudy solves the tool-safety problem (should this bash command run?). DigitalMe needs to solve the conversation-safety problem (should this response be sent to a fan?).

## What Claudy Does

Claudy has a 3-layer permission and safety system:

### Layer 1: Rule Engine
- `permissionRuleParser.ts` — glob/regex pattern matching against tool calls
- Rule types: `alwaysAllow`, `alwaysDeny`, `alwaysAsk`
- Rules can target tool names, arguments, and content patterns

### Layer 2: Classifier Auto-Approval
- `yoloClassifier.ts` — ML-based safety classification for bash commands
- Confidence-scored auto-approve/deny with fallback to manual prompt
- Denial tracking to prevent infinite loops

### Layer 3: Policy Modes
- `default` | `bypass` | `auto-mode` | `headless`
- Coordinator delegation for multi-agent permission sharing
- Interactive prompts with contextual suggestions

Key insight: Claudy treats every potentially dangerous operation as a _policy decision point_ with a shared decision framework, not ad-hoc conditionals scattered across the codebase.

## Current DigitalMe Agent Situation

The agent has:
- Creator personality configuration (name, tone, boundaries, knowledge) in YAML
- These boundaries are injected into the system prompt as instructions
- No runtime enforcement — the model may ignore prompt-level boundaries
- No content classification of responses before delivery
- No fan input screening beyond what the model itself does
- No structured policy framework for guardrail decisions
- HMAC auth for request verification but no content-level safety

## What To Borrow

The architectural pattern, not the specific implementation. Claudy's rule engine and classifier are designed for tool safety. DigitalMe needs the same _architecture_ applied to conversation safety.

### 1. Guardrail Policy Framework

A shared decision framework for all safety-relevant decisions:

```typescript
interface GuardrailDecision {
  action: 'allow' | 'block' | 'modify' | 'warn';
  reason: string;
  rule: string;
  confidence: number;
}

interface GuardrailContext {
  creatorId: string;
  conversationId: string;
  fanMessage: string;
  agentResponse: string;
  creatorBoundaries: CreatorBoundaries;
  conversationHistory: Message[];
}
```

### 2. Creator-Defined Boundaries (Structured)

Move from free-text prompt boundaries to structured, enforceable rules:

```yaml
guardrails:
  # Topics the agent should never discuss
  blocked_topics:
    - medical_advice
    - financial_advice
    - legal_advice
    - explicit_content

  # Response constraints
  response_rules:
    max_response_length: 2000  # characters
    language: auto  # or specific language code
    tone_enforcement: strict  # strict | relaxed

  # Fan interaction rules
  interaction_rules:
    require_age_gate: false
    block_personal_info_collection: true
    block_external_links: true
    max_conversation_turns: 100

  # Escalation
  escalation:
    on_blocked_topic: redirect  # redirect | refuse | silent
    redirect_message: "I can't help with that topic. Let me know if there's something else I can help with!"
```

### 3. Input Screening (Pre-Model)

Screen fan messages before they reach the model:

```typescript
interface InputScreenResult {
  safe: boolean;
  category?: 'spam' | 'abuse' | 'jailbreak' | 'pii_exposure' | 'off_topic';
  action: 'proceed' | 'refuse' | 'sanitize';
  sanitizedInput?: string;
}

async function screenFanInput(
  input: string,
  context: GuardrailContext,
): Promise<InputScreenResult> {
  // Phase 1: Pattern-based checks (fast, no LLM)
  //   - Known jailbreak patterns
  //   - PII detection (email, phone, SSN patterns)
  //   - Spam/gibberish detection
  //   - Blocked keyword matching

  // Phase 2: Creator boundary matching
  //   - Check against blocked_topics
  //   - Check against interaction_rules

  // Phase 3 (optional future): Classifier-based screening
  //   - Use background model for ambiguous cases
}
```

### 4. Output Guardrails (Post-Model)

Validate agent responses before streaming to the fan:

```typescript
interface OutputGuardrailResult {
  safe: boolean;
  violations: Violation[];
  action: 'send' | 'block' | 'modify';
  modifiedResponse?: string;
}

interface Violation {
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  snippet: string;
  suggestion?: string;
}

async function validateAgentOutput(
  response: string,
  context: GuardrailContext,
): Promise<OutputGuardrailResult> {
  // Check against creator boundaries
  // Check for PII leakage
  // Check for external link policy
  // Check response length
  // Check tone consistency
}
```

### 5. Guardrail Decision Logging

Every guardrail decision should be recorded for:
- Creator transparency (what was blocked and why)
- Debugging false positives
- Improving guardrail accuracy over time
- Compliance and audit trails

```typescript
interface GuardrailLog {
  timestamp: number;
  conversationId: string;
  phase: 'input_screen' | 'output_validate' | 'tool_policy';
  decision: GuardrailDecision;
  context: {
    fanMessagePreview: string;  // truncated
    responsePreview?: string;   // truncated
  };
}
```

This integrates with track 05 (Transcript Storage) and track 07 (Internal Events).

### 6. Jailbreak Resistance

Claudy's classifier approach adapted for conversation safety:

- Maintain a pattern library of known jailbreak techniques
- Check for instruction override attempts ("ignore your instructions", "pretend you are")
- Check for role-play attacks that bypass creator boundaries
- Check for indirect prompt injection in fan messages
- Log detected attempts without revealing detection to the fan

```typescript
const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i,
  /pretend\s+(you\s+are|to\s+be|you're)\s+/i,
  /you\s+are\s+now\s+/i,
  /\bDAN\b/,
  /developer\s+mode/i,
  /bypass\s+(safety|content|filter)/i,
  // ... extensible
];
```

## What NOT To Borrow

- **Interactive permission prompts** — no human-in-the-loop for a public agent
- **Classifier model for tool safety** — different problem domain
- **Permission modes** — creator sets policy once, no per-request mode switching
- **Coordinator delegation** — no multi-user permission sharing needed

## Implementation

### Step 1: Structured Boundaries Schema

- Extend creator config schema with `guardrails` section
- Parse boundaries into structured rules at config load time
- Keep backward compatibility with free-text `boundaries` field

Files:
- `src/config/schema.ts` — extend with guardrails schema
- `src/guardrails/types.ts` — guardrail types

### Step 2: Input Screening

- Add `src/guardrails/InputScreener.ts`
- Pattern-based checks (regex, keyword matching) — no LLM cost
- Integrate into `TurnExecutor.ts` before model call
- Return early with canned response on blocked input
- Log decisions

### Step 3: Output Validation

- Add `src/guardrails/OutputValidator.ts`
- Post-model response checking against creator rules
- Initially pattern-based (fast, cheap)
- Integrate into response streaming path
- On violation: either block and substitute, or log warning

### Step 4: Jailbreak Detection

- Add `src/guardrails/JailbreakDetector.ts`
- Extensible pattern library
- Integrate into input screening pipeline
- Log attempts without revealing detection

### Step 5: Guardrail Logging & Analytics

- Add `src/guardrails/GuardrailLogger.ts`
- Integrate with track 05 transcript storage
- Emit events to track 07 internal event bus
- Structured logs for creator dashboard (future)

### Step 6: Policy Decision Engine (optional, higher maturity)

- Add `src/guardrails/PolicyEngine.ts`
- Centralized decision point that combines:
  - Creator boundaries
  - Platform-level policies
  - Input screening results
  - Output validation results
  - Tool policy results (from track 03)
- Unified `GuardrailDecision` for all policy types

## Interaction with Existing Tracks

| Track | Interaction |
|-------|-------------|
| 03 (Tool Runtime) | Tool policy becomes one input to the unified policy engine |
| 05 (Transcripts) | Guardrail decisions recorded in turn transcript |
| 07 (Events) | Guardrail events emitted as internal events |
| 08 (Forked Agents) | Forked agents inherit creator guardrails |

## Success Criteria

- Creator-defined boundaries are enforced at runtime, not just suggested in prompt
- Known jailbreak patterns are detected and blocked before model call
- Agent responses violating creator rules are caught before delivery
- All guardrail decisions are logged for transparency and debugging
- False positive rate is low enough that normal conversation is unaffected
- Pattern-based checks add <10ms latency per message
- Creator can configure guardrails in YAML without writing code
