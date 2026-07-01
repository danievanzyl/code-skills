import type { Finding, Severity } from "../types";

/** Numeric ordering for severity levels. Lower number = more severe. */
export const severityOrder: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

/** Return the most severe finding's severity, or null if none. */
export function maxSeverity(findings: Finding[]): Severity | null {
  if (findings.length === 0) return null;
  let max: Severity = findings[0].severity;
  for (let i = 1; i < findings.length; i++) {
    if (severityOrder[findings[i].severity] < severityOrder[max]) {
      max = findings[i].severity;
    }
  }
  return max;
}
