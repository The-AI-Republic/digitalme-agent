# 12 — Configuration Lifecycle Tasks

## Step 1: Versioned Config

- [ ] Add content hash computation for creator config
- [ ] Add `VersionedCreatorConfig` type wrapping config + version + loadedAt
- [ ] Accept config version in `/v1/task` request body
- [ ] Compare incoming version against cached version in session
- [ ] Trigger reload on version mismatch

## Step 2: Config Diff and Hot-Reload

- [ ] Add `src/config/ConfigDiffer.ts` — detect changed fields between config versions
- [ ] Add `src/config/ConfigReloader.ts` — apply changes to active session
- [ ] Map changed fields to required actions (prompt rebuild, guardrail reload, model route update)
- [ ] Integrate into `SessionRuntime.ts` — check config version on each turn
- [ ] Handle edge cases: mid-turn config changes, invalid new config

## Step 3: Platform Overrides

- [ ] Add `src/config/PlatformOverrides.ts`
- [ ] Define `PlatformOverrides` type (disabled tools, force model, required guardrails)
- [ ] Merge logic: platform > creator > defaults
- [ ] Accept overrides in `/v1/task` request body
- [ ] Log override applications

## Step 4: Feature Gates

- [ ] Add `src/config/FeatureGates.ts`
- [ ] Define gate schema (name, enabled, rollout percent, allowlist)
- [ ] Implement gate evaluation with creator-specific targeting
- [ ] Load gates from config file or request headers
- [ ] Add `isEnabled(gateName, creatorId)` function

## Step 5: Config Audit Trail

- [ ] Emit config change events to track 07 internal event bus
- [ ] Record config version in every turn transcript (track 05)
- [ ] Log: previous version, new version, changed fields, source
- [ ] Add deprecation warnings for old config fields
