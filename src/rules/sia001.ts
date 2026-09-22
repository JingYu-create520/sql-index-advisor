/**
 * SIA001: missing index candidate.
 *
 * Column order follows docs/DESIGN-NOTES.md D1: equality -> GROUP BY / ORDER BY -> range.
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
      const table = findTable(schema, bucket.table);
      const candidate = candidateColumns(bucket, table);
      if (candidate.length === 0) continue;

      const dropped = unindexableColumns(table, candidate, options);
      const usable = candidate.filter((c) => !dropped.includes(c));
      if (usable.length === 0) continue;

      if (alreadyCovered(table, usable)) continue;
      if (isPrimaryKeyLookup(table, usable, bucket)) continue;
      if (!table && looksLikePrimaryKeyOnly(usable)) continue;
      // A unique single-column equality already resolves to <=1 row; extra
      // predicates need no index, and suggesting one is pure noise.
      if (resolvesByUniqueLookup(table, bucket)) continue;
      // Same argument for a primary key hit with an IN list: the engine is doing
      // a bounded set of PK dives, and whatever else is in the WHERE is a filter
      // on rows it already has.
      if (resolvesByPrimaryKeyIn(table, bucket)) continue;
      // A gap inside an existing composite index is SIA003's call, not a new index.
      if (equalityAlreadyIndexed(table, bucket)) continue;

      const ddl = addIndexDdl(bucket.table, usable);
      const prefixHit = table?.indexes.find((i) => i.columns[0] === usable[0]);
      const lowCardinalityRisk = isFlagColumn(usable, table);
      const severity: Finding["severity"] = lowCardinalityRisk
        ? "info"
        : table
          ? prefixHit
            ? "warn"
            : "error"
          : "info";

      findings.push({
        rule: RULE_ID,
        severity,
        sql: truncateSql(record.parsed.sql),
        fingerprint: record.fingerprint,
        source: record.source,
        queryTime: record.metrics?.queryTime,
        rowsExamined: record.metrics?.rowsExamined ?? record.maxRowsExamined,
        occurrences: record.occurrences,
        needsSchema: false,
        needsMetrics: false,
        table: bucket.table,
        indexColumns: usable,
        lowCardinalityRisk,
        suggestedDDL: [ddl],
        message: [
          buildMessage(bucket, usable, dropped, table ? prefixHit : undefined),
          ...(lowCardinalityRisk ? [FLAG_CAUTION] : []),
        ].join(" "),
        messageEn: [
          buildMessageEn(bucket, usable, dropped, table ? prefixHit : undefined, !!table),
          ...(lowCardinalityRisk
            ? ["Low-cardinality column: check its distinct-value ratio before creating it."]
            : []),
        ].join(" "),
      });
    }

    return findings;
  },
};

/**
 * equality -> grouping/ordering -> IN -> range, deduped and capped at 4 columns:
 * a five-segment composite index is almost always a design smell, not advice.
 */
function candidateColumns(bucket: TableBucket, table?: SchemaTable): string[] {
  const equality = dedupeColumns(bucket.equality.filter((r) => !isJoinOutputKey(r, table)));
  const ordering = dedupeColumns([...bucket.grouping, ...bucket.ordering]);
  const inList = dedupeColumns(bucket.inList).filter((c) => !equality.some((e) => e.column === c.column));
  const range = dedupeColumns(bucket.range).filter(
    (c) => ![...equality, ...ordering, ...inList].some((o) => o.column === c.column),
  );

  const ordered: ColumnRef[] = [];
  // Only honour ordering when nothing before it is a range: that is the whole point of D1.
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

/**
 * The primary key of a table, when it is a single column.
 */
function singlePrimaryKey(table: SchemaTable | undefined): string | undefined {
  const pk = table?.indexes.find((i) => i.primary);
  return pk && pk.columns.length === 1 ? pk.columns[0] : undefined;
}

/**
 * True for the driving side of a join: `ON d.order_id = o.id` puts `o.id` in the
 * bucket, but on `o` that column is a value being handed to the inner table, not a
 * filter narrowing `o`. InnoDB appends the primary key to every secondary index
 * anyway, so a slot spent on it displaces a column that would have done work. Seen
 * on a real project's query: `(shop_id, delete_status, id, create_time)`, where the
 * `id` bought nothing and pushed `create_time` past the sort it was meant to serve.
 */
function isJoinOutputKey(ref: ColumnRef, table: SchemaTable | undefined): boolean {
  if (ref.scope !== "join-on") return false;
  const pk = singlePrimaryKey(table);
  if (!pk || ref.column !== pk) return false;
  return true;
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
  const equality = whereEqualityColumns(bucket);
  if (equality.length === 0) return false;
  return table.indexes.some(
    (index) =>
      (index.primary || index.unique) &&
      index.columns.length === 1 &&
      equality.includes(index.columns[0]!),
  );
}

/**
 * A `WHERE id IN (1, 2, 3)` against a single-column primary key is a bounded set
 * of PK dives, and every other predicate in that WHERE is a filter on rows the
 * engine already holds. Proposing `(status, id)` for one of those is not a
 * different plan, it is a second structure that the optimizer will not prefer,
 * so it costs writes and never gets read. Found on a real project (macrozheng/mall,
 * `OmsOrderDao.delivery`): `WHERE id IN ( ? ) AND status = 1` produced exactly that.
 *
 * `IN (subquery)` is deliberately excluded: there the list has no static bound,
 * and a secondary index can genuinely win.
 */
function resolvesByPrimaryKeyIn(
  table: SchemaTable | undefined,
  bucket: TableBucket,
): boolean {
  if (!table) return false;
  const pk = table.indexes.find((i) => i.primary);
  if (!pk || pk.columns.length !== 1) return false;
  const pkColumn = pk.columns[0]!;
  return bucket.inList.some((ref) => ref.column === pkColumn && (ref.op ?? "in") === "in");
}

/**
 * Only the WHERE clause filters a table. A column that reaches the bucket through
 * `ON other.key = t.id` is a value handed to the join partner, not a narrowing
 * predicate, and counting it made two skips fire on it: a table joined on its
 * primary key looked like a unique lookup, and its real WHERE conditions were
 * judged already indexed. Both checks now ignore join conditions.
 */
function whereEqualityColumns(bucket: TableBucket): string[] {
  return dedupeColumns(bucket.equality.filter((r) => r.scope !== "join-on")).map((c) => c.column);
}

/** True when some existing index already serves every equality column of this table. */
function equalityAlreadyIndexed(
  table: SchemaTable | undefined,
  bucket: TableBucket,
): boolean {
  if (!table) return false;
  const equality = whereEqualityColumns(bucket);
  if (equality.length === 0) return false;
  return table.indexes.some((index) =>
    equality.every((column, position) => index.columns[position] === column),
  );
}

/**
 * A lone boolean / flag column is the classic useless index: a few distinct
 * values over millions of rows means the optimizer will not even pick it. We
 * still report it (a rare-and-hot flag is a real index) but never above `info`,
 * and with the selectivity check spelled out.
 */
const FLAG_NAMES = /^(is_|has_|can_|enabled?|disabled|deleted?|synced?|verified|activated?|expired?|valid|invalid|active|inactive|state|status|type|kind|flag)$/;

const FLAG_CAUTION =
  "注意：这是单列布尔/标志位，区分度可能极低，优化器未必会选它。先跑 " +
  "SELECT COUNT(DISTINCT 列)/COUNT(*) FROM 表; 确认比值足够小再建。";

function isFlagColumn(usable: string[], table: SchemaTable | undefined): boolean {
  if (usable.length !== 1) return false;
  const name = usable[0]!;
  const column = table?.columns.find((c) => c.name === name);
  if (column && ["tinyint", "bit", "boolean", "bool"].includes(column.type)) return true;
  return FLAG_NAMES.test(name);
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

/**
 * The English text has to carry the same caveats as the Chinese one: JSON, MCP
 * and `--lang en` consumers read `messageEn`, so promising "no existing index
 * serves this access path" on the one branch where an index *does* cover its
 * leftmost prefix is a wrong statement, not a translation difference.
 */
function buildMessageEn(
  bucket: TableBucket,
  usable: string[],
  dropped: string[],
  prefixHit: { name: string; columns: string[] } | undefined,
  hasSchema: boolean,
): string {
  const parts = [
    `Candidate index for ${bucket.table} (${usable.join(", ")}), ordered equality -> group/order -> range; ` +
      `only a contiguous run from the first column can be used.`,
  ];
  if (!hasSchema) {
    parts.push("Pass --schema to confirm that nothing already covers this access path.");
  } else if (prefixHit) {
    parts.push(
      `Existing index ${prefixHit.name}(${prefixHit.columns.join(", ")}) covers only a left prefix of the proposed one; ` +
        `evaluate dropping it once the new index is live, since keeping both doubles the write cost.`,
    );
  } else {
    parts.push("No existing index serves this access path.");
  }
  if (dropped.length > 0) {
    parts.push(
      `Column(s) ${dropped.join(", ")} are too long to index whole and were left out; see SIA002 for a prefix-index option.`,
    );
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
