import type { AgentRole } from "../manifest";
import type { EfficiencyDimensionResult, EfficiencyMetrics, Trajectory } from "../types";

export interface EfficiencyInput {
  /** The agent role whose Trajectory is being scored. */
  role: AgentRole;
  trajectory: Trajectory;
}

/**
 * Efficiency scorer — advisory only, never gates (ADR-0001 Delta A, issue #23).
 *
 * Extracts deterministic metrics from a Trajectory:
 *   - input tokens, output tokens, cache-read tokens
 *   - tool-call count
 *   - wall-clock ms (first→last transcript timestamp, undefined when absent)
 *
 * Verdict is always PASS in v1: no thresholds. Efficiency is meaningful only
 * comparatively (per-issue over time) — the signal for whether an agent-prompt
 * change made behaviour better or worse. Raw metrics are carried on the result
 * for the persistence slice (#25).
 */
export function scoreEfficiency(input: EfficiencyInput): EfficiencyDimensionResult {
  const { role, trajectory } = input;

  const wallClockMs =
    trajectory.firstTimestamp !== undefined &&
    trajectory.lastTimestamp !== undefined
      ? Math.max(
          0,
          new Date(trajectory.lastTimestamp).getTime() -
            new Date(trajectory.firstTimestamp).getTime(),
        )
      : undefined;

  const metrics: EfficiencyMetrics = {
    inputTokens: trajectory.usage.inputTokens,
    outputTokens: trajectory.usage.outputTokens,
    cacheReadTokens: trajectory.usage.cacheReadTokens,
    toolCallCount: trajectory.toolCalls.length,
    wallClockMs,
  };

  return {
    dimension: "efficiency",
    verdict: "PASS",
    gating: false,
    advisory: true,
    role,
    metrics,
    findings: [],
  };
}
