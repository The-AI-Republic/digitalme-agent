# 14 — Creator Skills

## What This Track Covers

A skill system where **creators define capabilities** that the agent can invoke automatically during fan conversations. Skills are creator-configured, model-invoked, and invisible to fans — fans experience a more capable agent without knowing skills exist.

## The Key Reframing

Claudy's skill architecture was previously dismissed because it was viewed as "user installs and types `/skill-name`." That framing is wrong for DigitalMe. The correct framing:

| Claudy | DigitalMe |
|--------|-----------|
| User installs skills | **Creator** bakes skills into agent config |
| User types `/skill-name` | **Model** invokes skills automatically |
| User sees skill listing | **Fan never knows** skills exist |
| Skills extend the coding environment | Skills extend the **creator's agent capabilities** |

This is the single most impactful capability extension for the agent platform. It turns every creator agent from a personality chatbot into a **capable agent with real actions**.

## What Claudy Does (Model-Invoked Skills)

### Skill Definition

YAML frontmatter + Markdown prompt:

```yaml
---
name: skill-name
description: "One-line description"
when_to_use: "When the user asks about X, Y, Z"
allowed-tools: [Bash, Read, Write]
context: inline | fork
model: claude-sonnet
disable-model-invocation: false  # model CAN invoke
user-invocable: true             # independent flag
---

Detailed prompt instructions for the skill...
```

### Model Discovery

Skills are listed in `<system-reminder>` blocks injected into each turn. The model sees:

```
Available skills:
- product_search: Search product catalog - When fan asks about products, pricing, stock
- schedule_meeting: Book a call - When fan wants to schedule or meet
```

The model calls `SkillTool({ skill: "product_search", args: "blue widget" })` when it decides to.

### Two Execution Modes

1. **Inline** — skill prompt expands into the current conversation. Model uses the same context and tools. Good for quick lookups.
2. **Forked** — skill runs in an isolated sub-agent with separate token budget and restricted tool set. Results flow back as text. Good for complex workflows.

### Key Design Decisions

- `when_to_use` guides model on **when** to auto-invoke (truncated to 250 chars in listing)
- `allowed-tools` restricts which tools the skill can use (whitelist)
- `disable-model-invocation` / `user-invocable` are independent flags
- Forked skills get isolated context so they can't corrupt the main conversation
- Skill listing budget is ~1% of context window to avoid prompt bloat

## Current DigitalMe Agent Infrastructure

### Already Built (85% of execution layer)

| Component | Status | Location |
|-----------|--------|----------|
| SubagentTool | Working | `src/agent/subagent/SubagentTool.ts` |
| ForkedAgent | Working | `src/agent/fork/ForkedAgent.ts` |
| ForkSemaphore | Working | `src/agent/fork/ForkSemaphore.ts` |
| resolveSubagentTools() | Working | `src/agent/subagent/SubagentTool.ts` |
| ExecutionOptions | Working | `src/agent/types.ts` |
| AgentDefinition | Working | `src/agent/subagent/AgentDefinition.ts` |
| TurnExecutor with custom registries | Working | `src/agent/TurnExecutor.ts` |
| PostTurnHooks | Working | `src/agent/hooks/PostTurnHooks.ts` |

### Missing (the skill layer)

| Component | Status | What's Needed |
|-----------|--------|---------------|
| Skill definition schema | Missing | YAML schema in creator config |
| Skill registry | Missing | Load, validate, and register creator skills |
| Model-facing skill listing | Missing | Inject available skills into system prompt |
| CreatorSkillTool | Missing | Tool the model calls to invoke skills |
| Skill prompt templates | Missing | Template expansion with arguments |
| Skill lifecycle hooks | Missing | Pre/post skill execution callbacks |
| Skill execution tracking | Missing | Usage, cost, success rate per skill |

## Design

### 1. Skill Definition Schema

Creator defines skills in their agent config YAML:

```yaml
skills:
  - name: product_search
    description: "Search the creator's product catalog"
    when_to_use: "When fan asks about products, pricing, availability, or stock"
    context: inline
    prompt: |
      Search the product catalog for: $QUERY

      Return results in this format:
      - Product name
      - Price
      - Availability (in stock / out of stock)
      - Link to product page

      If no products match, say so clearly.
    allowed_tools: [web_search]
    model: inherit
    max_turns: 3
    timeout_seconds: 30

  - name: schedule_meeting
    description: "Help fan schedule a meeting with the creator"
    when_to_use: "When fan wants to schedule, book, or arrange a meeting or call"
    context: fork
    prompt: |
      Help the fan schedule a meeting with $CREATOR_NAME.

      Available time slots:
      $CREATOR_SCHEDULE

      Confirm the selected time and provide a calendar link.
    allowed_tools: [web_search]
    model: inherit
    max_turns: 5
    timeout_seconds: 60

  - name: faq_lookup
    description: "Answer common questions from the creator's FAQ"
    when_to_use: "When fan asks a question that likely has a standard answer"
    context: inline
    prompt: |
      Answer the fan's question using this FAQ:

      $CREATOR_FAQ

      If the question isn't covered, say you don't have that information
      and offer to help with something else.
    allowed_tools: []
    model: inherit
    max_turns: 1
```

### 2. Skill Config Types

```typescript
interface CreatorSkillConfig {
  name: string;
  description: string;
  when_to_use: string;

  /** Skill execution context */
  context: 'inline' | 'fork';

  /** Prompt template with $VARIABLE placeholders */
  prompt: string;

  /** Tools the skill is allowed to use (whitelist) */
  allowed_tools: string[];

  /** Model to use: 'inherit' uses the conversation model */
  model: 'inherit' | string;

  /** Max turns the skill can take */
  max_turns: number;

  /** Timeout in seconds */
  timeout_seconds: number;

  /** Whether the model can invoke this skill (default: true) */
  enabled: boolean;
}

interface ResolvedSkill {
  config: CreatorSkillConfig;
  /** Resolved model spec (after 'inherit' resolution) */
  resolvedModel: string;
  /** Resolved tool registry (after whitelist filtering) */
  toolRegistry: IToolRegistry;
  /** Compiled prompt template */
  compiledPrompt: CompiledPromptTemplate;
}
```

### 3. Skill Registry

```typescript
class SkillRegistry {
  private skills: Map<string, ResolvedSkill> = new Map();

  /**
   * Load skills from creator config.
   * Validates schemas, resolves models, builds tool registries.
   */
  loadFromConfig(
    skillConfigs: CreatorSkillConfig[],
    parentToolRegistry: IToolRegistry,
    modelRoles: ModelRoles,
  ): void {
    for (const config of skillConfigs) {
      const resolved = this.resolveSkill(config, parentToolRegistry, modelRoles);
      this.skills.set(config.name, resolved);
    }
  }

  /** Get all skills the model should know about */
  listForModel(): SkillListing[] {
    return [...this.skills.values()]
      .filter(s => s.config.enabled)
      .map(s => ({
        name: s.config.name,
        description: s.config.description,
        when_to_use: s.config.when_to_use,
      }));
  }

  /** Get a skill by name for execution */
  get(name: string): ResolvedSkill | undefined {
    return this.skills.get(name);
  }

  /** Reload skills on config change (track 12) */
  reload(
    skillConfigs: CreatorSkillConfig[],
    parentToolRegistry: IToolRegistry,
    modelRoles: ModelRoles,
  ): void {
    this.skills.clear();
    this.loadFromConfig(skillConfigs, parentToolRegistry, modelRoles);
  }
}
```

### 4. Model-Facing Skill Listing

Skills are injected into the system prompt so the model knows they exist:

```typescript
function buildSkillListingSection(skills: SkillListing[]): string {
  if (skills.length === 0) return '';

  const MAX_DESC_LENGTH = 200;

  const lines = skills.map(s => {
    const desc = s.when_to_use
      ? `${s.description} - ${s.when_to_use}`
      : s.description;
    const truncated = desc.length > MAX_DESC_LENGTH
      ? desc.slice(0, MAX_DESC_LENGTH - 1) + '...'
      : desc;
    return `- ${s.name}: ${truncated}`;
  });

  return [
    'Available skills:',
    ...lines,
    '',
    'Use the CreatorSkill tool to invoke a skill when appropriate.',
    'Pass the skill name and any relevant arguments from the fan\'s message.',
  ].join('\n');
}
```

This section is added to the system prompt via `SystemPromptBuilder` (track 01, already done).

### 5. CreatorSkillTool

A new tool that the model calls to invoke creator-defined skills:

```typescript
const CreatorSkillTool: ToolDefinition = {
  name: 'CreatorSkill',
  description: 'Invoke a creator-defined skill to handle a specific task',
  inputSchema: z.object({
    skill: z.string().describe('Name of the skill to invoke'),
    args: z.string().optional().describe('Arguments from the fan message relevant to this skill'),
  }),
  metadata: {
    category: 'action',
    timeoutMs: 60_000,
    maxResultChars: 20_000,
    isConcurrencySafe: false,
  },
};
```

**Execution flow:**

```typescript
async execute(
  input: { skill: string; args?: string },
  context: ToolContext,
): Promise<ToolResult> {
  // 1. Look up skill in registry
  const skill = this.skillRegistry.get(input.skill);
  if (!skill) {
    return { success: false, data: `Unknown skill: ${input.skill}` };
  }

  // 2. Expand prompt template
  const expandedPrompt = this.expandTemplate(skill.compiledPrompt, {
    QUERY: input.args ?? '',
    CREATOR_NAME: context.creatorConfig.name,
    CREATOR_FAQ: context.creatorConfig.faq ?? '',
    CREATOR_SCHEDULE: context.creatorConfig.schedule ?? '',
    // ... other creator variables
  });

  // 3. Route to inline or forked execution
  if (skill.config.context === 'fork') {
    return this.executeForked(skill, expandedPrompt, context);
  } else {
    return this.executeInline(skill, expandedPrompt, context);
  }
}
```

**Inline execution** — builds a submission and runs through TurnExecutor with the skill's restricted tool registry:

```typescript
private async executeInline(
  skill: ResolvedSkill,
  prompt: string,
  context: ToolContext,
): Promise<ToolResult> {
  const options: ExecutionOptions = {
    maxTurns: skill.config.max_turns,
    model: skill.resolvedModel,
    toolRegistry: skill.toolRegistry,
  };

  const submission = buildSkillSubmission(prompt, skill);
  const result = await consumeGenerator(
    this.turnExecutor.run(submission, options),
    (_event) => { /* discard intermediate events */ },
  );

  return {
    success: true,
    data: result.finalText,
    renderForModel: () => result.finalText,
  };
}
```

**Forked execution** — uses the existing ForkedAgent infrastructure:

```typescript
private async executeForked(
  skill: ResolvedSkill,
  prompt: string,
  context: ToolContext,
): Promise<ToolResult> {
  const handle = await launchForkedAgent({
    sessionRuntime: context.sessionRuntime,
    turnExecutor: this.turnExecutor,
    submission: buildSkillSubmission(prompt, skill),
    options: {
      maxTurns: skill.config.max_turns,
      model: skill.resolvedModel,
      toolRegistry: skill.toolRegistry,
    },
    forkLabel: `skill:${skill.config.name}`,
    abortSignal: context.abortSignal,
  });

  if (!handle) {
    return {
      success: false,
      data: 'Skill execution unavailable (concurrency limit reached)',
    };
  }

  // For forked skills invoked by model, we await the result
  // (unlike fire-and-forget background forks)
  const result = await withTimeout(
    handle.promise,
    skill.config.timeout_seconds * 1000,
  );

  return {
    success: true,
    data: result.finalText,
    renderForModel: () => result.finalText,
  };
}
```

### 6. Prompt Template Expansion

Support `$VARIABLE` and `${VARIABLE}` placeholders in skill prompts:

```typescript
interface CompiledPromptTemplate {
  /** Original template string */
  source: string;
  /** Variable names found in template */
  variables: string[];
}

function compileTemplate(source: string): CompiledPromptTemplate {
  const variablePattern = /\$\{?([A-Z_][A-Z0-9_]*)\}?/g;
  const variables: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = variablePattern.exec(source)) !== null) {
    variables.push(match[1]);
  }
  return { source, variables: [...new Set(variables)] };
}

function expandTemplate(
  template: CompiledPromptTemplate,
  values: Record<string, string>,
): string {
  let result = template.source;
  for (const varName of template.variables) {
    const value = values[varName] ?? '';
    result = result.replace(
      new RegExp(`\\$\\{?${varName}\\}?`, 'g'),
      value,
    );
  }
  return result;
}
```

Built-in variables available to all skill templates:

| Variable | Source |
|----------|--------|
| `$QUERY` | Fan's message or extracted argument |
| `$CREATOR_NAME` | Creator config name field |
| `$CREATOR_FAQ` | Creator FAQ content |
| `$CREATOR_SCHEDULE` | Creator schedule data |
| `$CONVERSATION_SUMMARY` | Current session memory summary |
| `$FAN_NAME` | Fan display name if available |

Creators can reference any field from their config. Unknown variables expand to empty string.

### 7. Skill Execution Tracking

Every skill invocation produces a tracking record:

```typescript
interface SkillExecutionRecord {
  skillName: string;
  conversationId: string;
  creatorId: string;
  timestamp: number;

  /** How the skill was triggered */
  trigger: 'model_invoked';

  /** Execution mode */
  context: 'inline' | 'fork';

  /** Outcome */
  success: boolean;
  errorReason?: string;

  /** Performance */
  latencyMs: number;
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;

  /** Tool usage within the skill */
  toolCallCount: number;
  toolsUsed: string[];
}
```

This integrates with:
- Track 05 (Transcripts) — recorded in turn transcript
- Track 07 (Events) — emitted as internal event
- Track 11 (Usage) — counted toward creator usage/quota
- Track 13 (Analytics) — aggregated for skill performance metrics

### 8. Guardrail Integration

Skills must pass through the guardrail system (track 10):

- **Skill prompt** passes input screening (no jailbreak injection via skill args)
- **Skill output** passes output validation (creator boundaries still enforced)
- **Tool policy** within skill execution still enforced by ToolExecutor (track 03)
- **Creator can't bypass platform guardrails** via skill definitions

```typescript
// In CreatorSkillTool.execute():
const inputScreen = await inputScreener.screen(expandedPrompt, context);
if (!inputScreen.safe) {
  return { success: false, data: 'Skill input blocked by safety policy' };
}

// After skill execution:
const outputCheck = await outputValidator.validate(result.finalText, context);
if (!outputCheck.safe) {
  return { success: false, data: outputCheck.fallbackResponse };
}
```

### 9. Skill Validation at Config Load

Validate skill definitions when creator config is loaded:

```typescript
function validateSkillConfig(skill: CreatorSkillConfig): ValidationResult {
  const errors: string[] = [];

  // Name validation
  if (!/^[a-z][a-z0-9_]*$/.test(skill.name)) {
    errors.push(`Invalid skill name: ${skill.name} (must be lowercase alphanumeric with underscores)`);
  }

  // Description length
  if (skill.description.length > 200) {
    errors.push(`Description too long: ${skill.description.length} chars (max 200)`);
  }

  // when_to_use required
  if (!skill.when_to_use || skill.when_to_use.length < 10) {
    errors.push('when_to_use is required and must be descriptive (min 10 chars)');
  }

  // Prompt required
  if (!skill.prompt || skill.prompt.length < 20) {
    errors.push('prompt is required (min 20 chars)');
  }

  // Tool whitelist validation
  if (skill.allowed_tools.length > 0) {
    const validTools = ['web_search'];  // extend as tools grow
    for (const tool of skill.allowed_tools) {
      if (!validTools.includes(tool)) {
        errors.push(`Unknown tool in allowed_tools: ${tool}`);
      }
    }
  }

  // Limits
  if (skill.max_turns > 10) {
    errors.push('max_turns cannot exceed 10');
  }
  if (skill.timeout_seconds > 120) {
    errors.push('timeout_seconds cannot exceed 120');
  }

  return { valid: errors.length === 0, errors };
}
```

### 10. Max Skills Per Creator

Enforce limits to prevent prompt bloat and cost runaway:

```typescript
const SKILL_LIMITS = {
  /** Max skills per creator agent */
  maxSkillsPerCreator: 10,
  /** Max prompt template size per skill */
  maxPromptLength: 2000,
  /** Max total skill listing size in system prompt (chars) */
  maxListingBudget: 1500,
  /** Max concurrent skill executions per conversation */
  maxConcurrentSkills: 2,
};
```

## What NOT To Borrow

- **User-invocable skills** — fans don't type `/skill-name`
- **Skill marketplace / sharing** — creators define skills, no marketplace
- **Plugin system** — skills are config-driven, not code-driven
- **Skill directory scanning** — skills come from config, not filesystem
- **MCP skill integration** — out of scope for creator-facing agent
- **Skill hooks with shell commands** — security risk for public agent; skills use prompt + tools only
- **Conditional activation by file path** — no filesystem context

## Implementation

### Step 1: Skill Schema and Registry

- Add `src/skills/types.ts` — `CreatorSkillConfig`, `ResolvedSkill`, `SkillListing`
- Add `src/skills/SkillRegistry.ts` — load, validate, resolve, list
- Add `src/skills/SkillValidator.ts` — config validation at load time
- Extend `src/config/schema.ts` — add `skills` array to creator config

### Step 2: Prompt Template Engine

- Add `src/skills/PromptTemplate.ts` — compile, expand, built-in variables
- Define variable resolution from creator config fields
- Handle unknown variables gracefully (empty string, no crash)

### Step 3: CreatorSkillTool

- Add `src/tools/CreatorSkillTool.ts` — tool definition + execution logic
- Implement inline execution path (via TurnExecutor)
- Implement forked execution path (via ForkedAgent)
- Register in tool registry alongside existing tools

### Step 4: Model-Facing Skill Listing

- Add `src/skills/SkillListingBuilder.ts` — build system prompt section
- Integrate with `SystemPromptBuilder` (track 01)
- Respect listing budget (max chars for skill descriptions)
- Truncate `when_to_use` to keep prompt size bounded

### Step 5: Guardrail Integration

- Wire input screening on expanded skill prompt
- Wire output validation on skill result
- Ensure tool policy enforcement within skill execution
- Skill args count as fan input for guardrail purposes

### Step 6: Execution Tracking

- Add `src/skills/SkillTracker.ts` — per-invocation recording
- Emit skill events to track 07 internal event bus
- Record in track 05 transcript
- Count toward track 11 usage/quota

### Step 7: Config Reload Support

- Wire skill registry reload into track 12 config lifecycle
- On creator config change: diff skills, reload registry
- Active skill executions complete with old config; next invocation uses new

## Example: Creator Agent With Skills

A music producer creator configures their agent:

```yaml
name: "DJ Nova"
personality: "Energetic music producer who loves helping fans"

skills:
  - name: beat_catalog
    description: "Search my beat catalog"
    when_to_use: "When fan asks about beats, instrumentals, pricing, or licensing"
    context: inline
    prompt: |
      The fan is asking about beats. Search for: $QUERY

      Beat catalog:
      - "Midnight Groove" - Hip-hop, 140 BPM, $29.99 lease / $299 exclusive
      - "Solar Flare" - EDM, 128 BPM, $19.99 lease / $199 exclusive
      - "Ocean Breeze" - Lo-fi, 85 BPM, $14.99 lease / $149 exclusive
      ...

      Present matching beats with name, genre, BPM, and pricing.
      If they want to buy, direct them to the store link.
    allowed_tools: []
    max_turns: 1

  - name: collab_request
    description: "Handle collaboration requests"
    when_to_use: "When fan asks to collaborate, work together, or feature on a track"
    context: fork
    prompt: |
      A fan wants to collaborate with $CREATOR_NAME.

      Gather this information:
      1. What type of collaboration (feature, production, remix)?
      2. Their artist name and links to their work
      3. Their budget range
      4. Timeline

      Be encouraging but professional. After gathering info,
      let them know the request will be reviewed.
    allowed_tools: []
    max_turns: 5
    timeout_seconds: 60
```

Fan conversation:
> **Fan:** "Hey do you have any lo-fi beats around 80-90 BPM?"
>
> _Agent internally calls: `CreatorSkill({ skill: "beat_catalog", args: "lo-fi beats 80-90 BPM" })`_
>
> **Agent:** "Yeah! Check out 'Ocean Breeze' — it's a lo-fi track at 85 BPM. $14.99 for a lease, $149 for exclusive rights. Want to hear a preview?"

## Dependencies

| Track | Interaction |
|-------|-------------|
| 01 (Prompts) | Skill listing injected via SystemPromptBuilder |
| 03 (Tool Runtime) | CreatorSkillTool registered in tool registry, policy enforced |
| 08 (Forked Agents) | Forked skill execution uses ForkedAgent infrastructure |
| 10 (Guardrails) | Skill input/output passes guardrail checks |
| 11 (Usage) | Skill token usage counted toward creator quota |
| 12 (Config) | Skill registry reloads on config change |
| 13 (Analytics) | Skill execution metrics tracked |

## Success Criteria

- Creator can define skills in YAML config without writing code
- Model automatically discovers and invokes skills during fan conversation
- Fans experience enhanced capabilities without knowing skills exist
- Inline skills add <2s latency to the turn
- Forked skills complete within their timeout
- Skill execution respects tool whitelist — skills can't access tools not in `allowed_tools`
- Skill output passes the same guardrails as regular agent output
- Skill usage is tracked and counted toward creator quota
- Adding a new skill requires only a config change, no code deployment
- Max 10 skills per creator, enforced at config validation
