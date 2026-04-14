# 12 — Configuration Lifecycle Tasks [deferred]

## Step 1: Versioned Config and Protocol Extension

- [ ] Define `creatorConfigSchema` (Zod) — hot-reloadable subset of `AgentConfig`
- [ ] Define `platformOverridesSchema` (Zod) — disabled_tools, force_model, force_max_turns, appended_boundaries
- [ ] Define `VersionedConfig` type — version hash, loadedAt, config, overrides, effective
- [ ] Add `config_version`, `creator_config`, `platform_overrides` as optional fields to `turnRequestSchema`
- [ ] Add config fields to `TurnSubmission` internal type
- [ ] Create `src/config/versioning.ts` — config cache (Map by version hash), `shouldReloadConfig()` comparison
- [ ] Update `src/routes/turns.ts` — extract new fields from parsed request, pass through to `agent.submit()`
- [ ] Verify backward compat: requests without new fields use startup config unchanged

## Step 2: Config Differ

- [ ] Create `src/config/ConfigDiffer.ts`
- [ ] Define `ConfigDiff` type — `changedFields: string[]`, `actions: ConfigChangeAction[]`
- [ ] Define `ConfigChangeAction` union — `rebuild_prompt`, `update_tool_registry`, `update_model`, `update_limits`, `update_session_memory`, `restart_required`
- [ ] Implement `diffConfig(old, new)` — deep comparison of each section, maps changed fields to actions
- [ ] Classify fields: hot-reloadable vs restart-required (log warning for restart-required changes)
- [ ] Tests: no changes → empty diff; soul change → rebuild_prompt; model.name change → update_model; model.provider change → restart_required; multiple changes → multiple actions

## Step 3: Config Reloader

- [ ] Create `src/config/ConfigReloader.ts` — takes promptBuilder, sessionManager, modelClientFactory, toolRegistry
- [ ] Implement `apply(diff, newConfig)` → `ConfigReloadResult` with applied/deferred/failed lists
- [ ] Add `replaceClient(modelConfig)` to `ModelClientFactory` — create new client, swap singleton reference
- [ ] Add `reload(config)` to `ToolRegistry` — compare current vs desired tools, add/remove as needed
- [ ] Add `updateRuntimeConfig(config)` to `SessionManager` — update runtimeConfig for new sessions only
- [ ] Each action is independent — one failure doesn't block others
- [ ] On partial failure: do NOT cache the new config version (next request retries)
- [ ] Tests: mock each component, verify correct methods called per action type; verify partial failure handling

## Step 4: Config Merge and Override Application

- [ ] Create `src/config/merge.ts`
- [ ] Define `EffectiveConfig` type — full merged config
- [ ] Implement `mergeEffectiveConfig(base, creator, overrides?)` — startup config + creator + platform overrides
- [ ] Platform overrides are restrictive only: disabled_tools removes, force_max_turns caps (doesn't raise), appended_boundaries appends
- [ ] Tests: creator config overrides startup defaults; platform overrides constrain creator config; missing optional sections use startup values

## Step 5: End-to-End Wiring

- [ ] Update `Agent.ts` — before submitting turn: check config_version, diff if changed, apply via ConfigReloader, cache new version
- [ ] Handle first request (no cache): accept creator_config, cache it, apply as initial config
- [ ] Handle invalid creator_config: return 422, continue with previously cached or startup config
- [ ] Handle concurrent requests with config change: first processor applies, second sees updated cache
- [ ] Update `src/routes/health.ts` — add `config_version` and `config_loaded_at` to health response
- [ ] Integration test: sequence of requests with config changes, verify prompt/model/tools update correctly

## Step 6: Feature Gates

- [ ] Create `src/config/FeatureGates.ts` — `FeatureGates` type (record of string→boolean), `isGateEnabled()` helper
- [ ] Parse `X-DigitalMe-Feature-Gates` header in `src/routes/turns.ts` (JSON, fail-safe: malformed header → no gates)
- [ ] Add `featureGates` field to `TurnSubmission`
- [ ] Thread gates through to `TurnExecutor` and `SessionManager` for use in conditional logic
- [ ] Tests: missing header → empty gates; valid header → parsed correctly; malformed header → empty gates (no crash)

## Step 7: Audit Trail and Observability

- [ ] Emit structured `ConfigChangeRecord` JSON log on every config reload — timestamp, previous/new version, changed fields, applied/deferred actions, source, conversationId, requestId
- [ ] Log warning for restart-required field changes — include field names
- [ ] Verify health endpoint reports config_version accurately (startup vs request-driven)
- [ ] Document: when Track 07 event bus is ready, emit config_change as AgentEvent; when Track 05 inline recording is wired, add configVersion to transcript entries
