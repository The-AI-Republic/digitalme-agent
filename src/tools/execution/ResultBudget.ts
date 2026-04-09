import type { ToolExecutionRecord } from './types.js';

const TRUNCATION_SUFFIX_BUDGET = 60;
const MINIMAL_PLACEHOLDER = '[result truncated]';

/**
 * Truncate content to fit within maxChars, reserving space for the suffix marker.
 * Returned string is guaranteed to never exceed maxChars.
 */
export function truncateResult(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean; originalChars: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false, originalChars: content.length };
  }

  if (maxChars <= TRUNCATION_SUFFIX_BUDGET) {
    return {
      content: MINIMAL_PLACEHOLDER.slice(0, Math.max(0, maxChars)),
      truncated: true,
      originalChars: content.length,
    };
  }

  const contentBudget = maxChars - TRUNCATION_SUFFIX_BUDGET;
  const cut = content.lastIndexOf('\n', contentBudget);
  const breakpoint = cut > contentBudget * 0.5 ? cut : contentBudget;
  const suffix = `\n[truncated — ${content.length - breakpoint} chars omitted]`;

  const output = content.slice(0, breakpoint) + suffix;
  return {
    content: output.length <= maxChars ? output : output.slice(0, maxChars),
    truncated: true,
    originalChars: content.length,
  };
}

/**
 * Tracks cumulative rendered result size within a single request.
 * Operates on modelContent (the rendered string that enters prompt history),
 * NOT on structured result data.
 */
export class ResultBudget {
  private consumed = 0;

  constructor(private readonly maxTotalChars: number = 80_000) {}

  /**
   * Serial path: truncate modelContent against per-tool limit and aggregate,
   * then consume.
   */
  truncateAndConsume(
    modelContent: string,
    perToolMax: number,
  ): { content: string; truncated: boolean; originalChars: number } {
    const limit = Math.min(perToolMax, this.remaining);
    const result = truncateResult(modelContent, limit);
    this.consumed += result.content.length;
    return result;
  }

  /**
   * Concurrent path: called AFTER all tools in a batch complete.
   * Per-tool maxResultChars are already applied. This enforces the aggregate
   * cap by truncating the largest modelContent strings first.
   */
  normalizeBatch(records: ToolExecutionRecord[]): void {
    let total = records.reduce((sum, r) => sum + r.modelContent.length, 0);

    while (total + this.consumed > this.maxTotalChars) {
      const largest = records.reduce((max, r) =>
        r.modelContent.length > max.modelContent.length ? r : max,
      );
      if (largest.modelContent.length === 0) break; // nothing left to truncate
      const overshoot = total + this.consumed - this.maxTotalChars;
      const allowed = Math.max(0, largest.modelContent.length - overshoot);
      const truncated = truncateResult(largest.modelContent, allowed);
      total -= largest.modelContent.length - truncated.content.length;
      largest.modelContent = truncated.content;
      largest.result = { ...largest.result, truncated: true };
    }

    this.consumed += total;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotalChars - this.consumed);
  }
}
