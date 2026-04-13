import YAML from 'yaml';
import type { LoadedSkill } from './types.js';

export interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillFile(content: string): ParsedSkillFile {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content.trim() };
  }

  const closingIndex = content.indexOf('\n---', 4);
  if (closingIndex === -1) {
    throw new Error('Invalid SKILL.md frontmatter: missing closing ---');
  }

  const frontmatterBlock = content.slice(4, closingIndex);
  const restIndex = closingIndex + '\n---'.length;
  const rest = content.startsWith('\r\n', restIndex)
    ? content.slice(restIndex + 2)
    : content.startsWith('\n', restIndex)
      ? content.slice(restIndex + 1)
      : content.slice(restIndex);

  const parsed = YAML.parse(frontmatterBlock);
  if (parsed !== null && typeof parsed !== 'object') {
    throw new Error('Invalid SKILL.md frontmatter: expected mapping');
  }

  return {
    frontmatter: (parsed ?? {}) as Record<string, unknown>,
    body: rest.trim(),
  };
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function toLoadedSkill(
  parsed: ParsedSkillFile,
  dirName: string,
  sourceDir: string,
  source: 'bundled' | 'local',
): LoadedSkill {
  const frontmatter = parsed.frontmatter;
  const context = getString(frontmatter, 'context');
  const model = getString(frontmatter, 'model');
  const maxTurns = frontmatter['max-turns'];
  const timeoutSeconds = frontmatter['timeout-seconds'];

  return {
    name: getString(frontmatter, 'name') ?? dirName,
    description: getString(frontmatter, 'description') ?? '',
    when_to_use: getString(frontmatter, 'when_to_use') ?? '',
    allowed_tools: getStringArray(frontmatter, 'allowed-tools') ?? [],
    context: context === 'fork' ? 'fork' : 'inline',
    model: model ?? 'inherit',
    max_turns: typeof maxTurns === 'number' ? maxTurns : 3,
    timeout_seconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : 30,
    argument_hint: getString(frontmatter, 'argument-hint'),
    prompt: parsed.body,
    supporting_context: [],
    source_dir: sourceDir,
    source,
  };
}
