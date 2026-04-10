# 12 — Configuration Lifecycle

## What This Track Covers

Configuration hot-reload, creator config versioning, feature gates for gradual rollout, dynamic runtime configuration, and configuration validation lifecycle.

## Why This Is Not Covered by Existing Tracks

No existing track addresses how configuration changes propagate through the running agent. Today, configuration is loaded once at startup (or once per session creation). Claudy demonstrates that a production agent runtime needs live configuration updates, especially when serving multiple creators concurrently.

## What Claudy Does

Claudy has a multi-source configuration system with live updates:

### Configuration Sources (priority order)
1. CLI flags (highest priority)
2. Environment variables
3. `~/.claude/config.json` — user settings, **watched for changes**
4. Remote Managed Settings — org policies via MDM/SAML
5. Feature Gates — Statsig feature flags, cached and refreshed per query

### Hot-Reload
- File watchers on `~/.claude/config.json` — changes apply without restart
- Skill directory watchers — new skills discovered automatically
- Settings sync via `onChangeAppState` callback

### Feature Gates (`services/analytics/growthbook.ts`)
- `getDynamicConfig_BLOCKS_ON_INIT()` — load feature flags during startup
- `checkStatsigFeatureGate_CACHED_MAY_BE_STALE()` — check before each new turn
- Feature branching: model selection, tool availability, behavior toggles
- Cached with staleness tolerance

### Settings Validation
- Schema validation of config entries
- Permission rule parsing
- MDM/policy enforcement
- Deprecation warnings

### Key Pattern
Config is not a one-time read. It's a reactive stream that flows through the runtime. Changes to config produce state changes, and state changes trigger side effects through the observer pattern (track 06).

## Current DigitalMe Agent Situation

- Creator config is Zod-validated YAML loaded at session creation
- No hot-reload — config changes require new session or restart
- No feature gates for gradual rollout
- No config versioning — can't track which config version produced which behavior
- No platform-level config overrides
- No config change events

If a creator updates their agent personality or boundaries, the change only takes effect for new sessions. Active sessions continue with stale config.

## What To Borrow

### 1. Creator Config Versioning

Every config should carry a version so the runtime knows when it changed:

```typescript
interface VersionedCreatorConfig {
  /** Content hash of the config */
  version: string;
  /** When this version was loaded */
  loadedAt: number;
  /** The actual config */
  config: CreatorConfig;
}
```

On each new turn request:
- Platform sends current config version (or the full config) with the request
- Agent compares against cached version
- If different: reload config, update session prompt, log config change event

```typescript
function shouldReloadConfig(
  cached: VersionedCreatorConfig,
  incoming: { version: string },
): boolean {
  return cached.version !== incoming.version;
}
```

### 2. Config Hot-Reload for Active Sessions

When config changes mid-conversation:

```typescript
interface ConfigChangeEffect {
  /** Fields that changed */
  changedFields: string[];
  /** Whether system prompt needs rebuild */
  requiresPromptRebuild: boolean;
  /** Whether guardrails need re-evaluation */
  requiresGuardrailReload: boolean;
  /** Whether model routing needs update */
  requiresModelRouteUpdate: boolean;
}

function applyConfigChange(
  session: SessionRuntime,
  oldConfig: CreatorConfig,
  newConfig: CreatorConfig,
): ConfigChangeEffect {
  const changes = diffConfig(oldConfig, newConfig);

  if (changes.includes('personality') || changes.includes('system_prompt')) {
    session.rebuildSystemPrompt(newConfig);
  }
  if (changes.includes('guardrails')) {
    session.reloadGuardrails(newConfig.guardrails);
  }
  if (changes.includes('models')) {
    session.updateModelRouting(newConfig.models);
  }

  return { changedFields: changes, ... };
}
```

### 3. Platform-Level Config Overrides

The platform should be able to inject runtime overrides that take precedence over creator config:

```typescript
interface PlatformOverrides {
  /** Force-disable specific tools across all creators */
  disabledTools?: string[];
  /** Force model downgrade (e.g., during incident) */
  forceModel?: string;
  /** Force rate limit (e.g., during capacity crunch) */
  maxTurnsPerMinute?: number;
  /** Force guardrails (e.g., regulatory compliance) */
  requiredGuardrails?: GuardrailRule[];
}
```

Priority: Platform overrides > Creator config > Defaults

### 4. Feature Gates for Gradual Rollout

Simple feature gate system for rolling out new agent capabilities:

```typescript
interface FeatureGate {
  name: string;
  enabled: boolean;
  /** Percentage of creators this is enabled for (0-100) */
  rolloutPercent?: number;
  /** Specific creator IDs to enable for */
  allowlist?: string[];
}

// Usage in code:
if (featureGates.isEnabled('session_memory_v2', creatorId)) {
  // Use new memory extraction
} else {
  // Use existing behavior
}
```

Implementation options:
- **Simple**: JSON file of gates, checked at startup and per-request
- **Medium**: Platform sends gates with each request
- **Advanced**: Remote config service (not needed yet)

### 5. Config Validation Lifecycle

Validate config at multiple points:

```typescript
// At load time: full schema validation
const validated = creatorConfigSchema.safeParse(raw);

// At runtime: warn on deprecated fields
function checkDeprecations(config: CreatorConfig): Deprecation[] {
  // e.g., 'model' field deprecated in favor of 'models.primary'
}

// At change time: validate the diff is safe
function validateConfigChange(
  oldConfig: CreatorConfig,
  newConfig: CreatorConfig,
): ValidationResult {
  // Check for dangerous transitions:
  // - Model downgrade that might break conversation
  // - Guardrail removal mid-conversation
  // - Boundary change that contradicts recent responses
}
```

### 6. Config Change Audit Trail

Record config changes for debugging and compliance:

```typescript
interface ConfigChangeEvent {
  timestamp: number;
  conversationId: string;
  creatorId: string;
  previousVersion: string;
  newVersion: string;
  changedFields: string[];
  source: 'creator_update' | 'platform_override' | 'feature_gate';
}
```

Integrates with track 05 (Transcripts) and track 07 (Internal Events).

## What NOT To Borrow

- **File system watchers** — agent loads config from platform, not local files
- **CLI flag overrides** — no CLI interface for the agent service
- **MDM/SAML policy enforcement** — platform concern, not agent concern
- **Statsig/GrowthBook integration** — too heavy; simple gate file or request-header gates are sufficient
- **Skill directory watchers** — no local skill discovery needed

## Implementation

### Step 1: Versioned Config

- Add version field (content hash) to `CreatorConfig`
- Platform sends config version with each `/v1/task` request
- Agent compares and reloads when version changes

Files:
- `src/config/versioning.ts` — version computation, comparison
- `src/config/schema.ts` — extend schema

### Step 2: Config Diff and Hot-Reload

- Add `src/config/ConfigDiffer.ts` — detect which fields changed
- Add `src/config/ConfigReloader.ts` — apply changes to active session
- Integrate into `SessionRuntime.ts` — check config version on each turn

### Step 3: Platform Overrides

- Add `src/config/PlatformOverrides.ts` — merge platform overrides with creator config
- Accept overrides in `/v1/task` request body
- Override priority chain: platform > creator > defaults

### Step 4: Feature Gates

- Add `src/config/FeatureGates.ts` — simple gate evaluation
- Gate definitions from config file or request headers
- Creator-specific gate evaluation (allowlist + percentage rollout)

### Step 5: Config Audit Trail

- Emit config change events to track 07 internal event bus
- Record in track 05 transcript
- Include config version in every turn record

## Config Schema Extension

```yaml
# These fields are managed by the platform, not creator-facing
_platform:
  config_version: "sha256:abc123..."
  overrides:
    disabled_tools: []
    force_model: null
  feature_gates:
    session_memory_v2: true
    effort_routing: false
```

## Dependencies

- Track 07 (Events) — config change events
- Track 05 (Transcripts) — config version in turn records
- Track 09 (Model Routing) — model changes from config
- Track 10 (Guardrails) — guardrail changes from config

## Success Criteria

- Creator config changes take effect within the next turn (not requiring new session)
- Config version is tracked and auditable
- Platform can override creator config for safety/operational reasons
- Feature gates enable gradual rollout of new capabilities
- Config changes are logged in internal events
- No config change causes a crash — validation catches invalid transitions
