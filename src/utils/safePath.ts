/**
 * Path safety utilities for filesystem operations.
 *
 * Prevents path traversal attacks when using caller-supplied identifiers
 * (e.g. conversationId) as path components.
 */

import path from 'node:path';

/** Regex for safe identifiers: alphanumeric, hyphens, underscores, max 128 chars. */
const SAFE_ID_PATTERN = /^[\w-]{1,128}$/;

/**
 * Sanitize an identifier for safe use as a filesystem path component.
 *
 * If the value matches the safe pattern (alphanumeric, hyphens, underscores),
 * it is returned unchanged. Otherwise, throws to prevent path traversal.
 */
export function assertSafePathComponent(value: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Unsafe path component: value contains invalid characters or exceeds 128 chars`);
  }
  return value;
}

/**
 * Build a path that is guaranteed to stay within the given base directory.
 * Validates each dynamic component before joining.
 */
export function safePath(baseDir: string, ...components: string[]): string {
  for (const component of components) {
    assertSafePathComponent(component);
  }
  return path.join(baseDir, ...components);
}
