# 10 — Creator Guardrails and Safety

## What This Track Covers

Content safety classification, creator-defined behavioral boundaries, conversation guardrails for public-facing agent interactions, and a policy framework that protects both creators and fans.

## Why This Is Not Covered by Existing Tracks

Track 03 (Tool Runtime) introduces `ToolPolicy` for tool execution decisions. Track 07 mentions policy hooks. But neither designs a comprehensive guardrail system for _conversation content_ — what the agent says, how it handles sensitive topics, and how creator-defined boundaries are enforced across the full response lifecycle.

This is the most important safety gap for a public-facing agent. Claudy solves the tool-safety problem (should this bash command run?). DigitalMe needs to solve the conversation-safety problem (should this response be sent to a fan?).

## What Claudy Does (and Doesn't Do)

Claudy has a 3-layer permission and safety system, but it is **entirely focused on tool execution safety** — it does NOT screen conversation content at all.

### Layer 1: Rule Engine — purely rule-based, no LLM

`permissionRuleParser.ts` + `permissions.ts` — pattern matching on tool names and content:

- Rule types: `alwaysAllow`, `alwaysDeny`, `alwaysAsk`
- Matches exact tool names (`Bash`) or content patterns (`Bash(npm publish:*)`)
- **Deny rules always win** — checked first, highest priority
- Path validation: blocks traversal, UNC paths, shell expansion syntax, dangerous removals (`/*`, `/root`)
- Decision flow: deny rules → ask rules → tool.checkPermissions() → safety checks → allow rules
- Zero LLM cost, instant

### Layer 2: Classifier (yoloClassifier) — hybrid: rules first, LLM fallback

Only activates when Layer 1 returns `'ask'` AND mode is `'auto'`. Has multiple fast-paths to avoid LLM calls:

1. **Safe-tool allowlist** (rule-based) — 30+ tools hardcoded as safe (Read, Grep, Glob, etc.) → auto-allow, no LLM
2. **AcceptEdits fast-path** (rule-based) — file writes within working dir → auto-allow
3. **If fast-paths fail → actual LLM API call** to classify the action:
   - Sends full conversation transcript + tool action to Claude
   - Two-stage approach: Stage 1 (fast, 64 tokens) → "block yes/no". If blocked, Stage 2 (4096 tokens) with chain-of-thought
   - Temperature=0 for deterministic results
   - **Fail-closed**: parse failure or API error → block for safety
   - Denial tracking: max 3 consecutive, max 20 total per session → falls back to interactive prompt

### Layer 3: Permission Modes — purely rule-based

Six modes gate when Layers 1 & 2 apply: `default`, `plan`, `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`.

### What Claudy does NOT do

- **No input screening** — user messages go directly to model without content filtering
- **No output screening** — model responses are not filtered against any rules before display
- **No conversation content safety** — Claudy only decides "should this bash command run?", never "should this response be sent?"

Key insight: Claudy treats every potentially dangerous _tool operation_ as a policy decision point with a shared framework. DigitalMe needs the same architecture applied to _conversation content_ — that's the gap this track fills.

## Current DigitalMe Agent Situation

The agent has:
- Creator personality configuration (name, tone, boundaries, knowledge) in YAML (`src/config/schema.ts:26-44`)
- These boundaries are injected into the system prompt as free text (`src/prompts/PromptSections.ts:32-42` → `soul.md` template)
- A `security.md` template with LLM-level instructions (anti-jailbreak, PII, no impersonation) — but these are prompt-level only
- Input size validation (`src/middleware/request-limits.ts`) — message length and history count, but no content screening
- HMAC auth for request verification (`src/middleware/hmac.ts`) — but no content-level safety
- A pass-through tool policy checker (`src/tools/execution/ToolPolicyChecker.ts:23-26`) — interface exists but always returns `{ allowed: true }`

What's missing:
- **No runtime enforcement** — the model may ignore prompt-level boundaries
- **No content screening of fan input** before model call
- **No content validation of agent response** before delivery to fan
- **No structured policy framework** for guardrail decisions
- **No jailbreak pattern detection** before input reaches the model

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

- **Interactive permission prompts** — no human-in-the-loop for a public-facing agent; decisions must be automatic
- **yoloClassifier LLM calls (Layer 1)** — Layer 1 is rule-based only; LLM classification is a future Layer 2 concern
- **Permission modes** — creator sets guardrail policy once in YAML; no per-request mode switching
- **Coordinator delegation** — no multi-user permission sharing needed
- **Safe-tool allowlist** — Claudy's tool allowlist is irrelevant; our screener operates on message content, not tool names
- **Denial tracking / loop prevention** — only needed when an LLM classifier is in the loop (future Layer 2)

## Implementation — Layer 1 (Rule-Based, No LLM)

Following Claudy's pattern: start with fast, cheap, deterministic pattern matching. No LLM calls. Fail-closed on errors.

### Step 1: Guardrails Config Schema

Extend `src/config/schema.ts` with an optional `guardrails` section:

```yaml
guardrails:
  enabled: true

  # Keywords/phrases the agent should never engage with.
  # Matched case-insensitively against fan input AND agent output.
  blocked_keywords:
    - "buy crypto"
    - "send money"
    - "wire transfer"

  response_rules:
    max_response_length: 2000     # characters — truncate or block if exceeded
    block_external_links: true    # strip or block responses containing URLs

  pii_detection:
    enabled: true
    block_in_input: true          # block fan messages containing PII
    block_in_output: true         # block agent responses leaking PII

  jailbreak_detection:
    enabled: true

  messages:
    input_blocked: "I can't respond to that. Let me know if there's something else I can help with!"
    output_blocked: "Sorry, I wasn't able to generate a suitable response. Please try again."
```

- All fields optional with sensible defaults (enabled=false until creator opts in)
- Backward compatible — existing `soul.boundaries` still works as prompt-level instruction
- `guardrails` adds runtime enforcement on top of prompt-level boundaries

Files:
- `src/config/schema.ts` — extend `agentConfigSchema` with `guardrails` Zod schema
- `src/guardrails/types.ts` — TypeScript types inferred from schema

### Step 2: Pattern Library

A shared, extensible set of regex patterns:

```typescript
// Jailbreak detection
/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|guidelines)/i
/pretend\s+(you\s+are|to\s+be|you're)\s+/i
/you\s+are\s+now\s+/i
/\bDAN\b/
/developer\s+mode/i
/bypass\s+(safety|content|filter)/i
/act\s+as\s+(if|though)\s+you\s+(have\s+)?no\s+(restrictions|limits|rules)/i

// PII detection (fan input and agent output)
/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i           // email
/\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ // US phone
/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/                      // SSN
/\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/          // credit card

// External links
/https?:\/\/[^\s]+/i
```

Files:
- `src/guardrails/patterns.ts` — named pattern sets, each with category and description

### Step 3: InputScreener

Screens fan messages **before** the model call. Integration point: `TurnExecutor.ts` between user message creation (line 161) and the model call loop (line 177).

Check order (fast to slow, exit on first block):
1. Jailbreak pattern matching — if `jailbreak_detection.enabled`
2. PII detection — if `pii_detection.block_in_input`
3. Blocked keyword matching — case-insensitive substring match against `blocked_keywords`

On block:
- Do NOT call the model — skip entirely
- Yield canned `input_blocked` message as `text_delta`
- Yield `done` event
- Return early from `TurnExecutor.run()`
- Log the decision (category, matched rule, truncated input preview)

Files:
- `src/guardrails/InputScreener.ts` — stateless, takes `GuardrailConfig` + message string → `InputScreenResult`

### Step 4: OutputValidator

Validates agent response **after** model call, **before** yielding `text_delta` to the fan. Integration point: `TurnExecutor.ts` at the final_text handling block (line 291).

Check order:
1. Blocked keyword matching — agent response must not contain blocked keywords
2. PII detection — if `pii_detection.block_in_output`
3. External link detection — if `response_rules.block_external_links`
4. Response length — if exceeds `response_rules.max_response_length`

On violation:
- **Critical** (blocked keyword, PII leakage): replace entire response with `output_blocked` message
- **Medium** (external link): strip the URLs and send modified response
- **Low** (length exceeded): truncate at limit with "..." suffix
- Log all violations

Files:
- `src/guardrails/OutputValidator.ts` — stateless, takes `GuardrailConfig` + response string → `OutputValidationResult`

### Step 5: TurnExecutor Integration

Two hook points in `src/agent/TurnExecutor.ts`:

**Hook 1 — Input screening** (before model call):
```
line 167: context.messages.push(userMsg);
// ← INSERT: InputScreener.screen(userMessage, guardrailConfig)
//    If blocked: yield text_delta with canned message, yield done, return early
line 177: while (executionState.getIterationIndex() < maxTurns) {
```

**Hook 2 — Output validation** (before response delivery):
```
line 291: if (result.type === 'final_text') {
line 292:   const fullText = recovery.accumulatedText + result.text;
// ← INSERT: OutputValidator.validate(fullText, guardrailConfig)
//    If blocked: substitute fullText with canned message
//    If modified: use modified text
line 311:   if (result.text) {
line 312:     yield { type: 'text_delta', content: result.text };
```

New `AgentEvent` variant for observability:
```typescript
| { type: 'guardrail_block'; phase: 'input' | 'output'; category: string; rule: string }
```

**Dependency injection**: Add `InputScreener` and `OutputValidator` to `TurnExecutorDeps` interface, defaulting to no-op implementations when `guardrails.enabled` is false.

### Step 6: Guardrail Logging

Guardrail decisions logged via existing patterns:
- Console log at decision time (matches existing `[task]` log pattern in `turns.ts`)
- Transcript recorder dual-write if available (integrates with track 05)
- `guardrail_block` event emitted via SSE so the platform can record it

No separate logger class — use existing infrastructure.

## Future Layers (Not in This PR)

### Layer 2: LLM-Based Classification (future)

For ambiguous cases that regex can't catch:
- Subtle topic boundary violations ("I'm not a doctor, but..." followed by medical advice)
- Sophisticated jailbreak attempts that avoid pattern matching
- Tone drift detection

Would follow Claudy's yoloClassifier pattern:
- Fast-path rule checks first (Layer 1)
- LLM call only when Layer 1 is uncertain
- Two-stage classifier (fast block/allow, then reasoning if blocked)
- Fail-closed on errors
- Denial tracking to prevent infinite loops

### Layer 3: Policy Decision Engine (future)

Centralized decision point combining:
- Creator boundaries (this track)
- Platform-level policies (e.g., global content rules)
- Tool policy results (from track 03)
- Unified `GuardrailDecision` for all policy types

## Interaction with Existing Tracks

| Track | Interaction |
|-------|-------------|
| 03 (Tool Runtime) | Tool policy becomes one input to the unified policy engine |
| 05 (Transcripts) | Guardrail decisions recorded in turn transcript |
| 07 (Events) | Guardrail events emitted as internal events |
| 08 (Forked Agents) | Forked agents inherit creator guardrails |

## Success Criteria (Layer 1)

- Creator-defined boundaries are enforced at runtime, not just suggested in prompt
- Known jailbreak patterns are detected and blocked **before** model call (saves LLM cost)
- Agent responses violating creator rules are caught **before** delivery to fan
- All guardrail decisions are logged and emitted as `guardrail_block` events
- False positive rate is low enough that normal conversation is unaffected
- Pattern-based checks add **<10ms latency** per message (no LLM calls)
- Creator can configure guardrails in YAML without writing code
- Guardrails are **off by default** — zero impact on existing deployments
- **Fail-closed**: if the screener/validator throws, block the message (don't let it through)
- Existing `soul.boundaries` free-text field continues to work unchanged (backward compatible)
