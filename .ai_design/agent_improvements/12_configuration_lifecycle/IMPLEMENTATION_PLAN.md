# 12 — Configuration Lifecycle [deferred]

## What This Track Covers

Request-driven config reload, creator config versioning, platform overrides, feature gates for gradual rollout, and config change auditing.

## Why This Matters

Today, creator config is loaded once at startup from `config.yaml` and frozen for the lifetime of the process. Every session, every turn, every conversation shares the same immutable snapshot. If a creator updates their agent personality, boundaries, or model choice, the change only takes effect after a full process restart.

This is fine for a single-creator, single-instance deployment. It becomes a problem when:
- A creator wants to iterate on their agent's personality without downtime
- The platform needs to force-disable a tool or downgrade a model during an incident
- New agent capabilities need gradual rollout across creators

## Current State of the Codebase

### Config loading (`src/config/loader.ts`)
- `loadConfig()` reads YAML from disk, interpolates env vars, validates via Zod, returns `AgentConfig`
- Called exactly once in `src/index.ts` at startup
- The resulting `AgentConfig` is passed by reference to `Agent`, `SessionManager`, `TurnExecutor`, route handlers

### Config is captured at construction, never refreshed
- `SessionManager` derives `runtimeConfig` (fork limits, hook timeouts, session memory) in its constructor — all sessions share this snapshot
- `TurnExecutor` builds `contextDeps` (TokenBudget, ToolResultPersistence, Microcompact) in its constructor — never rebuilt
- `ModelClientFactory` creates one `ModelClient` singleton on first call — provider and API key frozen
- `ToolRegistry` registers tools at startup based on `config.soul.tools` — no add/remove after init
- `SystemPromptBuilder` caches "stable" prompt sections globally — `clearCache()` exists but is never called

### Protocol carries no config
- `/v1/task` request body: `{ request_id, conversation_id, message, history }` — no config fields
- `TurnSubmission` internal type: same four fields plus optional `promptHistory` and `signal`
- No config version in health endpoint response

### What can't change without restart
| Component | Frozen at | Would need |
|-----------|-----------|------------|
| Soul (personality, tone, boundaries) | `SessionManager` constructor | Prompt cache clear + rebuild |
| Model (provider, name, API key) | `ModelClientFactory.createClient()` | New client instance |
| Tools (allow_web_search) | `createToolRegistry()` | Registry mutation or replacement |
| Limits (max_turns, max_concurrent) | Various constructors | Field-level update |
| Context (session memory, compaction) | `TurnExecutor` constructor | Rebuild contextDeps |
| Auth (api_key, signing_secret) | HMAC middleware closure | Re-read from config |

## What Claudy Does (and What We Borrow)

Claudy treats config as a reactive stream — file watchers detect changes, caches are invalidated, and state changes propagate through an observer pattern to React components. We borrow three concepts:

1. **Config is versioned** — every config carries a content hash so the runtime knows when it changed
2. **Changes are diffed, not blindly reloaded** — detect which fields changed, apply only the relevant side effects
3. **Priority chain** — multiple config sources merged in a defined order

We do NOT borrow:
- File system watchers (our config comes from the platform request, not local files)
- CLI flag overrides (no CLI interface)
- MDM/SAML policy enforcement (platform concern)
- Statsig/GrowthBook integration (too heavy; simple gates suffice)
- Zustand-like store or React reactivity (we're a server, not a desktop app)

## Design

### Config Reloadability Classification

Not all config fields should be hot-reloadable. Some (like `server.port` or `auth.signing_secret`) are wired into infrastructure that can't safely change at runtime.

**Hot-reloadable** (change takes effect on next turn):
- `soul.*` — personality, tone, boundaries, knowledge, system_prompt_override/append
- `soul.tools.*` — tool enable/disable
- `limits.max_turns` — per-turn limit
- `limits.max_message_length`, `limits.max_history_messages` — request validation
- `context.session_memory.*` — memory extraction settings
- `model.name` — model name (same provider)
- `model.max_output_tokens` — output token limit
- `fallback_model.*` — fallback model config

**Restart-required** (ignored in hot-reload, logged as warning):
- `server.*` — port, bind address
- `auth.*` — API key, signing secret
- `model.provider` — switching provider requires new client class
- `model.api_key` — credential rotation requires new client
- `context.tool_result_persistence.storage_dir` — filesystem path
- `security.*` — HMAC tolerance

The agent logs a warning when the platform sends a config change for a restart-required field and includes the field name in the response so the platform knows the change was deferred.

### Protocol Extension: `/v1/task` Request

The platform sends creator config (or a version identifier) with each task request. The request body gains three optional fields:

```typescript
// Extension to turnRequestSchema
const turnRequestSchema = z.object({
  request_id: z.string().min(1),
  conversation_id: z.string().min(1),
  message: z.string().min(1),
  history: z.array(historyMessageSchema),

  // --- New fields (all optional for backward compat) ---

  /** SHA-256 hash of the creator's current config. */
  config_version: z.string().optional(),

  /** Full creator config, sent when agent reports a version mismatch
   *  or on first request. Omitted when version matches. */
  creator_config: creatorConfigSchema.optional(),

  /** Platform-level overrides that take precedence over creator config. */
  platform_overrides: platformOverridesSchema.optional(),
});
```

**Flow:**

1. Platform always sends `config_version` (a SHA-256 of the creator's config).
2. On first request (no cached config) or version mismatch, platform also sends `creator_config` with the full config body.
3. Agent caches the config keyed by version hash. On subsequent requests with the same version, the cached config is used.
4. `platform_overrides` are sent whenever active (incident response, compliance) and merged on top.
5. If none of the new fields are present (old platform), agent uses its startup `config.yaml` — full backward compatibility.

**Why full config in the request, not a fetch-from-platform approach:**
- No additional round-trip or new endpoint needed
- Config arrives atomically with the request that needs it
- No partial-fetch failure modes
- Platform already knows the config — just include it

### Creator Config Schema

This is the subset of `AgentConfig` that a creator controls and the platform can send per-request. It maps to the hot-reloadable fields:

```typescript
const creatorConfigSchema = z.object({
  soul: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    tone: z.string().optional().nullable(),
    boundaries: z.string().optional().nullable(),
    knowledge: z.string().optional().nullable(),
    others: z.string().optional().nullable(),
    system_prompt_override: z.string().optional().nullable(),
    system_prompt_append: z.string().optional().nullable(),
    tools: z.object({
      allow_web_search: z.boolean().default(false),
    }).default({ allow_web_search: false }),
  }),
  model: z.object({
    name: z.string().min(1),
    max_output_tokens: z.number().int().positive().optional(),
  }).optional(),
  fallback_model: modelSchema.optional(),
  limits: z.object({
    max_turns: z.number().int().positive().optional(),
    max_message_length: z.number().int().positive().optional(),
    max_history_messages: z.number().int().positive().optional(),
  }).optional(),
  context: z.object({
    session_memory: z.object({
      enabled: z.boolean().optional(),
      tokens_between_updates: z.number().int().positive().optional(),
      tool_calls_between_updates: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
});

export type CreatorConfig = z.infer<typeof creatorConfigSchema>;
```

Note: `model.provider`, `model.api_key`, `auth.*`, `server.*` are intentionally excluded — those are infrastructure concerns that require restart.

### Platform Overrides Schema

```typescript
const platformOverridesSchema = z.object({
  /** Force-disable specific tools across all creators */
  disabled_tools: z.array(z.string()).optional(),
  /** Force model name (e.g., downgrade during incident) */
  force_model: z.string().optional(),
  /** Force max turns per task */
  force_max_turns: z.number().int().positive().optional(),
  /** Append to agent boundaries (e.g., regulatory compliance) */
  appended_boundaries: z.string().optional(),
});

export type PlatformOverrides = z.infer<typeof platformOverridesSchema>;
```

Platform overrides are deliberately narrow — they restrict or constrain, never expand. A platform override can disable a tool but not enable one the creator didn't configure. It can cap max_turns but not raise it beyond the creator's limit.

### Versioned Config

```typescript
interface VersionedConfig {
  /** SHA-256 of the serialized creator config */
  version: string;
  /** When this version was first seen */
  loadedAt: number;
  /** The validated config */
  config: CreatorConfig;
  /** Platform overrides active at load time */
  overrides?: PlatformOverrides;
  /** The merged effective config (creator + overrides) */
  effective: EffectiveConfig;
}
```

The version hash is computed by the platform (it owns the config). The agent trusts the hash and uses it for comparison only — it does not recompute the hash.

### Config Differ

Detects which fields changed between two configs and maps them to required actions:

```typescript
interface ConfigDiff {
  changedFields: string[];  // dot-path: 'soul.tone', 'model.name', etc.
  actions: ConfigChangeAction[];
}

type ConfigChangeAction =
  | { type: 'rebuild_prompt' }        // soul.* changed
  | { type: 'update_tool_registry' }  // soul.tools.* changed
  | { type: 'update_model' }          // model.name or max_output_tokens changed
  | { type: 'update_limits' }         // limits.* changed
  | { type: 'update_session_memory' } // context.session_memory.* changed
  | { type: 'restart_required'; fields: string[] }; // non-reloadable field changed

function diffConfig(
  oldConfig: CreatorConfig,
  newConfig: CreatorConfig,
): ConfigDiff {
  // Deep comparison of each top-level section
  // Returns only the actions needed for the specific fields that changed
}
```

### Config Reloader

Applies a `ConfigDiff` to the running agent. This is where the architectural blockers are addressed:

```typescript
class ConfigReloader {
  constructor(
    private readonly promptBuilder: SystemPromptBuilder,
    private readonly sessionManager: SessionManager,
    private readonly modelClientFactory: ModelClientFactory,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  apply(diff: ConfigDiff, newConfig: EffectiveConfig): ConfigReloadResult {
    const applied: string[] = [];
    const deferred: string[] = [];

    for (const action of diff.actions) {
      switch (action.type) {
        case 'rebuild_prompt':
          // SystemPromptBuilder already has clearCache() — call it,
          // then update the PromptContext source so next build()
          // uses the new soul values.
          this.promptBuilder.clearCache();
          applied.push('prompt');
          break;

        case 'update_tool_registry':
          // ToolRegistry needs a reload() method (new):
          // - Compare current tools vs. new config
          // - Register/unregister as needed
          // - In-flight turns keep their existing registry snapshot
          this.toolRegistry.reload(newConfig);
          applied.push('tools');
          break;

        case 'update_model':
          // ModelClientFactory needs a replaceClient() method (new):
          // - Create new client from updated model config
          // - Swap the singleton reference
          // - Old client is not closed — in-flight requests complete naturally
          //   (HTTP clients are stateless, no connection to drain)
          this.modelClientFactory.replaceClient(newConfig.model);
          applied.push('model');
          break;

        case 'update_limits':
          // Limits are read from config on each request (validateTurnLimits),
          // so updating the config reference is sufficient.
          applied.push('limits');
          break;

        case 'update_session_memory':
          // Session memory config is captured in SessionRuntimeConfig.
          // SessionManager needs an updateRuntimeConfig() method (new).
          // Existing sessions keep old config; new sessions get new config.
          this.sessionManager.updateRuntimeConfig(newConfig);
          applied.push('session_memory');
          break;

        case 'restart_required':
          // Log warning, include in response
          deferred.push(...action.fields);
          break;
      }
    }

    return { applied, deferred };
  }
}
```

### Architectural Blocker Resolutions

**1. SystemPromptBuilder cache**

The builder already has `clearCache()` — it's just never called. On config change affecting `soul.*`:
- Call `clearCache()` to drop cached "stable" sections
- Update the `PromptContext` source (the config reference) so next `build()` uses new values
- In-flight turns that already built their prompt are unaffected — they have the prompt string already
- Next turn builds a fresh prompt from the new config

No structural change to `SystemPromptBuilder` needed.

**2. ModelClientFactory singleton**

Add a `replaceClient(modelConfig)` method:

```typescript
replaceClient(modelConfig: ModelConfig): void {
  // Only if provider hasn't changed (provider change = restart required)
  this.client = createClientFromModelConfig(modelConfig);
}
```

The old client reference is not closed or drained. HTTP model clients are stateless — each `complete()` call is an independent HTTP request. In-flight requests hold their own reference to the old client and complete normally. The next `createClient()` call returns the new instance.

If `model.provider` changed, `diffConfig` emits `restart_required` instead of `update_model`.

**3. ToolRegistry static registration**

Add a `reload(config)` method to `ToolRegistry`:

```typescript
reload(config: EffectiveConfig): void {
  const desired = new Set<string>();
  if (config.soul.tools.allow_web_search) desired.add('web_search');
  // Future: add other tools here

  // Remove tools no longer desired
  for (const name of this.tools.keys()) {
    if (!desired.has(name)) this.tools.delete(name);
  }

  // Add newly desired tools
  if (desired.has('web_search') && !this.tools.has('web_search')) {
    this.tools.set('web_search', new WebSearchTool());
  }
}
```

In-flight turns already captured `toolRegistry.listDefinitions()` at the start of their ReAct loop — they keep the old set. Next turn picks up the new registry.

**4. SessionManager config snapshot**

Add `updateRuntimeConfig(config)`:

```typescript
updateRuntimeConfig(config: EffectiveConfig): void {
  this.runtimeConfig = deriveRuntimeConfig(config);
  // Existing sessions keep their old runtimeConfig
  // New sessions (getOrCreateRuntime) pick up the updated one
}
```

Existing sessions are not disrupted. The new config applies to sessions created after the change. This is intentional — changing session memory settings mid-conversation could corrupt extraction state.

### In-Flight Turn Handling

Config changes apply on the **next turn**, not the current one. This is a deliberate design choice:

- A turn in progress has already built its prompt, selected its model client, and is mid-ReAct-loop
- Interrupting it would require cancellation + retry, adding complexity for no user benefit
- The platform sends config with each `/v1/task` request, so the next request naturally picks up the change

The flow:

```
Request N arrives with config_version "abc123"
  → Agent has no cached config (first request)
  → Reads creator_config from request body
  → Caches as version "abc123"
  → Executes turn with this config

[Creator updates their config on the platform]

Request N+1 arrives with config_version "def456"
  → Agent compares "def456" != cached "abc123"
  → Reads creator_config from request body
  → Diffs old vs new → produces ConfigDiff
  → Applies ConfigDiff (clear prompt cache, swap model, etc.)
  → Caches as version "def456"
  → Executes turn with new config
```

If two requests arrive concurrently and one carries a config update, the first request to be processed applies the change. The second sees the already-updated cache and proceeds normally. No lock needed — config version comparison and swap is synchronous in the single-threaded event loop.

### Config Merge: Priority Chain

When both `creator_config` and `platform_overrides` are present, they merge:

```typescript
function mergeEffectiveConfig(
  base: AgentConfig,          // startup config.yaml (infrastructure defaults)
  creator: CreatorConfig,     // from request
  overrides?: PlatformOverrides, // from request
): EffectiveConfig {
  // Start with startup config for non-reloadable fields
  const effective = { ...base };

  // Layer creator config on top (hot-reloadable fields only)
  effective.soul = creator.soul;
  if (creator.model) {
    effective.model = { ...base.model, ...creator.model };
  }
  if (creator.limits) {
    effective.limits = { ...base.limits, ...creator.limits };
  }
  // ... etc

  // Apply platform overrides (highest priority, restrictive only)
  if (overrides?.disabled_tools?.length) {
    // Remove disabled tools from effective config
  }
  if (overrides?.force_model) {
    effective.model.name = overrides.force_model;
  }
  if (overrides?.force_max_turns) {
    effective.limits.max_turns = Math.min(
      effective.limits.max_turns,
      overrides.force_max_turns,
    );
  }
  if (overrides?.appended_boundaries) {
    effective.soul.boundaries =
      (effective.soul.boundaries ?? '') + '\n' + overrides.appended_boundaries;
  }

  return effective;
}
```

Priority: **platform overrides > creator config > startup config.yaml**

### Feature Gates

Simple, request-header-driven feature gates for gradual rollout of new agent capabilities:

```typescript
interface FeatureGates {
  [gateName: string]: boolean;
}
```

Delivered via a request header (not the body — gates are platform infrastructure, not creator config):

```
X-DigitalMe-Feature-Gates: {"session_memory_v2":true,"effort_routing":false}
```

Usage in code:

```typescript
function isGateEnabled(gates: FeatureGates | undefined, name: string): boolean {
  return gates?.[name] === true;
}

// In TurnExecutor:
if (isGateEnabled(gates, 'session_memory_v2')) {
  // Use new memory extraction
}
```

Gate evaluation happens on the platform side (percentage rollout, allowlists, etc.). The agent just receives the resolved boolean decisions. This keeps the agent simple — no rollout logic, no creator ID hashing, no gate storage.

### Error Handling

**Invalid creator config in request:**
- Zod validation fails → agent returns 422 with validation errors
- Agent continues using the previously cached config (or startup config if no cache)
- Does not crash or reject the turn — the fan's message still gets processed

**Config reload partially fails:**
- Each `ConfigChangeAction` is applied independently
- If `update_model` fails (e.g., invalid model name), the error is logged and that action is skipped
- Other actions (prompt rebuild, limit update) still apply
- The `ConfigReloadResult` reports which actions succeeded and which failed
- The partially-updated config is NOT cached — next request retries the full reload

**No creator config and no startup config:**
- Impossible — `loadConfig()` at startup throws if config.yaml is missing or invalid
- The agent always has a valid startup config as the baseline

### Backward Compatibility

All new request fields are optional:

| Platform version | What it sends | Agent behavior |
|-----------------|---------------|----------------|
| Old (no config fields) | `{ request_id, conversation_id, message, history }` | Uses startup `config.yaml` — identical to today |
| New (version only) | `+ config_version` | Compares version, uses cached or startup config |
| New (full) | `+ config_version, creator_config` | Caches and applies creator config |
| New (with overrides) | `+ config_version, creator_config, platform_overrides` | Merges with overrides |

The agent never breaks if the platform doesn't send config fields. The feature is purely additive.

### Health Endpoint Extension

Add config version to health response:

```typescript
{
  "status": "ok",
  "config_version": "sha256:abc123...",  // or "startup" if no request-driven config
  "config_loaded_at": 1712956800000,
  // ... existing fields
}
```

### Config Change Audit Trail

Every config change emits a structured log entry:

```typescript
interface ConfigChangeRecord {
  timestamp: number;
  previousVersion: string;
  newVersion: string;
  changedFields: string[];
  actions: string[];        // which ConfigChangeActions were applied
  deferred: string[];       // restart-required fields that were skipped
  source: 'creator_update' | 'platform_override';
  conversationId: string;   // which request triggered the change
  requestId: string;
}
```

This is emitted via `console.log` (structured JSON) immediately. Integration with Track 07 (internal event bus) and Track 05 (transcript recording) will be added when those tracks are ready — the audit record format is designed to be compatible but does not depend on them existing.

## Dependencies

### Hard dependencies (must exist before implementation)
- None. This track can be implemented independently.

### Soft dependencies (integration points, added later)
- **Track 05 (Transcripts)** — add config version to turn transcript entries. TranscriptRecorder exists but inline recording isn't wired yet. When it is, add `configVersion` field to transcript entries.
- **Track 07 (Events)** — emit `config_change` as an `AgentEvent`. Currently only `text_delta`, `tool_start`, `tool_end`, `done`, `error`, `recovery` exist. Add when event bus is expanded.
- **Track 09 (Model Routing)** — `update_model` action in ConfigReloader aligns with model routing. When Track 09 adds background model support, ConfigReloader gains an `update_background_model` action.
- **Track 10 (Guardrails)** — when guardrails are implemented, ConfigReloader gains an `update_guardrails` action. Until then, guardrail-related config changes are no-ops.
- **Track 14 (Creator Skills)** — ConfigReloader provides the `reload()` hook that SkillRegistry wires into.

## Implementation Steps

### Step 1: Versioned Config and Protocol Extension

Add the protocol extension and config caching. No reload logic yet — just detect that config changed.

Files to modify:
- `src/protocol/schemas.ts` — add `config_version`, `creator_config`, `platform_overrides` to `turnRequestSchema`
- `src/config/schema.ts` — add `creatorConfigSchema`, `platformOverridesSchema`, `VersionedConfig` type
- `src/config/versioning.ts` (new) — `VersionedConfig` type, cache, version comparison

Files to modify for wiring:
- `src/routes/turns.ts` — extract new fields from parsed request, pass to agent
- `src/agent/types.ts` — add config fields to `TurnSubmission`

### Step 2: Config Differ

Diff two `CreatorConfig` instances and produce a list of required actions.

Files:
- `src/config/ConfigDiffer.ts` (new) — `diffConfig()` function, `ConfigDiff` and `ConfigChangeAction` types

### Step 3: Config Reloader

Apply config diffs to the running agent. This step adds the new methods to existing components.

Files:
- `src/config/ConfigReloader.ts` (new) — `ConfigReloader` class
- `src/models/ModelClientFactory.ts` — add `replaceClient()` method
- `src/tools/registry.ts` — add `reload()` method
- `src/agent/SessionManager.ts` — add `updateRuntimeConfig()` method

### Step 4: Config Merge and Override Application

Merge creator config with startup config and platform overrides.

Files:
- `src/config/merge.ts` (new) — `mergeEffectiveConfig()` function, `EffectiveConfig` type

### Step 5: End-to-End Wiring

Connect everything: request → version check → diff → reload → execute.

Files:
- `src/agent/Agent.ts` — orchestrate config check/reload before submitting turn
- `src/routes/health.ts` — add config version to health response

### Step 6: Feature Gates

Add request-header-driven feature gates.

Files:
- `src/config/FeatureGates.ts` (new) — `FeatureGates` type, `isGateEnabled()` helper
- `src/routes/turns.ts` — parse `X-DigitalMe-Feature-Gates` header
- `src/agent/types.ts` — add `featureGates` to `TurnSubmission`

### Step 7: Audit Trail and Observability

Structured logging for config changes, health endpoint extension.

Files:
- `src/config/ConfigReloader.ts` — emit `ConfigChangeRecord` on every reload
- `src/routes/health.ts` — include config version in response

## Success Criteria

- Creator config changes take effect on the next turn (not requiring restart or new session)
- Config version is tracked — health endpoint reports current version
- Platform can override creator config for safety/operational reasons
- Old platforms (no config fields in request) work identically to today
- In-flight turns are never interrupted by config changes
- Restart-required fields are detected and logged, not silently ignored
- Feature gates enable gradual rollout of new capabilities via request headers
- Config changes are logged with before/after versions, changed fields, and applied actions
- No config change causes a crash — validation catches invalid configs, partial failures are handled gracefully
