import type { LoadedSkill } from './types.js';
import { SKILL_LIMITS } from './types.js';

const MAX_DESC_LENGTH = 200;
const OMITTED_LINE = '- ... additional skills omitted due to prompt budget';

function formatSkillLine(skill: LoadedSkill): string {
  const desc = skill.when_to_use
    ? `${skill.description} - ${skill.when_to_use}`
    : skill.description;
  const truncated = desc.length > MAX_DESC_LENGTH
    ? `${desc.slice(0, MAX_DESC_LENGTH - 3)}...`
    : desc;
  return `- ${skill.name}: ${truncated}`;
}

export function buildSkillListingSection(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const headerLines = [
    'Available skills:',
  ];
  const footerLines = [
    '',
    'Use the CreatorSkill tool to invoke a skill when appropriate.',
    'Pass the skill name and any relevant context from the fan message as args.',
  ];

  const lines: string[] = [];
  let used = headerLines.join('\n').length + footerLines.join('\n').length + 2;

  for (let index = 0; index < skills.length; index += 1) {
    const line = formatSkillLine(skills[index]!);
    const remainingSkills = index < skills.length - 1;
    const omittedCost = remainingSkills ? OMITTED_LINE.length + 1 : 0;

    if (used + line.length + 1 + omittedCost > SKILL_LIMITS.maxListingBudget) {
      if (remainingSkills && used + OMITTED_LINE.length + 1 <= SKILL_LIMITS.maxListingBudget) {
        lines.push(OMITTED_LINE);
      }
      break;
    }

    lines.push(line);
    used += line.length + 1;
  }

  return [...headerLines, ...lines, ...footerLines].join('\n');
}
