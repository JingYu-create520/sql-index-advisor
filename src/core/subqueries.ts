/**
 * Turn the `SELECT`s hidden inside parentheses into records of their own.
 *
 * `IN (SELECT role_id FROM upms_user_role WHERE user_id = ?)` has two statements
 * in it, and they need indexes on two different tables. The outer one gets the
 * `user_id` list to read; the inner one scans `upms_user_role`, and until this
 * file existed the inner scan was simply reported as "not analysed" — an honest
 * note about a miss, which is still a miss.
 *
 * Each body is parsed as a complete statement and enters the run with the weight
 * of its parent: a slow inner query is slow because the outer statement kept
 * running it, so inheriting `occurrences` and the cost is the least misleading
 * arithmetic available without an execution plan.
 */

import { parseSqlAll } from "../parsers/sql.js";
import type { QueryRecord } from "./types.js";

/**
 * Append one record per subquery found in the given records, each directly behind
 * the statement it came from — a slow log sorted worst-query-first must not have
 * its subqueries dumped at the bottom, where the reader stops looking.
 *
 * Two bodies with the same fingerprint fold into one record rather than appearing
 * twice, because a suggestion repeated for the same query pattern is noise — and
 * the run already deduplicates findings by table and columns.
 */
export function withSubqueryRecords(records: QueryRecord[]): QueryRecord[] {
  const out: QueryRecord[] = [];
  const byFingerprint = new Map<string, QueryRecord>();
  for (const record of records) {
    if (!byFingerprint.has(record.fingerprint)) byFingerprint.set(record.fingerprint, record);
  }

  for (const record of records) {
    out.push(record);

    // A body's own nested bodies are picked up when *it* is expanded; parsing the
    // parent again from scratch would re-walk the same text once per level.
    if (record.parsed.subquery) continue;

    for (const inner of parseSqlAll(record.sql).slice(1)) {
      const seen = byFingerprint.get(inner.fingerprint);
      if (seen) {
        foldInto(seen, record);
        continue;
      }
      const created: QueryRecord = {
        fingerprint: inner.fingerprint,
        sql: inner.sql,
        source: record.source,
        parsed: inner,
        input: record.input,
        statementId: `${record.statementId ?? record.fingerprint.slice(0, 12)}#subquery`,
        namespace: record.namespace,
        rawInterpolation: record.rawInterpolation,
        occurrences: record.occurrences,
        totalQueryTime: record.totalQueryTime,
        maxRowsExamined: record.maxRowsExamined,
        metrics: record.metrics,
      };
      byFingerprint.set(inner.fingerprint, created);
      out.push(created);
    }
  }

  return out;
}

/** Count the parent's weight once more against an identical query already seen. */
function foldInto(existing: QueryRecord, from: QueryRecord): void {
  if (existing === from) return;
  existing.occurrences = (existing.occurrences ?? 0) + (from.occurrences ?? 0);
  existing.totalQueryTime = (existing.totalQueryTime ?? 0) + (from.totalQueryTime ?? 0);
  existing.maxRowsExamined = Math.max(existing.maxRowsExamined ?? 0, from.maxRowsExamined ?? 0);
}
