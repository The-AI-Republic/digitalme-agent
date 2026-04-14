import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile, toLoadedSkill } from './SkillParser.js';
import { validateSkill } from './SkillValidator.js';
import type { LoadedSkill } from './types.js';
import { SKILL_LIMITS } from './types.js';

function readSupportingContext(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md')
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, SKILL_LIMITS.maxSupportingFiles);

  const supporting: string[] = [];
  for (const entry of markdownFiles) {
    const filePath = path.join(dirPath, entry.name);
    const stat = fs.statSync(filePath);
    if (stat.size > SKILL_LIMITS.maxSupportingFileBytes) {
      throw new Error(`${entry.name} exceeds ${SKILL_LIMITS.maxSupportingFileBytes} bytes`);
    }
    supporting.push(fs.readFileSync(filePath, 'utf8').trim());
  }

  return supporting.filter(Boolean);
}

export function scanSkillDir(
  dirPath: string,
  source: 'bundled' | 'local',
): LoadedSkill[] {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(dirPath, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    try {
      const skillContent = fs.readFileSync(skillFile, 'utf8');
      const parsed = parseSkillFile(skillContent);
      const skill = toLoadedSkill(
        parsed,
        entry.name,
        skillDir,
        source,
        readSupportingContext(skillDir),
      );

      const validation = validateSkill(skill);
      if (!validation.valid) {
        console.warn(`Skipping invalid skill ${skill.name}: ${validation.errors.join(', ')}`);
        continue;
      }

      skills.push(skill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      console.warn(
        `Skipping invalid skill directory ${skillDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return skills;
}
