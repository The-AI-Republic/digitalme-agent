import type { PromptSectionDefinition } from './types.js';

/**
 * Ordered list of prompt section definitions. The order here determines
 * the order sections appear in the final system prompt.
 */
export const PROMPT_SECTIONS: PromptSectionDefinition[] = [
  {
    name: 'base_system',
    template: 'base_system',
    buildTemplateVars: () => ({}),
    cachePolicy: 'stable',
    boundary: 'static',
  },
  {
    name: 'security',
    template: 'security',
    buildTemplateVars: () => ({}),
    cachePolicy: 'stable',
    boundary: 'static',
  },
  {
    name: 'tone_style',
    template: 'tone_style',
    buildTemplateVars: () => ({}),
    cachePolicy: 'stable',
    boundary: 'static',
  },
  {
    name: 'creator_persona',
    template: 'creator_persona',
    buildTemplateVars: (ctx) => ({
      creatorName: ctx.creatorName,
      creatorDefaultSystemPrompt: ctx.creatorDefaultSystemPrompt,
    }),
    cachePolicy: 'volatile',
    boundary: 'dynamic',
  },
  {
    name: 'tool_policy',
    template: 'tool_policy',
    buildTemplateVars: (ctx) => ({
      toolPolicySummary:
        ctx.approvedToolNames.length > 0
          ? `Approved tools: ${ctx.approvedToolNames.join(', ')}.`
          : 'No tools are currently available.',
    }),
    cachePolicy: 'volatile',
    boundary: 'dynamic',
  },
];
