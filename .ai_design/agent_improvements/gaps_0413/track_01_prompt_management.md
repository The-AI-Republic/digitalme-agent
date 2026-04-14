# Gap Analysis: Track 01 -- Prompt Management

## Summary

The implementation is substantially complete with meaningful deviations from the original design doc. The core architecture (section-based prompt building, templates in markdown, TypeScript for mechanics) was implemented as designed. The most significant deviation is renaming `persona`/`creator` terminology to `soul`, and introducing two additional sections (`security`, `skills`) not in the original plan.

---

## Phase 1: Types and Contracts

### Task 1.1 -- `src/prompts/types.ts`

**Status: YES (with deviations)**

All specified types are present: `PromptContext`, `PromptSectionDefinition`, `BuiltPromptSection`, `BuiltPrompt`, and `ISystemPromptBuilder`.

**Deviations:**
- `PromptContext` fields were renamed from `creator*` to `soul*` terminology:
  - `creatorName` -> `soulName`
  - `creatorDefaultSystemPrompt` -> `soulDescription` (semantic change -- now a description, not a full system prompt)
  - `creatorSystemPromptOverride` -> `soulSystemPromptOverride`
  - `creatorSystemPromptAppend` -> `soulSystemPromptAppend`
- Additional soul fields added not in the design: `soulTone`, `soulBoundaries`, `soulKnowledge`, `soulOthers` -- these decompose the monolithic `default_system_prompt` into structured personality facets
- Added `skillListing` field not in the design
- `ISystemPromptBuilder` gained a `clearCache(): void` method not in the design -- reasonable addition for cache invalidation
- `requestSystemPromptAppend` field from the design is **missing** -- the design said to define it in types even though it wouldn't be wired. Minor omission since the design explicitly deferred wiring it.

### Task 1.2 -- Config schema fields

**Status: YES (with deviations)**

**Concern:** The design explicitly said "Existing configs remain valid with no changes." This rename from `persona` to `soul` is a breaking change to existing config files. Any existing `config.yaml` using `persona:` would need to be updated to `soul:`.

---

## Phase 2: Templates and Loader

### Task 2.1 -- Template files

**Status: YES (with additions)**

The four specified template files exist. Two additional templates not in the design were added:
- `security.md` -- comprehensive security policy template (static section)
- `skills.md` -- simple `{{skillListing}}` template (dynamic section)

### Task 2.2 -- `src/prompts/TemplateLoader.ts`

**Status: YES (with significant architectural deviation)**

**Deviation:** Instead of loading `.md` files from disk at runtime, the implementation uses a build-time embedding strategy:
- A script (`scripts/embed-templates.js`) reads all `.md` files and generates `src/prompts/templates.generated.ts`
- `TemplateLoader` reads from the generated `EMBEDDED_TEMPLATES` map instead of the filesystem

This is a **better** solution than what the design specified. It eliminates all runtime filesystem dependencies for templates and simplifies deployment.

### Task 2.4 -- TemplateLoader tests

**Status: YES**

All specified test cases covered.

---

## Phase 3: Section Registry and Builder

### Task 3.1 -- `src/prompts/PromptSections.ts`

**Status: YES (with additions)**

Two sections added beyond the design: `security` and `skills`.

### Task 3.2 -- `src/prompts/SystemPromptBuilder.ts`

**Status: YES**

All specified behaviors implemented. Section-level caching added as a forward-looking optimization.

### Task 3.3 -- SystemPromptBuilder tests

**Status: YES**

All specified test cases covered, plus additional tests beyond design.

---

## Phase 4: Integration and Cleanup

### Task 4.1 -- Update TurnExecutor

**Status: YES**

Additional integration not in design: `systemPromptBlocks` with per-section `cachePolicy` metadata enabling provider-level prompt caching.

### Task 4.3 -- Delete PromptComposer

**Status: PARTIAL**

- `src/prompts/PromptComposer.ts` has been **deleted** -- YES
- No production code imports `PromptComposer` -- YES

**Bug:** `src/prompts/PromptComposer.test.ts` still exists and imports from `./PromptComposer.js`. This orphaned test file will fail at import time since `PromptComposer.ts` no longer exists.

---

## Issues Found

### Bug: Orphaned PromptComposer.test.ts

**Severity: HIGH**

`src/prompts/PromptComposer.test.ts` imports the deleted `PromptComposer` class. This will cause a runtime error when the test runner attempts to load it. The file should be deleted.

### Concern: Breaking config schema change

**Severity: MEDIUM**

The rename from `persona` to `soul` in the config schema is a breaking change not called out in the original implementation plan.

### Concern: Missing `requestSystemPromptAppend` in types

**Severity: LOW**

The field was meant to be defined early for forward compatibility. Can be added when needed.

### Bug: Stale config schema tests still use `persona`

**Severity: MEDIUM**

The runtime schema has moved to `soul`, but `src/config/schema.test.ts` still constructs configs with `persona` and asserts on `result.data.persona...`. This is additional test fallout from the rename and should be updated alongside the orphaned `PromptComposer` test.

---

## Notable Improvements Beyond Design

1. **Build-time template embedding** via `scripts/embed-templates.js` -- eliminates runtime filesystem dependency
2. **Section-level caching** in `SystemPromptBuilder`
3. **Security section** -- comprehensive prompt injection defense
4. **Skills section** -- conditionally enabled for skill listings
5. **Structured soul fields** -- finer-grained creator personality control
6. **System prompt blocks with cache policy** for provider-level prompt caching
