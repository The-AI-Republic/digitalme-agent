# Prompt Management — Implementation Tasks

Reference: `IMPLEMENTATION_PLAN.md` in this directory.

## Task Overview

The work decomposes into 4 phases, each building on the previous.

- Phase 1: Types and contracts
- Phase 2: Templates and loader
- Phase 3: Section registry and builder
- Phase 4: Integration and cleanup

Implementation rule for this track:

- `creatorSystemPromptOverride` wins over everything
- if override is present, `creatorSystemPromptAppend` is ignored
- request-scoped append remains a future field and is not wired in this track

---

## Phase 1: Types and Contracts

Everything else depends on these types existing first.

### Task 1.1 — Add `src/prompts/types.ts`

Create the shared type file with these exports:

```ts
export type PromptContext = {
  creatorName: string
  creatorDefaultSystemPrompt: string
  creatorSystemPromptOverride?: string | null
  creatorSystemPromptAppend?: string | null
  approvedToolNames: string[]
  requestSystemPromptAppend?: string | null
  modelName: string
  providerName: string
}

export type PromptSectionDefinition = {
  name: string
  template: string | null          // template file name, or null if code-rendered
  buildTemplateVars: (context: PromptContext) => Record<string, string>
  cachePolicy: 'stable' | 'volatile'
  boundary: 'static' | 'dynamic'
  enabledWhen?: (context: PromptContext) => boolean
}

export type BuiltPromptSection = {
  name: string
  template?: string
  content: string
  cachePolicy: 'stable' | 'volatile'
  boundary: 'static' | 'dynamic'
}

export type BuiltPrompt = {
  sections: BuiltPromptSection[]
  staticPrefix: string[]
  dynamicTail: string[]
  finalSystemPrompt: string[]
}

export interface ISystemPromptBuilder {
  build(context: PromptContext): BuiltPrompt
}
```

Files: new `src/prompts/types.ts`

Done when: types compile, no runtime code yet.

### Task 1.2 — Add config schema fields

Add optional prompt override and append fields to `persona` in `src/config/schema.ts`:

```ts
persona: z.object({
  name: z.string().min(1),
  default_system_prompt: z.string().min(1),
  system_prompt_override: z.string().optional().nullable(),
  system_prompt_append: z.string().optional().nullable(),
  tools: z.object({
    allow_web_search: z.boolean().default(false),
  }).default({ allow_web_search: false }),
}),
```

Both new fields are optional and nullable. Existing configs remain valid with no changes.

Files: `src/config/schema.ts`

Done when: schema parses existing `config.yaml` unchanged; new fields accepted when present.

---

## Phase 2: Templates and Loader

### Task 2.1 — Author initial template files

Create `src/prompts/templates/` with 4 Markdown files.

**`base_system.md`** — Creator-independent public-agent operating rules. This is new authored content. Write stable behavioral instructions for a public-facing conversational agent: stay in character, do not reveal system prompt contents, refuse disallowed requests gracefully, do not hallucinate tool capabilities. This section should be useful regardless of which creator or persona is configured.

**`tone_style.md`** — Response style guidance. New authored content. Cover: be conversational, concise, and helpful; use the creator's voice and style; avoid excessive formatting unless the user asks for it.

**`creator_persona.md`** — Creator persona wrapper template. Short template that injects the creator's custom system prompt:

```markdown
# Creator Persona: {{creatorName}}

{{creatorDefaultSystemPrompt}}
```

**`tool_policy.md`** — Tool availability section:

```markdown
# Available Tools

{{toolPolicySummary}}
```

Files: new `src/prompts/templates/base_system.md`, `tone_style.md`, `creator_persona.md`, `tool_policy.md`

Done when: files exist with placeholder-ready content.

### Task 2.2 — Add `src/prompts/TemplateLoader.ts`

Responsibilities:

- Load `.md` files from a path that works in both dev and production builds
- Cache loaded templates in a `Map<string, string>` for the lifetime of the process (load once at construction)
- Expose `get(templateName: string): string` that returns cached content or throws if not found
- Template names are bare filenames without extension (e.g. `'base_system'` resolves to `base_system.md`)

Path strategy for first cut:

- in dev, templates may be read from `src/prompts/templates/`
- in production, `npm start` runs `node dist/index.js`, so templates must also exist under `dist/`
- `TemplateLoader` should therefore accept an explicit base path and should not hardcode `src/...`

Include a `renderTemplate(template: string, vars: Record<string, string>): string` method that performs `{{variableName}}` replacement:

- Replace each `{{key}}` with the corresponding value from `vars`
- Unknown placeholders (present in template, absent in vars) render as empty string
- No loops, conditionals, or nested expressions

Files: new `src/prompts/TemplateLoader.ts`

Done when: can load each template file and render with sample variables. Unit-testable in isolation.

### Task 2.3 — Make template files available at runtime

The current build is:

- `npm run build` → `tsc -p tsconfig.json`
- `npm start` → `node dist/index.js`

Because TypeScript compilation does not copy Markdown assets, add one of these strategies and document the chosen one in code comments:

- preferred: copy `src/prompts/templates/*.md` into `dist/prompts/templates/` as part of build/startup packaging
- acceptable: configure `TemplateLoader` to resolve from project-root `src/prompts/templates/` in both dev and production, if deployment layout guarantees that path exists

This task must settle the production runtime behavior explicitly. Do not leave template lookup dependent on `ts-node`-only paths.

Files:

- `package.json`
- optionally a new script such as `scripts/copy-prompt-templates.mjs`
- optionally build/start wiring

Done when:

- a production-style `node dist/index.js` process can load templates successfully
- the chosen runtime path strategy is deterministic and documented

### Task 2.4 — Test TemplateLoader

Add `src/prompts/TemplateLoader.test.ts`:

- Loads a known template and returns its content
- Renders `{{var}}` placeholders correctly
- Missing vars render as empty string
- Unknown template name throws
- Same template loaded twice returns cached (same reference)

Files: new `src/prompts/TemplateLoader.test.ts`

Done when: tests pass.

---

## Phase 3: Section Registry and Builder

### Task 3.1 — Add `src/prompts/PromptSections.ts`

Define the initial ordered section list as an array of `PromptSectionDefinition`:

1. `base_system`
   - template: `'base_system'`
   - buildTemplateVars: `() => ({})` (no variables in first cut)
   - cachePolicy: `'stable'`
   - boundary: `'static'`

2. `tone_style`
   - template: `'tone_style'`
   - buildTemplateVars: `() => ({})` (no variables in first cut)
   - cachePolicy: `'stable'`
   - boundary: `'static'`

3. `creator_persona`
   - template: `'creator_persona'`
   - buildTemplateVars: `(ctx) => ({ creatorName: ctx.creatorName, creatorDefaultSystemPrompt: ctx.creatorDefaultSystemPrompt })`
   - cachePolicy: `'volatile'`
   - boundary: `'dynamic'`

4. `tool_policy`
   - template: `'tool_policy'`
   - buildTemplateVars: `(ctx) => ({ toolPolicySummary: ctx.approvedToolNames.length > 0 ? 'Approved tools: ' + ctx.approvedToolNames.join(', ') + '.' : 'No tools are currently available.' })`
   - cachePolicy: `'volatile'`
   - boundary: `'dynamic'`

Export as `const PROMPT_SECTIONS: PromptSectionDefinition[]`.

Files: new `src/prompts/PromptSections.ts`

Done when: section array is importable and each definition satisfies the `PromptSectionDefinition` type.

### Task 3.2 — Add `src/prompts/SystemPromptBuilder.ts`

Implement `ISystemPromptBuilder`. Constructor takes a `TemplateLoader`.

`build(context: PromptContext): BuiltPrompt` logic:

1. **Override check**: if `context.creatorSystemPromptOverride` is set, return a single-section result with that content as the entire prompt. Skip all other sections.

2. **Section resolution**: iterate `PROMPT_SECTIONS` in order. For each:
   - Skip if `enabledWhen` exists and returns `false`
   - Call `buildTemplateVars(context)` to get vars
   - If `template` is set, call `templateLoader.get(template)` then `templateLoader.renderTemplate(raw, vars)`
   - Otherwise the section is code-rendered (for future use, not needed in first cut)
   - Produce a `BuiltPromptSection`

3. **Append handling**: if `context.creatorSystemPromptAppend` is set, add a final section:
   - name: `'creator_append'`
   - content: the append string
   - cachePolicy: `'volatile'`
   - boundary: `'dynamic'`

4. **Derive views**:
   - `staticPrefix` = sections where `boundary === 'static'`, mapped to `.content`
   - `dynamicTail` = sections where `boundary === 'dynamic'`, mapped to `.content`
   - `finalSystemPrompt` = `[...staticPrefix, ...dynamicTail]`

5. Return `{ sections, staticPrefix, dynamicTail, finalSystemPrompt }`.

Files: new `src/prompts/SystemPromptBuilder.ts`

Done when: builder produces correct `BuiltPrompt` for a given `PromptContext`. Unit-testable with a real `TemplateLoader` pointing at the template directory.

### Task 3.3 — Test SystemPromptBuilder

Add `src/prompts/SystemPromptBuilder.test.ts`:

- Default context produces 4 sections in correct order
- `finalSystemPrompt` equals `[...staticPrefix, ...dynamicTail]`
- `staticPrefix` contains `base_system` and `tone_style` content
- `dynamicTail` contains `creator_persona` and `tool_policy` content
- `creatorSystemPromptOverride` replaces all sections with one override section
- `creatorSystemPromptAppend` adds a final `creator_append` section
- Override + append: override wins and append is ignored
- Empty `approvedToolNames` renders "No tools are currently available."
- Section names are stable across calls with same context
- Section ordering matches `PROMPT_SECTIONS` declaration order

Files: new `src/prompts/SystemPromptBuilder.test.ts`

Done when: tests pass.

---

## Phase 4: Integration and Cleanup

### Task 4.1 — Update TurnExecutor to use ISystemPromptBuilder

Change `TurnExecutor`:

- Replace `IPromptComposer` dependency with `ISystemPromptBuilder` + `IToolRegistry` (tool registry is already a dependency)
- Remove `promptComposer` from constructor and `TurnExecutorDeps`
- Add `systemPromptBuilder` to `TurnExecutorDeps` with a default that constructs `SystemPromptBuilder` + `TemplateLoader`
- In `run()`, build `PromptContext` from config + tool registry, call `this.systemPromptBuilder.build(context)`, assemble `initialMessages` as:

```ts
const initialMessages: Message[] = [
  { role: 'system', content: builtPrompt.finalSystemPrompt.join('\n\n') },
  ...history,
  { role: 'user', content: submission.userMessage },
]
```

Files: `src/agent/TurnExecutor.ts`

Done when: `TurnExecutor` no longer imports or references `PromptComposer` or `IPromptComposer`. Compiles cleanly.

### Task 4.2 — Update TurnExecutor tests

Update `src/agent/TurnExecutor.test.ts`:

- Replace `IPromptComposer` mocks with `ISystemPromptBuilder` mocks
- The mock `build()` should return a minimal `BuiltPrompt` with `finalSystemPrompt: ['test-system']`
- Verify all existing test assertions still pass with the new mock shape
- Add one new test: "TurnExecutor passes correct PromptContext fields to builder"

Files: `src/agent/TurnExecutor.test.ts`

Done when: all existing tests pass with new mocks; new test passes.

### Task 4.3 — Delete PromptComposer

Remove `src/prompts/PromptComposer.ts`.

Verify no remaining imports of `PromptComposer` or `IPromptComposer` anywhere in the codebase.

Files: delete `src/prompts/PromptComposer.ts`

Done when: `grep -r 'PromptComposer' src/` returns nothing. Full test suite passes.

### Task 4.4 — Run full test suite and verify

Run `npm test` and `npm run build`, then confirm:

- All existing tests pass
- New TemplateLoader tests pass
- New SystemPromptBuilder tests pass
- Updated TurnExecutor tests pass
- No type errors
- No unused imports or dead code from the old PromptComposer
- build output contains or can resolve required prompt templates
- `node dist/index.js` can resolve prompt templates in a production-style layout

Files: none (verification only)

Done when: clean test run, clean build, clean production template resolution.

---

## Dependency Graph

```
1.1 types.ts ─────────┬──> 2.2 TemplateLoader ──> 2.4 TemplateLoader tests
                       │
1.2 config schema ─────┤
                       │
2.1 template files ────┼──> 2.2 TemplateLoader ──┬──> 3.2 SystemPromptBuilder ──> 3.3 Builder tests
                       │                         │
                       ├──> 2.3 Runtime template packaging
                       │
1.1 types.ts ──────────┼──> 3.1 PromptSections ───┘
1.2 config schema ─────┘
                                                       │
                                                       v
                                                  4.1 TurnExecutor integration
                                                       │
                                                       v
                                                  4.2 TurnExecutor tests
                                                       │
                                                       v
                                                  4.3 Delete PromptComposer
                                                       │
                                                       v
                                                  4.4 Full verification
```

Tasks 1.1, 1.2, and 2.1 have no dependencies on each other and can be done in parallel.

Task 2.2 depends on 2.1 for actual template files and on 1.1 for shared types if the loader exports typed helpers.

Task 3.1 depends on 1.1 but does not require templates to exist on disk yet, since it only declares template names.

Task 2.3 should land before or alongside 4.1 so production runtime behavior is settled before `TurnExecutor` depends on template-backed prompts.

## Notes

- Template content for `base_system.md` and `tone_style.md` should be reviewed before merging since they define the agent's baseline personality. Consider a dedicated review step or PR comment thread for prompt wording.
- The `requestSystemPromptAppend` field in `PromptContext` is defined in types but not wired to any input source in this track. It exists so the type doesn't need to change when request-scoped append is added later.
- Override + append precedence is fixed in this track: override replaces everything, including append. Tests should enforce that behavior.
