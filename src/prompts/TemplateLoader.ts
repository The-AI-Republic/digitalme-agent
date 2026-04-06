import { EMBEDDED_TEMPLATES } from './templates.generated.js';

/**
 * Provides access to prompt templates that were embedded at build time.
 *
 * Template variable syntax: {{variableName}} — simple string replacement,
 * no loops, conditionals, or nested expressions.
 */
export class TemplateLoader {
  get(templateName: string): string {
    const content = EMBEDDED_TEMPLATES[templateName];
    if (content === undefined) {
      throw new Error(`Unknown prompt template: ${templateName}`);
    }
    return content;
  }

  renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
  }
}
