/**
 * Tracks skill execution metrics and emits events for observability.
 *
 * Collects per-invocation records for monitoring, quota attribution,
 * and analytics. Records are kept in memory for the process lifecycle.
 */

import type { SkillExecutionRecord } from './types.js';

export type SkillEventListener = (record: SkillExecutionRecord) => void;

export class SkillTracker {
  private readonly records: SkillExecutionRecord[] = [];
  private readonly listeners: SkillEventListener[] = [];

  /** Register a listener that receives every skill execution record. */
  onExecution(listener: SkillEventListener): void {
    this.listeners.push(listener);
  }

  /** Record a completed skill execution. */
  record(record: SkillExecutionRecord): void {
    this.records.push(record);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Listener errors must not break tracking
      }
    }
  }

  /** Get all recorded executions. */
  getRecords(): readonly SkillExecutionRecord[] {
    return this.records;
  }

  /** Get records for a specific skill. */
  getRecordsForSkill(skillName: string): SkillExecutionRecord[] {
    return this.records.filter((r) => r.skillName === skillName);
  }

  /** Get aggregate stats across all executions. */
  getStats(): {
    totalExecutions: number;
    successCount: number;
    failureCount: number;
    totalLatencyMs: number;
    avgLatencyMs: number;
    bySkill: Record<string, { count: number; successCount: number; avgLatencyMs: number }>;
  } {
    const bySkill: Record<string, { count: number; successCount: number; totalLatencyMs: number }> = {};
    let successCount = 0;
    let totalLatencyMs = 0;

    for (const r of this.records) {
      if (r.success) successCount++;
      totalLatencyMs += r.latencyMs;

      const entry = bySkill[r.skillName] ??= { count: 0, successCount: 0, totalLatencyMs: 0 };
      entry.count++;
      if (r.success) entry.successCount++;
      entry.totalLatencyMs += r.latencyMs;
    }

    const total = this.records.length;
    const bySkillResult: Record<string, { count: number; successCount: number; avgLatencyMs: number }> = {};
    for (const [name, entry] of Object.entries(bySkill)) {
      bySkillResult[name] = {
        count: entry.count,
        successCount: entry.successCount,
        avgLatencyMs: entry.count > 0 ? entry.totalLatencyMs / entry.count : 0,
      };
    }

    return {
      totalExecutions: total,
      successCount,
      failureCount: total - successCount,
      totalLatencyMs,
      avgLatencyMs: total > 0 ? totalLatencyMs / total : 0,
      bySkill: bySkillResult,
    };
  }
}
