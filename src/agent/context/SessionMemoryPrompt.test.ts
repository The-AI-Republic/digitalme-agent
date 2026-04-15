import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_MEMORY_TEMPLATE, buildExtractionPrompt } from './SessionMemoryPrompt.js';

// --- SESSION_MEMORY_TEMPLATE ---

test('SESSION_MEMORY_TEMPLATE contains all required section headers', () => {
  const requiredSections = [
    '# Conversation Title',
    '# Current State',
    '# Fan Profile',
    '# Relationship Context',
    '# Key Facts Exchanged',
    '# Ongoing Topics',
    '# Conversation Flow',
  ];
  for (const section of requiredSections) {
    assert.ok(SESSION_MEMORY_TEMPLATE.includes(section), `Missing section: ${section}`);
  }
});

test('SESSION_MEMORY_TEMPLATE is non-empty markdown', () => {
  assert.ok(SESSION_MEMORY_TEMPLATE.length > 100);
  assert.ok(SESSION_MEMORY_TEMPLATE.startsWith('#'));
});

// --- buildExtractionPrompt ---

test('buildExtractionPrompt includes current notes in the output', () => {
  const notes = '# Conversation Title\nTest conversation';
  const prompt = buildExtractionPrompt(notes);

  assert.ok(prompt.includes(notes));
});

test('buildExtractionPrompt wraps notes in current_notes_content tags', () => {
  const notes = 'Some current notes.';
  const prompt = buildExtractionPrompt(notes);

  assert.ok(prompt.includes('<current_notes_content>'));
  assert.ok(prompt.includes('</current_notes_content>'));
  assert.ok(prompt.includes(notes));
});

test('buildExtractionPrompt includes critical rules section', () => {
  const prompt = buildExtractionPrompt('notes');

  assert.ok(prompt.includes('CRITICAL RULES'));
});

test('buildExtractionPrompt instructs to maintain section structure', () => {
  const prompt = buildExtractionPrompt('notes');

  assert.ok(prompt.includes('maintain the exact structure'));
});

test('buildExtractionPrompt instructs not to reference note-taking process', () => {
  const prompt = buildExtractionPrompt('notes');

  assert.ok(prompt.includes('NOT part of the actual conversation'));
  assert.ok(prompt.includes('Do NOT include any references to "note-taking"'));
});

test('buildExtractionPrompt handles empty notes', () => {
  const prompt = buildExtractionPrompt('');

  assert.ok(prompt.includes('<current_notes_content>'));
  assert.ok(prompt.includes('</current_notes_content>'));
  assert.ok(prompt.length > 100);
});

test('buildExtractionPrompt handles notes with special characters', () => {
  const notes = '# Title\n**Bold** and _italic_ and `code` and <html>';
  const prompt = buildExtractionPrompt(notes);

  assert.ok(prompt.includes(notes));
});
