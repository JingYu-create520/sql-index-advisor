/**
 * SIA001 — missing index candidate.
 *
 * Column order follows docs/PLAN.md R1: equality -> GROUP BY / ORDER BY -> range.
 * A range predicate stops the index from serving equality lookups *or* sorting on
 * the columns behind it, which is why the range column goes last.
 */

import type {
  ColumnRef,
  Finding,
  Rule,
  RuleContext,
  RuleOptions,
  SchemaTable,
} from "../core/types.js";
import {
  addIndexDdl,
  bucketByTable,
  dedupeColumns,
  indexName,
  oversizedColumns,
  truncateSql,
  type TableBucket,
} from "./helpers.js";
import { findTable } from "../schema/loader.js";

const RULE_ID = "SIA001";

export const sia001: Rule = {
  id: RULE_ID,
  title: "缺失索引候选",
  titleEn: "Missing index candidate",
  needsSchema: false,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema, options } = ctx;
    if (!["select", "update", "delete"].includes(record.parsed.kind)) return [];

    const buckets = bucketByTable(record.parsed, schema);
    const findings: Finding[] = [];

    for (const bucket of buckets) {
      const candidate = candidateColumns(bucket);
      if (candidate.length === 0) continue;

      const table = findTable(schema, bucket.table);
      const dropped = unindexableColumns(table, candidate, options);
      const usable = candidate.filter((c) => !dropped.includes(c));
      if (usable.length === 0) continue;

      if (alreadyCovered(table, usable)) continue;
      if (isPrimaryKeyLookup(table, usable, bucket)) continue;
      if (!table && looksLikePrimaryKeyOnly(usable)) continue;
      // A unique single-column equality already resolves to <=1 row; extra
      // predicates need no index, and suggesting one is pure noise.
      if (resolvesByUniqueLookup(table, bucket)) continue;
      // A gap inside an existing composite index is SIA003's call, not a new index.
      if (equalityAlreadyIndexed(table, bucket)) continue;

      const ddl = addIndexDdl(bucket.table, usable);
      const prefixHit = table?.indexes.find((i) => i.columns[0] === usable[0]);

      findings.push({
        rule: RULE_ID,
        severity: table ? (prefixHit ? "warn" : "error") : "info",
        sql: truncateSql(record.parsed.sql),
        fingerprint: record.fingerprint,
        source: record.source,
        queryTime: record.metrics?.queryTime,
        rowsExamined: record.metrics?.rowsExamined ?? record.maxRowsExamined,
        occurrences: record.occurrences,
        needsSchema: false,
        needsMetrics: false,
        table: bucket.table,
        suggestedDDL: [ddl],
        message: buildMessage(bucket, usable, dropped, table ? prefixHit : undefined),
        messageEn: table
          ? `No usable index for the ${bucket.table} access pattern; consider (${usable.join(", ")}).`
          : `Candidate index for ${bucket.table} (${usable.join(", ")}); pass --schema to confirm nothing already covers it.`,
      });
    }

    return findings;
  },
};

/**
 * equality -> grouping/ordering -> IN -> range, deduped and capped at 4 columns:
 * a five-segment composite index is almost always a design smell, not advice.
 */
function candidateColumns(bucket: TableBucket): string[] {
  const equality = dedupeColumns(bucket.equality);
  const ordering = dedupeColumns([...bucket.grouping, ...bucket.ordering]);
  const inList = dedupeColumns(bucket.inList).filter((c) => !equality.some((e) => e.column === c.column));
  const range = dedupeColumns(bucket.range).filter(
    (c) => ![...equality, ...ordering, ...inList].some((o) => o.column === c.column),
  );

  const ordered: ColumnRef[] = [];
  // Only honour ordering when nothing before it is a range: that is the whole point of R1.
  const orderingUsable = range.length === 0 || ordering.length > 0;
  ordered.push(...equality);
  if (orderingUsable) ordered.push(...ordering);
  ordered.push(...inList.slice(0, 1));
  if (orderingUsable) ordered.push(...range.slice(0, 1));

  const names: string[] = [];
  for (const ref of ordered) {
    if (!names.includes(ref.column)) names.push(ref.column);
    if (names.length >= 4) break;
  }
  return names;
}

function unindexableColumns(
  table: SchemaTable | undefined,
  columns: string[],
  options: RuleOptions,
): string[] {
  if (!table) return [];
  return oversizedColumns(table, columns, options).map((c) => c.name);
}

function alreadyCovered(
  table: SchemaTable | undefined,
  columns: string[],
): boolean {
  if (!table) return false;
  return table.indexes.some((index) =>
    columns.every((column, position) => index.columns[position] === column),
  );
}

function isPrimaryKeyLookup(
  table: SchemaTable | undefined,
  columns: string[],
  bucket: TableBucket,
): boolean {
  if (!bucket.isDriving || columns.length !== 1) return false;
  const pk = table?.indexes.find((i) => i.primary);
  return !!pk && pk.columns.length === 1 && pk.columns[0] === columns[0];
}

/** Without a schema, a lone `WHERE id = ?` is the single most common false positive. */
function looksLikePrimaryKeyOnly(columns: string[]): boolean {
  return columns.length === 1 && columns[0] === "id";
}

/** True when an equality column is itself a UNIQUE or PRIMARY single-column key. */
function resolvesByUniqueLookup(
  table: SchemaTable | undefined,
  bucket: TableBucket,
): boolean {
  if (!table) return false;
  const equality = dedupeColumns(bucket.equality).map((c) => c.column);
  if (equality.length === 0) return false;
  return table.indexes.some(
    (index) =>
      (index.primary || index.unique) &&
      index.columns.length === 1 &&
      equality.includes(index.columns[0]!),
  );
}

/** True when some existing index already serves every equality column of this table. */
function equalityAlreadyIndexed(  table: SchemaTable | undefined,
  bucket: TableBucket,
): boolean {
  if (!table) return false;
  const equality = dedupeColumns(bucket.equality).map((c) => c.column);
  if (equality.length === 0) return false;
  return table.indexes.some((index) =>
    equality.every((column, position) => index.columns[position] === column),
  );
}

function buildMessage(
  bucket: TableBucket,
  usable: string[],
  dropped: string[],
  prefixHit: { name: string; columns: string[] } | undefined,
): string {
  const parts = [
    `${bucket.table} 上按当前条件访问缺少可用索引，建议按「等值 -> 排序 -> 范围」顺序建 (${usable.join(", ")})。`,
    `最左前缀：只有从第一列开始连续使用才能命中该索引。`,
  ];
  if (prefixHit) {
    parts.push(
      `已有索引 ${prefixHit.name}(${prefixHit.columns.join(", ")}) 只覆盖前缀，新索引可用后可评估是否下线旧索引以减少写放大。`,
    );
  }
  if (dropped.length > 0) {
    parts.push(`列 ${dropped.join(", ")} 单列过长，未纳入本次建议，请见 SIA002 前缀索引方案。`);
  }
  return parts.join(" ");
}

/** Exported so the rule doc generator can quote the ordering rationale once. */
export const ORDERING_RULE = "equality -> group/order -> in -> range";

export function explain(): string {
  return [
    `${RULE_ID} 触发条件：查询在某个表上有等值 / IN / 范围 / 排序条件，但没有可用索引。`,
    `列顺序：${ORDERING_RULE}（范围列之后的列既不能用于等值也不能用于排序）。`,
    `索引名规则：${indexName("demo", ["a", "b"])}。`,
  ].join("\n");
}
