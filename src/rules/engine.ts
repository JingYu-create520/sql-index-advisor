/**
 * Rule execution pipeline.
 *
 * Two responsibilities beyond "run every rule":
 *  1. Gate rules on the inputs they need (`needsSchema` / `needsMetrics`) and
 *     report *why* something was skipped, so silence is never mistaken for
 *     "no problems found" (docs/DESIGN-NOTES.md D5).
 *  2. Contain rule bugs. A throwing rule must not take down a CI gate.
 */

import type { Finding, InputNote, QueryRecord, Rule, RuleOptions, Schema } from "../core/types.js";
import { DEFAULT_RULE_OPTIONS, SEVERITY_ORDER } from "../core/types.js";
import { ALL_RULES } from "./registry.js";

export interface SkippedRule {
  id: string;
  reason: string;
  reasonEn: string;
  count: number;
}

/**
 * How much of the run a skip covers.
 *
 * `skipped` used to read as a verdict on the whole run: analysing
 * `WITH c AS (SELECT ...) SELECT ...` gives one record with no table and one with
 * a real access path, and the footer said "not evaluated: SIA001" while SIA001
 * was two lines above it, with a suggestion. A rule skipped on three of five
 * statements is not a rule that stayed silent.
 */
export function skippedFraction(skipped: SkippedRule, total: number): string {
  return total > 0 && skipped.count < total ? `${skipped.count}/${total}` : "";
}

/**
 * The reason plus, when it is not the whole run, how much of the run it covers.
 * Shared so the terminal, the CI annotations and the migration header cannot
 * disagree about what was skipped — they have one job and one wording.
 */
export function skippedCover(
  skipped: SkippedRule,
  total: number,
  lang: "zh" | "en",
  reason: string,
): string {
  if (!skippedFraction(skipped, total)) return reason;
  // No parentheses of its own: the CI annotation and the migration header wrap
  // this text in a pair already, and `SIA001 (reason (on 1 of 2))` is unreadable.
  return lang === "en"
    ? `${reason}, on ${skipped.count} of ${total} statements`
    : `${reason}，${total} 条中的 ${skipped.count} 条`;
}

export interface AnalyzeOptions extends Partial<RuleOptions> {
  schema?: Schema;
  rules?: Rule[];
}

export interface AnalysisResult {
  findings: Finding[];
  records: number;
  /** How many records actually reached the rules. */
  analysed: number;
  skipped: SkippedRule[];
  errors: string[];
  /**
   * What the loader wants said about the input itself: a directory with no
   * mappers, predicates built at runtime, events ignored while parsing. Set by
   * the pipeline, not by `analyze`, and rendered everywhere a report goes: an
   * empty result with a hidden note is how "nothing to report" becomes a lie.
   */
  notes: InputNote[];
  options: RuleOptions;
}

export function analyze(records: QueryRecord[], options: AnalyzeOptions = {}): AnalysisResult {
  const opts: RuleOptions = { ...DEFAULT_RULE_OPTIONS, ...stripUndefined(options) };
  const rules = options.rules ?? ALL_RULES;
  const schema = options.schema;
  const findings: Finding[] = [];
  const errors: string[] = [];
  const skipCounts = new Map<string, { reason: string; reasonEn: string; count: number }>();

  for (const record of records) {
    for (const rule of rules) {
      const missing = missingDependency(rule, record, schema);
      if (missing) {
        const entry = skipCounts.get(rule.id) ?? { ...missing, count: 0 };
        entry.count += 1;
        skipCounts.set(rule.id, entry);
        continue;
      }

      let produced: Finding[];
      try {
        produced = rule.run({ record, schema, options: opts });
      } catch (err) {
        const message = `${rule.id} 在 ${describeRecord(record)} 上执行失败：${(err as Error).message}`;
        if (!errors.includes(message)) errors.push(message);
        continue;
      }

      for (const finding of produced) {
        if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[opts.minSeverity]) continue;
        findings.push(finding);
      }
    }
  }

  return {
    findings: dropRedundantPrefixes(sortFindings(dedup(findings), records)),
    records: records.length,
    analysed: records.length,
    skipped: [...skipCounts.entries()]
      .map(([id, v]) => ({ id, reason: v.reason, reasonEn: v.reasonEn, count: v.count }))
      .sort((a, b) => b.count - a.count),
    errors,
    notes: [],
    options: opts,
  };
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function missingDependency(
  rule: Rule,
  record: QueryRecord,
  schema: Schema | undefined,
): { reason: string; reasonEn: string } | undefined {
  if (rule.needsSchema && !schema) {
    return { reason: "缺少 --schema，现有索引未知", reasonEn: "needs --schema to know existing indexes" };
  }
  if (rule.needsMetrics && record.metrics?.rowsExamined === undefined) {
    return {
      reason: "该输入没有 Rows_examined（仅慢日志提供）",
      reasonEn: "no Rows_examined in this input (slow log only)",
    };
  }
  // A paginating query whose offset arrives as a bind parameter is the one shape
  // SIA006 cannot judge, and in a real project it is the most common one (50
  // statements in one audited repository). Saying nothing about it reads as "your
  // pagination is fine", so the reason is attributed per record instead.
  if (rule.id === "SIA006" && record.parsed.limit && !record.parsed.limit.literal) {
    return {
      reason: "分页偏移量是绑定参数，静态看不到大小",
      reasonEn: "the OFFSET is a bound parameter, so its size is not visible statically",
    };
  }
  if (record.parsed.notes.some((n) => n.includes("解析失败"))) {
    return { reason: "SQL 解析失败", reasonEn: "statement failed to parse" };
  }
  if (record.parsed.notes.some((n) => n.includes("分号"))) {
    return {
      reason: "多条语句混在一起且缺少分号，未分析",
      reasonEn: "several statements arrived merged (no ';' between them); not analysed",
    };
  }
  if (record.parsed.tables.length === 0) {
    return { reason: "没有识别到表名", reasonEn: "no table could be identified" };
  }
  return undefined;
}

function describeRecord(record: QueryRecord): string {
  return record.statementId ?? record.source?.line?.toString() ?? record.fingerprint.slice(0, 40);
}

/**
 * Estimated payoff, deliberately simple and explainable:
 * slow-log cost dominates; without metrics we fall back to row pressure.
 */
export function benefitOf(finding: Finding, record?: QueryRecord): number {
  const time = finding.queryTime ?? record?.metrics?.queryTime ?? 0;
  const rows = finding.rowsExamined ?? record?.maxRowsExamined ?? 0;
  const occurrences = finding.occurrences ?? record?.occurrences ?? 1;
  return time * rows * occurrences + rows / 1e6 + occurrences;
}

function sortFindings(findings: Finding[], records: QueryRecord[]): Finding[] {
  const byFingerprint = new Map(records.map((r) => [r.fingerprint, r]));
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severity !== 0) return severity;
    const gain = benefitOf(b, byFingerprint.get(b.fingerprint)) - benefitOf(a, byFingerprint.get(a.fingerprint));
    if (Math.abs(gain) > 1e-9) return gain > 0 ? 1 : -1;
    return a.rule.localeCompare(b.rule);
  });
}

/**
 * A wider index also serves every query the narrower one could serve, so
 * proposing both is self-inflicted noise: `(sku_id)` adds write cost for zero
 * extra coverage once `(sku_id, warehouse_id)` is on the table. Only applies
 * within the same run and the same table, and the survivor says what it covers.
 */
function dropRedundantPrefixes(findings: Finding[]): Finding[] {
  const candidates = findings.filter((f) => (f.indexColumns?.length ?? 0) > 0);
  const drop = new Set<Finding>();

  /**
   * Two statements that filter the same columns in a different written order need
   * one index, not two. Without this the migration file carried both
   * `(deleted, biz_type, post_owner_user_id, pre_owner_user_id)` and the same set
   * with the last two swapped, because the fingerprints differ and the dedup key
   * includes the fingerprint. Findings arrive benefit-ordered, so keeping the
   * first representative keeps the more expensive query's shape.
   */
  /**
   * Two statements filtering the same columns in a different written order need
   * one index, not two, and the same set can also arrive from two different rules
   * (a missing index and a covering-index opportunity on the same table). Without
   * this the migration file carried both `(deleted, biz_type, post_owner_user_id,
   * pre_owner_user_id)` and the same set with the last two swapped, because the
   * fingerprints differ and the dedup key includes the fingerprint. Findings
   * arrive benefit-ordered, so the first representative keeps its shape.
   *
   * A prefix index is excluded: `KEY (remark)` and `KEY (remark(64))` cover
   * different things, and collapsing them would delete a real option.
   */
  const byColumnSet = new Map<string, Finding>();
  for (const finding of candidates) {
    if (finding.suggestedDDL.some((ddl) => /\(\s*\w+\s*\(\s*\d+\s*\)\s*\)/.test(ddl))) continue;
    const key = [finding.table ?? "", [...finding.indexColumns!].sort().join(",")].join("::");
    const kept = byColumnSet.get(key);
    if (!kept) {
      byColumnSet.set(key, finding);
      continue;
    }
    drop.add(finding);
    kept.coveredFingerprints = [...(kept.coveredFingerprints ?? []), finding.fingerprint];
  }

  // Narrowest first, and carry whatever the narrow one had already absorbed.
  // Without the order and the carry, a chain like (a) -> (a,b) -> (a,b,c) dropped
  // the first suggestion into a middle one that was itself about to disappear, so
  // the surviving index reported "covers 1 other query" when it covered two: the
  // advice vanished with no trace, which is the thing this pass exists to avoid.
  for (const narrow of [...candidates].sort((x, y) => x.indexColumns!.length - y.indexColumns!.length)) {
    for (const wide of candidates) {
      if (narrow === wide || narrow.table !== wide.table) continue;
      const a = narrow.indexColumns!;
      const b = wide.indexColumns!;
      if (a.length >= b.length) continue;
      if (!wide.rule.startsWith("SIA00") || !narrow.rule.startsWith("SIA00")) continue;
      if (b.slice(0, a.length).join(",") !== a.join(",")) continue;
      drop.add(narrow);
      wide.coveredFingerprints = [
        ...(wide.coveredFingerprints ?? []),
        narrow.fingerprint,
        ...(narrow.coveredFingerprints ?? []),
      ];
      break;
    }
  }

  if (drop.size === 0) return findings;

  return findings
    .filter((f) => !drop.has(f))
    .map((f) =>
      f.coveredFingerprints?.length
        ? {
            ...f,
            message: `${f.message} 该索引同时覆盖另外 ${f.coveredFingerprints.length} 条查询的条件，无需重复建。`,
            messageEn: `${f.messageEn} It also serves ${f.coveredFingerprints.length} other queried access path(s) on this table.`,
          }
        : f,
    );
}

/** Same rule + same table + same DDL = the same advice, no matter how many queries asked for it. */
function dedup(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const finding of findings) {
    const key = [
      finding.rule,
      finding.table ?? "",
      finding.fingerprint,
      [...finding.suggestedDDL].sort().join("|"),
      finding.rewrite ?? "",
    ].join("::");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, finding);
      continue;
    }
    // Keep the more severe / more expensive representative.
    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}
