import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillRegistry } from './SkillRegistry.js';

function withTempSkillDirs(fn: (bundledDir: string, localDir: string) => void) {
  const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-bundled-'));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-local-'));
  try {
    fn(bundledDir, localDir);
  } finally {
    fs.rmSync(bundledDir, { recursive: true, force: true });
    fs.rmSync(localDir, { recursive: true, force: true });
  }
}

function writeSkillFile(dir: string, name: string, content?: Partial<Record<string, string>>) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const prompt = content?.prompt ?? `This is a comprehensive test prompt for the ${name} skill that is long enough to pass validation.`;
  const md = `---
name: ${name}
description: Test skill ${name}
when_to_use: Use this skill when testing the ${name} functionality
allowed-tools:
  - "*"
context: inline
model: inherit
max_turns: 5
timeout_seconds: 30
---

${prompt}`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), md);
}

test('SkillRegistry starts empty', () => {
  const registry = new SkillRegistry();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.list(), []);
});

test('SkillRegistry.get returns undefined for unknown skill', () => {
  const registry = new SkillRegistry();
  assert.equal(registry.get('nonexistent'), undefined);
});

test('load picks up bundled skills', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    writeSkillFile(bundledDir, 'alpha');
    writeSkillFile(bundledDir, 'beta');

    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);

    assert.equal(registry.size, 2);
    assert.ok(registry.get('alpha'));
    assert.ok(registry.get('beta'));
    assert.equal(registry.get('alpha')!.source, 'bundled');
  });
});

test('load picks up local skills', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    writeSkillFile(localDir, 'gamma');

    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);

    assert.equal(registry.size, 1);
    assert.equal(registry.get('gamma')!.source, 'local');
  });
});

test('local skill overrides bundled skill with same name', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    writeSkillFile(bundledDir, 'overlap', { prompt: 'This is the bundled version of the overlap skill with enough length.' });
    writeSkillFile(localDir, 'overlap', { prompt: 'This is the local version of the overlap skill that overrides bundled.' });

    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);

    assert.equal(registry.size, 1);
    const skill = registry.get('overlap')!;
    assert.equal(skill.source, 'local');
    assert.ok(skill.prompt.includes('local version of the overlap'));
  });
});

test('list returns skills sorted alphabetically', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    writeSkillFile(bundledDir, 'charlie');
    writeSkillFile(bundledDir, 'alpha');
    writeSkillFile(bundledDir, 'bravo');

    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);

    const names = registry.list().map((s) => s.name);
    assert.deepEqual(names, ['alpha', 'bravo', 'charlie']);
  });
});

test('load clears previous skills before loading', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    writeSkillFile(bundledDir, 'first');

    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);
    assert.equal(registry.size, 1);

    // Load again with different skills
    const bundledDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-bundled2-'));
    try {
      writeSkillFile(bundledDir2, 'second');
      registry.load(bundledDir2, localDir);

      assert.equal(registry.size, 1);
      assert.ok(registry.get('second'));
      assert.equal(registry.get('first'), undefined);
    } finally {
      fs.rmSync(bundledDir2, { recursive: true, force: true });
    }
  });
});

test('load with empty directories results in empty registry', () => {
  withTempSkillDirs((bundledDir, localDir) => {
    const registry = new SkillRegistry();
    registry.load(bundledDir, localDir);
    assert.equal(registry.size, 0);
  });
});
