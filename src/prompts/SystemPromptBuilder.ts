import type {
  PromptContext,
  BuiltPrompt,
  BuiltPromptSection,
  ISystemPromptBuilder,
} from './types.js';
import { PROMPT_SECTIONS } from './PromptSections.js';
import type { TemplateLoader } from './TemplateLoader.js';

/**
 * Builds the system prompt from section definitions and templates.
 *
 * Sections with cachePolicy 'stable' are computed once and reused across
 * subsequent build() calls until clearCache() is called. Sections with
 * cachePolicy 'volatile' are recomputed on every call.
 *
 * Precedence (highest wins):
 *   1. soulSystemPromptOverride — replaces everything, append is ignored
 *   2. Normal section assembly from PROMPT_SECTIONS
 *   3. soulSystemPromptAppend — appended as final section (only when no override)
 */
export class SystemPromptBuilder implements ISystemPromptBuilder {
  private readonly sectionCache = new Map<string, BuiltPromptSection>();

  constructor(private readonly templateLoader: TemplateLoader) {}

  build(context: PromptContext): BuiltPrompt {
    if (context.soulSystemPromptOverride) {
      return this.buildOverride(context.soulSystemPromptOverride);
    }

    const sections: BuiltPromptSection[] = [];

    for (const def of PROMPT_SECTIONS) {
      if (def.enabledWhen && !def.enabledWhen(context)) {
        continue;
      }

      if (def.cachePolicy === 'stable') {
        const cached = this.sectionCache.get(def.name);
        if (cached) {
          sections.push(cached);
          continue;
        }
      }

      const vars = def.buildTemplateVars(context);
      let content: string;

      if (def.template) {
        const raw = this.templateLoader.get(def.template);
        content = this.templateLoader.renderTemplate(raw, vars);
      } else {
        content = '';
      }

      const section: BuiltPromptSection = {
        name: def.name,
        template: def.template ?? undefined,
        content,
        cachePolicy: def.cachePolicy,
        boundary: def.boundary,
      };

      if (def.cachePolicy === 'stable') {
        this.sectionCache.set(def.name, section);
      }

      sections.push(section);
    }

    if (context.soulSystemPromptAppend) {
      sections.push({
        name: 'soul_append',
        content: context.soulSystemPromptAppend,
        cachePolicy: 'volatile',
        boundary: 'dynamic',
      });
    }

    return this.deriveViews(sections);
  }

  clearCache(): void {
    this.sectionCache.clear();
  }

  private buildOverride(override: string): BuiltPrompt {
    const sections: BuiltPromptSection[] = [
      {
        name: 'override',
        content: override,
        cachePolicy: 'volatile',
        boundary: 'dynamic',
      },
    ];
    return this.deriveViews(sections);
  }

  private deriveViews(sections: BuiltPromptSection[]): BuiltPrompt {
    const staticPrefix = sections
      .filter((s) => s.boundary === 'static')
      .map((s) => s.content);
    const dynamicTail = sections
      .filter((s) => s.boundary === 'dynamic')
      .map((s) => s.content);
    const finalSystemPrompt = sections.map((s) => s.content);

    return { sections, staticPrefix, dynamicTail, finalSystemPrompt };
  }
}
