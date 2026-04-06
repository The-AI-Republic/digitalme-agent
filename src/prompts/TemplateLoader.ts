import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads Markdown prompt templates from a directory and caches them for the
 * lifetime of the process. Templates are loaded eagerly at construction time.
 *
 * Template variable syntax: {{variableName}} — simple string replacement,
 * no loops, conditionals, or nested expressions.
 */
export class TemplateLoader {
  private readonly cache = new Map<string, string>();

  /**
   * @param basePath Absolute path to the templates directory.
   *                 Must work in both dev (src/) and production (dist/) layouts.
   */
  constructor(basePath: string) {
    const files = readdirSync(basePath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      const content = readFileSync(join(basePath, file), 'utf-8');
      this.cache.set(name, content);
    }
  }

  get(templateName: string): string {
    const content = this.cache.get(templateName);
    if (content === undefined) {
      throw new Error(`Unknown prompt template: ${templateName}`);
    }
    return content;
  }

  renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
  }
}
