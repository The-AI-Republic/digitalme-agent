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
 * Precedence (highest wins):
 *   1. creatorSystemPromptOverride — replaces everything, append is ignored
 *   2. Normal section assembly from PROMPT_SECTIONS
 *   3. creatorSystemPromptAppend — appended as final section (only when no override)
 */
export class SystemPromptBuilder implements ISystemPromptBuilder {
  constructor(private readonly templateLoader: TemplateLoader) {}

  build(context: PromptContext): BuiltPrompt {
    if (context.creatorSystemPromptOverride) {
      return this.buildOverride(context.creatorSystemPromptOverride);
    }

    const sections: BuiltPromptSection[] = [];

    for (const def of PROMPT_SECTIONS) {
      if (def.enabledWhen && !def.enabledWhen(context)) {
        continue;
      }

      const vars = def.buildTemplateVars(context);
      let content: string;

      if (def.template) {
        const raw = this.templateLoader.get(def.template);
        content = this.templateLoader.renderTemplate(raw, vars);
      } else {
        // Code-rendered section (not used in first cut but supported)
        content = '';
      }

      sections.push({
        name: def.name,
        template: def.template ?? undefined,
        content,
        cachePolicy: def.cachePolicy,
        boundary: def.boundary,
      });
    }

    if (context.creatorSystemPromptAppend) {
      sections.push({
        name: 'creator_append',
        content: context.creatorSystemPromptAppend,
        cachePolicy: 'volatile',
        boundary: 'dynamic',
      });
    }

    return this.deriveViews(sections);
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
    const finalSystemPrompt = [...staticPrefix, ...dynamicTail];

    return { sections, staticPrefix, dynamicTail, finalSystemPrompt };
  }
}
