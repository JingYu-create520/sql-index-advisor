import type { AnalysisResult } from "../rules/engine.js";
import type { Finding, InputNote } from "../core/types.js";
import { ruleCatalogue } from "../rules/registry.js";
import { VERSION } from "../version.js";

export const REPORT_VERSION = 1;

export interface JsonReport {
  reportVersion: number;
  toolVersion: string;
  source: string;
  summary: {
    records: number;
    findings: number;
    bySeverity: { error: number; warn: number; info: number };
  };
  options: AnalysisResult["options"];
  rules: ReturnType<typeof ruleCatalogue>;
  /** Rules that produced nothing because their inputs were missing. */
  skipped: AnalysisResult["skipped"];
  /** What the loader could not see in the input, stated rather than implied. */
  notes: InputNote[];
  errors: string[];
  findings: Finding[];
}

export function buildJsonReport(
  result: AnalysisResult,
  source: string,
  toolVersion = VERSION,
): JsonReport {
  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const finding of result.findings) bySeverity[finding.severity] += 1;

  return {
    reportVersion: REPORT_VERSION,
    toolVersion,
    source,
    summary: {
      records: result.records,
      findings: result.findings.length,
      bySeverity,
    },
    options: result.options,
    rules: ruleCatalogue(),
    skipped: result.skipped,
    notes: result.notes,
    errors: result.errors,
    findings: result.findings,
  };
}

export function renderJson(report: JsonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
