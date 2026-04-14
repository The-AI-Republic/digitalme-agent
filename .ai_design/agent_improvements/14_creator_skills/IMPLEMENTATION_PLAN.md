# 14 — Creator Skills

## What This Track Covers

A file-based skill system where **creators define capabilities** that the agent can invoke automatically during fan conversations. Skills are creator-configured, model-invoked, and invisible to fans — fans experience a more capable agent without knowing skills exist.

## Design Principles

1. **Skills are files, not config entries** — each skill is a `SKILL.md` file in its own directory, not embedded in `config.yaml`
2. **Claude Code compatible** — same SKILL.md format (markdown + YAML frontmatter) as Claude Code's skill system
3. **Two sources, one view** — bundled skills (baked into image) and local skills (`~/.digitalme/skills/`) are merged into a single flat list at runtime
4. **Model-invoked only** — fans never see or type `/skill-name`; the model decides when to use a skill
5. **Technical creators for now** — platform-managed skills via web dashboard is a future track

## Skill Format (Claude Code Compatible)

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter + markdown prompt:

```
skills/beat-catalog/
├── SKILL.md              ← required: frontmatter + prompt
└── pricing.md            ← optional: supporting context
```

```markdown
---
name: beat-catalog
description: Search my beat catalog for instrumentals
when_to_use: When fan asks about beats, instrumentals, pricing, or licensing
allowed-tools: []
context: inline
max-turns: 1
timeout-seconds: 30
---

The fan is asking about beats. Search for: $ARGUMENTS

Beat catalog:
- "Midnight Groove" - Hip-hop, 140 BPM, $29.99 lease / $299 exclusive
- "Solar Flare" - EDM, 128 BPM, $19.99 lease / $199 exclusive
- "Ocean Breeze" - Lo-fi, 85 BPM, $14.99 lease / $149 exclusive

Present matching beats with name, genre, BPM, and pricing.
If they want to buy, direct them to the store link.
```

### Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | directory name | Skill identifier (lowercase, hyphens) |
| `description` | Yes | — | One-line description for model discovery (max 200 chars) |
| `when_to_use` | Yes | — | When the model should auto-invoke this skill |
| `allowed-tools` | No | `[]` | Tools this skill can use (whitelist from platform-allowed tools) |
| `context` | No | `inline` | Execution mode: `inline` (same context) or `fork` (isolated sub-agent) |
| `model` | No | `inherit` | Model override, or `inherit` from conversation model |
| `max-turns` | No | `1` (inline) / `3` (fork) | Max turns the skill can take (safety limit) |
| `timeout-seconds` | No | `30` | Execution timeout |
| `argument-hint` | No | — | Hint for what arguments the skill expects |

### What's Compatible vs. DigitalMe-Specific

| Field | Claude Code | DigitalMe | Notes |
|-------|------------|-----------|-------|
| `name` | same | same | |
| `description` | same | same | |
| `when_to_use` | same | same | |
| `allowed-tools` | same | same | constrained to platform-approved tools |
| `context` | `inline`/`fork` | `inline`/`fork` | same two modes |
| `model` | `sonnet`/`haiku`/`opus` | `inherit`/specific | resolves against creator's model config |
| `user-invocable` | true/false | **ignored (always false)** | fans never type `/skill-name` |
| `disable-model-invocation` | true/false | **ignored (always false)** | model always auto-invokes |
| `max-turns` | N/A | DigitalMe-specific | safety limit |
| `timeout-seconds` | N/A | DigitalMe-specific | safety limit |
| `argument-hint` | same | same | |
| `shell` | bash/powershell | **disabled** | no shell execution in skills for security |
| `hooks` | supported | **disabled** | no lifecycle hooks in creator skills |
| `paths` | supported | **ignored** | no filesystem context |

### Arguments

Skills receive arguments via `$ARGUMENTS` (all arguments as one string). This matches Claude Code's argument substitution pattern, but DigitalMe wraps the raw value before substitution so skill bodies never receive fan text as an undelimited blob. The model passes relevant context from the fan's message as the `args` parameter when invoking a skill.

### What's Disabled For Security

Creator skills in a public-facing agent are more restricted than Claude Code skills:

- **No shell execution** — `!`command`` syntax in skill body is not executed
- **No lifecycle hooks** — skill `hooks:` field is ignored
- **No arbitrary tool access** — `allowed-tools` is constrained to platform-approved tools only
- **No user invocation** — fans can't type `/skill-name`

## Skill Sources and Merging

### Config-Resolved Directories

Skill directories are configurable, not hardcoded. Add a `skills` section to `src/config/schema.ts`:

```typescript
skills: z.object({
  bundled_dir: z.string().default('./skills'),
  local_dir: z.string().default('/app/skills-local'),
}).default({})
```

- `bundled_dir` defaults to the repo-local `./skills` so `npm run dev` works outside Docker
- `local_dir` defaults to `/app/skills-local` because that is what `docker-compose.yml` mounts today
- Docker can still override `bundled_dir` to `/app/skills` if needed, but the design should not require container-only paths
- The registry resolves both paths once at startup from config

### Two Directories

```
Container filesystem:
  /app/skills/            ← bundled: baked into Docker image at build time
  /app/skills-local/      ← local: mounted from ~/.digitalme/skills/ on host
```

### Merge Strategy

Both directories are scanned for `*/SKILL.md` files and merged into one flat list:

```typescript
const bundled = scanSkillDir(config.skills.bundled_dir); // S1, S2
const local   = scanSkillDir(config.skills.local_dir);   // S3, S4

// Local overrides bundled on name collision
const merged = new Map<string, LoadedSkill>();
for (const s of bundled) merged.set(s.name, s);
for (const s of local)   merged.set(s.name, s);  // overwrites same name

return [...merged.values()];  // [S1, S2, S3, S4]
```

**Priority**: local > bundled (same-name local skill replaces bundled)

If a local skill overrides a bundled skill, log a startup warning with both source paths so accidental shadowing is visible.

**From the agent's perspective**: one flat list of skills. No source distinction leaks into the rest of the system.

### Repo Structure

```
digitalme-agent/
├── Dockerfile              ← COPY skills ./skills
├── docker-compose.yml      ← mounts ~/.digitalme/skills:/app/skills-local:ro
├── skills/                 ← bundled skills (baked into image)
│   ├── faq-lookup/
│   │   └── SKILL.md
│   ├── contact-info/
│   │   └── SKILL.md
│   └── off-topic-redirect/
│       └── SKILL.md
```

### Host Structure (Creator's Machine)

```
~/.digitalme/
└── skills/                 ← creator's custom skills (mounted read-only)
    ├── beat-catalog/
    │   └── SKILL.md
    └── collab-request/
        ├── SKILL.md
        └── pricing.md
```

### Docker Configuration

```yaml
# docker-compose.yml
volumes:
  - ./config.yaml:/app/config.yaml:ro
  - ~/.digitalme/skills:/app/skills-local:ro   # creator skills
  - rollouts:/app/.digital_me_agent/rollouts
```

If `~/.digitalme/skills/` doesn't exist or is empty, the agent works fine with just bundled skills.

## What Claudy Does (Reference)

### Skill Definition

YAML frontmatter + Markdown prompt in `SKILL.md` files:

```yaml
---
name: skill-name
description: "One-line description"
when_to_use: "When the user asks about X, Y, Z"
allowed-tools: [Bash, Read, Write]
context: inline | fork
model: claude-sonnet
disable-model-invocation: false
user-invocable: true
---

Detailed prompt instructions for the skill...
```

### Skill Discovery

Skills loaded from multiple directories with priority:
1. Enterprise (managed settings)
2. Personal (`~/.claude/skills/`)
3. Project (`.claude/skills/`)
4. Plugin skills
5. MCP skills
6. Bundled skills

### Model Discovery

Skills listed in `<system-reminder>` blocks injected each turn. The model sees:

```
Available skills:
- product_search: Search product catalog - When fan asks about products, pricing
- schedule_meeting: Book a call - When fan wants to schedule
```

The model calls `Skill({ skill: "product_search", args: "blue widget" })` when it decides to.

### Two Execution Modes

1. **Inline** — skill prompt expands into the current conversation. Model continues in same context.
2. **Forked** — skill runs in isolated sub-agent with separate token budget. Results flow back as text.

### Key Design Decisions

- `when_to_use` guides model on **when** to auto-invoke (truncated to 250 chars in listing)
- `allowed-tools` restricts which tools the skill can use (whitelist)
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
| SKILL.md parser | Missing | Parse frontmatter + markdown body from SKILL.md files |
| Skill directory scanner | Missing | Scan configured bundled/local skill directories for `*/SKILL.md` |
| Skill merge logic | Missing | Merge bundled + local, dedup by name (local wins) |
| Skill registry | Missing | Hold merged skill list, expose to system prompt and tool |
| Model-facing skill listing | Missing | Inject available skills into system prompt |
| CreatorSkillTool | Missing | Tool the model calls to invoke skills |
| Argument substitution | Missing | `$ARGUMENTS` expansion in skill prompt |
| Skill execution tracking | Missing | Usage, cost, success rate per skill |

## Design

### 1. Loaded Skill Type

```typescript
interface LoadedSkill {
  /** Parsed from SKILL.md frontmatter or directory name */
  name: string;
  description: string;
  when_to_use: string;
  allowed_tools: string[];
  context: 'inline' | 'fork';
  model: 'inherit' | string;
  max_turns: number;
  timeout_seconds: number;
  argument_hint?: string;

  /** The full markdown prompt body (below frontmatter) */
  prompt: string;

  /** Supporting files content (other .md files in skill directory) */
  supporting_context: string[];

  /** Absolute path to the skill directory for logging/debugging. */
  source_dir: string;

  /** Whether this skill came from bundled or local storage. */
  source: 'bundled' | 'local';
}
```

### 2. SKILL.md Parser

```typescript
interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseSkillFile(content: string): ParsedSkillFile {
  // Split on --- markers
  // Parse YAML frontmatter
  // Return frontmatter + markdown body
}

function toLoadedSkill(
  parsed: ParsedSkillFile,
  dirName: string,
): LoadedSkill {
  // Validate required fields (description, when_to_use)
  // Apply defaults (context: inline, max_turns: 3, etc.)
  // Name falls back to directory name if not in frontmatter
  // Return LoadedSkill
}
```

### 3. Skill Directory Scanner

```typescript
function scanSkillDir(dirPath: string): LoadedSkill[] {
  // If directory doesn't exist, return []
  // List subdirectories
  // For each subdir, look for SKILL.md
  // Parse SKILL.md → LoadedSkill
  // Also read any other .md files as supporting context
  // Enforce supporting-file limits before loading:
  //   - max 5 supporting markdown files
  //   - max 50 KB per supporting file
  // Skip invalid skills with warning log
  // Return LoadedSkill[]
}
```

### 4. Skill Registry

```typescript
class SkillRegistry {
  private skills: Map<string, LoadedSkill> = new Map();

  /** Load and merge skills from bundled + local directories */
  load(bundledDir: string, localDir: string): void {
    const bundled = scanSkillDir(bundledDir);
    const local = scanSkillDir(localDir);

    // Bundled first, local overwrites on name collision
    for (const s of bundled) this.skills.set(s.name, s);
    for (const s of local) this.skills.set(s.name, s);
  }

  /** Get all skills for model-facing listing */
  list(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  /** Get a skill by name for execution */
  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  /** Number of loaded skills */
  get size(): number {
    return this.skills.size;
  }
}
```

### 5. Model-Facing Skill Listing

Skills are injected into the system prompt so the model knows they exist:

```typescript
function buildSkillListingSection(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  const MAX_DESC_LENGTH = 200;
  const MAX_LISTING_BUDGET = 1500;

  const lines: string[] = [];
  let used = 0;

  for (const s of skills) {
    const desc = s.when_to_use
      ? `${s.description} - ${s.when_to_use}`
      : s.description;
    const truncated = desc.length > MAX_DESC_LENGTH
      ? desc.slice(0, MAX_DESC_LENGTH - 1) + '...'
      : desc;
    const line = `- ${s.name}: ${truncated}`;

    if ((used + line.length + 1) > MAX_LISTING_BUDGET) {
      break;
    }

    lines.push(line);
    used += line.length + 1;
  }

  return [
    'Available skills:',
    ...lines,
    '',
    'Use the CreatorSkill tool to invoke a skill when appropriate.',
    'Pass the skill name and any relevant context from the fan\'s message as args.',
  ].join('\n');
}
```

If not all skills fit, append a final line such as `- ... additional skills omitted due to prompt budget` if budget allows.

**Known v1 limitation**: At typical line lengths (~230 chars each), the 1500-char budget fits ~6-7 skills. Creators with more skills should order them by priority in their directory (alphabetical by directory name), since the first N skills that fit are listed. A future enhancement could introduce skill categories, dynamic budget scaling, or a two-tier listing (short names for overflow skills).

This section is added to the system prompt via `SystemPromptBuilder`, which requires:

- `PromptContext.skillListing?: string | null`
- a new prompt section in `PROMPT_SECTIONS`
- `enabledWhen: (ctx) => Boolean(ctx.skillListing)`

### 6. CreatorSkillTool

A new tool that the model calls to invoke creator-defined skills:

```typescript
export function createCreatorSkillTool(deps: CreatorSkillToolDeps): Tool<CreatorSkillInput> {
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CreatorSkill',
      description: 'Invoke a creator-defined skill to handle a specific task.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Name of the skill to invoke.' },
          args: { type: 'string', description: 'Relevant context from the fan message.' },
        },
        required: ['skill'],
      },
    },
  };

  return {
    name: 'CreatorSkill',
    definition,
    metadata: {
      ...DEFAULT_TOOL_METADATA,
      timeoutMs: 60_000,
      policyCategory: 'action',
    },
    inputSchema: creatorSkillInputSchema,
    isConcurrencySafe: () => false,
    async execute(args, context) {
      // implementation
    },
  };
}
```

This should follow the `createSubagentTool(...)` factory pattern rather than inventing a parallel tool shape.

**Execution flow:**

```typescript
async execute(
  input: { skill: string; args?: string },
  context: ToolContext,
): Promise<ToolResult> {
  // 1. Look up skill in registry
  const skill = this.skillRegistry.get(input.skill);
  if (!skill) {
    const msg = `Unknown skill: ${input.skill}`;
    return { success: false, data: msg, renderForModel: () => msg };
  }

  // 2. Expand $ARGUMENTS in prompt
  const expandedPrompt = expandArguments(skill.prompt, input.args ?? '');

  // 3. Append supporting context if any
  const fullPrompt = skill.supporting_context.length > 0
    ? expandedPrompt + '\n\n' + skill.supporting_context.join('\n\n')
    : expandedPrompt;

  // 4. Route to inline or forked execution
  if (skill.context === 'fork') {
    return this.executeForked(skill, fullPrompt, context);
  } else {
    return this.executeInline(skill, fullPrompt, context);
  }
}
```

**Inline execution** — returns expanded skill instructions as tool result text for the model to read and continue in the same parent turn:

```typescript
private async executeInline(
  skill: LoadedSkill,
  prompt: string,
  context: ToolContext,
): Promise<ToolResult> {
  return {
    success: true,
    data: { prompt },
    renderForModel: () => [
      `Skill instructions for ${skill.name}:`,
      prompt,
      '',
      'Follow these instructions now in the current conversation.',
    ].join('\n'),
  };
}
```

This is intentionally different from the current subagent path. If we call `TurnExecutor.run(...)` here, we are creating a fresh nested turn, not a true inline skill expansion.

Because inline execution stays inside the parent turn loop:

- default `max-turns` for inline skills should be `1`
- inline skills must use the parent conversation's model; model override is fork-only in v1
- inline skills do not need timeout handling beyond the normal tool timeout

**Forked execution** — uses the existing ForkedAgent infrastructure:

```typescript
private async executeForked(
  skill: LoadedSkill,
  prompt: string,
  context: ToolContext,
): Promise<ToolResult> {
  // buildForkedSkillSubmission returns a full TurnSubmission matching the
  // pattern used by SubagentTool (see src/agent/subagent/SubagentTool.ts):
  const submission = buildForkedSkillSubmission({
    requestId: `skill-${skill.name}-${Date.now()}`,
    conversationId: context.conversationId,
    userMessage: prompt,
    history: [],
    promptHistory: [],
    signal: context.signal,
    skillName: skill.name,
  });

  const handle = launchForkedAgent({
    sessionRuntime: deps.sessionRuntime,
    forkSemaphore: deps.forkSemaphore,
    turnExecutor: this.turnExecutor,
    submission,
    options: {
      maxTurns: skill.max_turns,
      model: skill.model === 'inherit' ? undefined : skill.model,
      toolRegistry: buildForkedSkillToolRegistry(skill.allowed_tools),
      // guardrailScope: 'internal',  // uncomment when Track 10 adds this field to ExecutionOptions
    },
    config: {
      forkLabel: `skill:${skill.name}`,
      skipTranscript: false,
    },
  });

  if (!handle) {
    const msg = 'Skill execution unavailable (concurrency limit reached)';
    return { success: false, data: msg, renderForModel: () => msg };
  }

  const result = await awaitWithTimeout(
    handle.promise,
    skill.timeout_seconds * 1000,
  );

  return {
    success: true,
    data: result.finalText,
    renderForModel: () => result.finalText,
  };
}
```

Required helper behavior:

- `buildForkedSkillToolRegistry(...)` should reuse the `resolveSubagentTools(...)` pattern rather than inventing a new registry API
- `CreatorSkill` must be excluded from the forked registry to prevent recursive self-invocation
- the forked path should inherit Track 10's `guardrailScope: 'internal'` so fan-facing input/output rules do not screen internal skill prompts. Note: `guardrailScope` does not exist on `ExecutionOptions` yet — omit it until Track 10 adds the field, then wire it in
- `awaitWithTimeout(...)` must be implemented in this track — `timeout-seconds` is a required frontmatter field with validated bounds (max 120s), so the helper is not optional

### 7. Argument Expansion

```typescript
function expandArguments(prompt: string, args: string): string {
  const hasPlaceholder = /\$ARGUMENTS/.test(prompt);

  if (hasPlaceholder) {
    return prompt.replace(
      /\$ARGUMENTS/g,
      `<skill-arguments>\n${args}\n</skill-arguments>`,
    );
  }

  // If the skill prompt does not use $ARGUMENTS but the model passed args,
  // append the fan's context so the skill still has access to it.
  if (args) {
    return prompt + `\n\n<skill-arguments>\n${args}\n</skill-arguments>`;
  }

  return prompt;
}
```

Simple substitution only. No shell execution, no environment variable expansion. Wrapping the arguments in delimiters prevents the fan-provided text from blending invisibly into the skill author’s instructions.

### 8. Skill Validation

Validate skills at load time:

```typescript
function validateSkill(skill: LoadedSkill): ValidationResult {
  const errors: string[] = [];

  if (!/^[a-z][a-z0-9-]*$/.test(skill.name)) {
    errors.push(`Invalid skill name: ${skill.name} (lowercase alphanumeric with hyphens)`);
  }
  if (!skill.description || skill.description.length > 200) {
    errors.push('description required, max 200 chars');
  }
  if (!skill.when_to_use || skill.when_to_use.length < 10) {
    errors.push('when_to_use required (min 10 chars)');
  }
  if (!skill.prompt || skill.prompt.length < 20) {
    errors.push('prompt required (min 20 chars)');
  }
  if (skill.max_turns > 10) {
    errors.push('max-turns cannot exceed 10');
  }
  if (skill.timeout_seconds > 120) {
    errors.push('timeout-seconds cannot exceed 120');
  }

  return { valid: errors.length === 0, errors };
}
```

### 9. Skill Execution Tracking

Every skill invocation produces a tracking record:

```typescript
interface SkillExecutionRecord {
  skillName: string;
  conversationId: string;
  timestamp: number;
  context: 'inline' | 'fork';
  success: boolean;
  errorReason?: string;
  latencyMs: number;
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: string[];
}
```

This should align with existing observability types rather than introducing a disconnected parallel record. Prefer:

- transcript lifecycle/message entries for persistent history
- existing `ToolExecutionRecord` / `ToolSummaryEntry` style fields where possible
- a thin skill-specific event payload only for fields that do not already exist elsewhere

This integrates with:
- Track 05 (Transcripts) — recorded in turn transcript
- Track 07 (Events) — emitted as internal event
- Track 11 (Usage) — counted toward creator usage/quota

### 10. Guardrail Integration

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

Track 10 already defines `guardrailScope?: 'public' | 'internal'` on `ExecutionOptions`. Skill design must align with that split:

- top-level fan conversations remain `guardrailScope: 'public'`
- forked skill execution uses `guardrailScope: 'internal'`
- inline skills do not launch a new turn, so they rely on the parent turn's normal fan-facing output validation
- if Track 10 is not yet implemented, this track should depend on the documented interfaces and treat them as optional injected deps

### 11. Limits

```typescript
const SKILL_LIMITS = {
  /** Max skills per agent (bundled + local combined) */
  maxSkillsTotal: 20,
  /** Max prompt size per skill (chars, after supporting context appended) */
  maxPromptLength: 5000,
  /** Max number of supporting markdown files loaded per skill */
  maxSupportingFiles: 5,
  /** Max size of an individual supporting markdown file */
  maxSupportingFileBytes: 50_000,
  /** Max total skill listing size in system prompt (chars) */
  maxListingBudget: 1500,
  /** Max concurrent skill executions per conversation */
  maxConcurrentSkills: 2,
};
```

## What NOT To Build (Current Scope)

- **Platform-managed skills via web dashboard** — future track for non-technical creators
- **User-invocable skills** — fans don't type `/skill-name`
- **Skill marketplace / sharing** — out of scope
- **Shell execution in skills** — security risk for public agent
- **Skill lifecycle hooks** — disabled for creator skills
- **MCP skill integration** — out of scope
- **Skill hot-reload** — requires track 12 (deferred); restart to pick up changes

## Implementation Steps

### Step 1: SKILL.md Parser and Scanner

- Add `src/skills/SkillParser.ts` — parse YAML frontmatter + markdown body
- Add `src/skills/SkillScanner.ts` — scan directory for `*/SKILL.md` files, load supporting `.md` files
- Add `src/skills/types.ts` — `LoadedSkill`, `SkillExecutionRecord`
- Add `src/skills/SkillValidator.ts` — validate at load time
- Use the existing `yaml` dependency already present in `package.json`

### Step 2: Skill Registry

- Add `src/skills/SkillRegistry.ts` — load from two dirs, merge, dedup, expose list/get
- Wire into agent startup — load skills once at init
- Log loaded skill count and names
- Log explicit warnings when a local skill overrides a bundled skill

### Step 3: CreatorSkillTool

- Add `src/tools/CreatorSkillTool.ts` — tool definition + execution logic
- Implement `$ARGUMENTS` expansion
- Implement inline execution path as tool-result prompt expansion in the parent turn
- Implement forked execution path (via ForkedAgent)
- Reuse `resolveSubagentTools(...)`-style registry filtering
- Exclude `CreatorSkill` from child registries to prevent recursion
- Register in tool registry when skills exist

### Step 4: Model-Facing Skill Listing

- Add `src/skills/SkillListingBuilder.ts` — build system prompt section
- Integrate with `SystemPromptBuilder` (track 01)
- Respect listing budget (1500 chars max)
- Define deterministic truncation/omission strategy when budget is exceeded
- Omit section entirely when no skills loaded

### Step 5: Guardrail Integration

- Wire input screening on expanded skill prompt
- Wire output validation on skill result
- Ensure tool policy enforcement within skill execution
- Skill args treated as fan input for guardrail purposes
- Align with Track 10 `guardrailScope` semantics (`public` for top-level, `internal` for forks)

### Step 6: Execution Tracking

- Add `src/skills/SkillTracker.ts` — per-invocation recording
- Emit skill events to track 07 internal event bus
- Record in track 05 transcript
- Count toward track 11 usage/quota

### Step 7: Tests

- Unit tests for parser, validator, scanner, and listing builder
- Unit tests for argument expansion and supporting-file limits
- Integration test for inline skill invocation returning tool-result prompt text
- Integration test for forked skill invocation with timeout handling
- Integration test that child registries exclude `CreatorSkill`
- Integration test for local-overrides-bundled warning path

## Example: Creator Agent With Skills

A music producer creates `~/.digitalme/skills/` on their host:

```
~/.digitalme/skills/
├── beat-catalog/
│   └── SKILL.md
└── collab-request/
    ├── SKILL.md
    └── pricing.md
```

`beat-catalog/SKILL.md`:

```markdown
---
name: beat-catalog
description: Search my beat catalog for instrumentals
when_to_use: When fan asks about beats, instrumentals, pricing, or licensing
allowed-tools: []
context: inline
max-turns: 1
---

The fan is asking about beats. Search for: $ARGUMENTS

Beat catalog:
- "Midnight Groove" - Hip-hop, 140 BPM, $29.99 lease / $299 exclusive
- "Solar Flare" - EDM, 128 BPM, $19.99 lease / $199 exclusive
- "Ocean Breeze" - Lo-fi, 85 BPM, $14.99 lease / $149 exclusive

Present matching beats with name, genre, BPM, and pricing.
If they want to buy, direct them to the store link.
```

Fan conversation:
> **Fan:** "Hey do you have any lo-fi beats around 80-90 BPM?"
>
> _Agent internally calls: `CreatorSkill({ skill: "beat-catalog", args: "lo-fi beats 80-90 BPM" })`_
>
> **Agent:** "Yeah! Check out 'Ocean Breeze' — it's a lo-fi track at 85 BPM. $14.99 for a lease, $149 for exclusive rights. Want to hear a preview?"

The fan never knows a skill was invoked. They just get a better answer.

## Dependencies

| Track | Interaction |
|-------|-------------|
| 01 (Prompts) | Skill listing injected via SystemPromptBuilder |
| 03 (Tool Runtime) | CreatorSkillTool registered in tool registry, policy enforced |
| 08 (Forked Agents) | Forked skill execution uses ForkedAgent infrastructure |
| 10 (Guardrails) | Skill input/output passes guardrail checks |
| 11 (Usage) | Skill token usage counted toward creator quota |

## Success Criteria

- Creator can define skills as SKILL.md files without writing code
- Same SKILL.md format as Claude Code (compatible frontmatter fields)
- Model automatically discovers and invokes skills during fan conversation
- Fans experience enhanced capabilities without knowing skills exist
- Bundled skills work out of the box with zero creator configuration
- Creator's local skills override bundled skills of the same name
- If `~/.digitalme/skills/` is empty or unmounted, agent works fine
- Inline skills add <2s latency to the turn
- Forked skills complete within their timeout
- Skill output passes the same guardrails as regular agent output
- Skill usage is tracked and counted toward creator quota
