import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanSkillDir } from './SkillScanner.js';
import { SkillRegistry } from './SkillRegistry.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'digitalme-skills-'));
}

function writeSkill(root: string, name: string, skillBody: string, extraFiles: Record<string, string> = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillBody);
  for (const [fileName, contents] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, fileName), contents);
  }
}

test('scanSkillDir returns empty array for missing directory', () => {
  assert.deepEqual(scanSkillDir('/definitely/missing/skills', 'bundled'), []);
});

test('scanSkillDir loads SKILL.md and supporting markdown context', () => {
  const root = makeTempDir();
  try {
    writeSkill(
      root,
      'beat-catalog',
      `---
description: Search my beats
when_to_use: When fan asks about beats or pricing
---

This prompt body is definitely long enough.`,
      { 'pricing.md': 'Lease pricing details' },
    );

    const skills = scanSkillDir(root, 'bundled');
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, 'beat-catalog');
    assert.deepEqual(skills[0]?.supporting_context, ['Lease pricing details']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SkillRegistry lets local skills override bundled skills and warns', () => {
  const bundled = makeTempDir();
  const local = makeTempDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  try {
    writeSkill(
      bundled,
      'beat-catalog',
      `---
description: Bundled description
when_to_use: When fan asks about beats or pricing
---

This bundled prompt body is definitely long enough.`,
    );
    writeSkill(
      local,
      'beat-catalog',
      `---
description: Local description
when_to_use: When fan asks about beats or pricing
---

This local prompt body is definitely long enough.`,
    );

    const registry = new SkillRegistry();
    registry.load(bundled, local);

    assert.equal(registry.get('beat-catalog')?.description, 'Local description');
    assert.ok(warnings.some((warning) => warning.includes('Local skill overrides bundled skill')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(bundled, { recursive: true, force: true });
    fs.rmSync(local, { recursive: true, force: true });
  }
});

test('scanSkillDir skips oversized supporting markdown files', () => {
  const root = makeTempDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  try {
    writeSkill(
      root,
      'beat-catalog',
      `---
description: Search my beats
when_to_use: When fan asks about beats or pricing
---

This prompt body is definitely long enough.`,
      { 'huge.md': 'x'.repeat(50_001) },
    );

    const skills = scanSkillDir(root, 'bundled');
    assert.equal(skills.length, 0);
    assert.ok(warnings.some((warning) => warning.includes('exceeds 50000 bytes')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanSkillDir skips skills with symlinked SKILL.md files', () => {
  const root = makeTempDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  try {
    const skillDir = path.join(root, 'beat-catalog');
    const linkedFile = path.join(root, 'outside.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      linkedFile,
      `---
description: Search my beats
when_to_use: When fan asks about beats or pricing
---

This prompt body is definitely long enough.`,
    );
    fs.symlinkSync(linkedFile, path.join(skillDir, 'SKILL.md'));

    const skills = scanSkillDir(root, 'local');
    assert.equal(skills.length, 0);
    assert.ok(warnings.some((warning) => warning.includes('SKILL.md cannot be a symbolic link')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanSkillDir skips skills with symlinked supporting markdown files', () => {
  const root = makeTempDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  try {
    const skillDir = path.join(root, 'beat-catalog');
    const linkedFile = path.join(root, 'outside.md');
    writeSkill(
      root,
      'beat-catalog',
      `---
description: Search my beats
when_to_use: When fan asks about beats or pricing
---

This prompt body is definitely long enough.`,
    );
    fs.writeFileSync(linkedFile, 'Lease pricing details');
    fs.symlinkSync(linkedFile, path.join(skillDir, 'pricing.md'));

    const skills = scanSkillDir(root, 'local');
    assert.equal(skills.length, 0);
    assert.ok(warnings.some((warning) => warning.includes('pricing.md cannot be a symbolic link')));
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
