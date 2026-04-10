# 09 — Model Routing and Intelligence Tasks

## Step 1: Model Spec and Roles (types only)

- [ ] Define `ModelSpec`, `ModelRoles`, `ModelCapabilities` types in `src/models/types.ts`
- [ ] Define `ExecutionContext` type (`main_conversation`, `memory_extraction`, `forked_agent`, `tool_summary`, `compaction`)
- [ ] Extend creator config schema to support `models.primary`, `models.background`, `models.fallback`
- [ ] Add backward compat: single `model` field maps to `primary` role
- [ ] Add `ModelPricing` type for cost estimation (shared with track 11)

## Step 2: Execution Context Routing

- [ ] Add `src/models/ModelRouter.ts` with `getModelForContext(roles, context)`
- [ ] Add capability checks (vision, thinking, context window)
- [ ] Update `TurnExecutor.ts` to use `ModelRouter` for main conversation
- [ ] Update forked agent creation to request `background` context
- [ ] Update session memory extraction to request `background` context

## Step 3: Fallback State Machine

- [ ] Add `src/models/ModelFallbackTracker.ts`
- [ ] Track consecutive failures per model
- [ ] Implement primary→fallback transition after N failures
- [ ] Implement auto-recovery to primary after cooldown window
- [ ] Integrate with track 04 recovery paths
- [ ] Emit model switch events to track 07 internal event bus

## Step 4: Effort-Level Resolution (optional)

- [ ] Add `src/models/EffortResolver.ts`
- [ ] Implement heuristic effort classification (message length, complexity signals)
- [ ] Wire effort level into model call parameters (maxOutputTokens, temperature)
- [ ] Allow creator config to set effort floor/ceiling
- [ ] Validate effort routing doesn't degrade fan experience
