import type { LoadedSkill } from './types.js';
import { SKILL_LIMITS } from './types.js';
import { scanSkillDir } from './SkillScanner.js';

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>();

  load(bundledDir: string, localDir: string): void {
    this.skills.clear();

    const bundled = scanSkillDir(bundledDir, 'bundled');
    const local = scanSkillDir(localDir, 'local');

    for (const skill of bundled) {
      this.skills.set(skill.name, skill);
    }
    for (const skill of local) {
      const existing = this.skills.get(skill.name);
      if (existing?.source === 'bundled') {
        console.warn(`Local skill overrides bundled skill: ${skill.name} (${existing.source_dir} -> ${skill.source_dir})`);
      }
      this.skills.set(skill.name, skill);
    }

    if (this.skills.size > SKILL_LIMITS.maxSkillsTotal) {
      throw new Error(`Loaded ${this.skills.size} skills, exceeding max of ${SKILL_LIMITS.maxSkillsTotal}`);
    }
  }

  list(): LoadedSkill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  get size(): number {
    return this.skills.size;
  }
}
