/**
 * SIA007: covering index opportunity.
 *
 * When every column the query needs already lives inside the index, InnoDB never
 * touches the clustered index, and `Extra: Using index` replaces thousands of
 * random-page 回表 reads. Expensive advice, so it is gated on observed row
 * pressure from the slow log rather than guessed from shape alone
 * (docs/DESIGN-NOTES.md D5: this rule needs both schema *and* metrics).
 */

import type { Finding, Rule, RuleContext } from "../core/types.js";
import { addIndexDdl, bucketByTable, dedupeColumns, truncateSql } from "./helpers.js";
import { columnKeyBytes, findColumn, findTable } from "../schema/loader.js";

const RULE_ID = "SIA007";
const ROW_PRESSURE = 10_000;

export const sia007: Rule = {
  id: RULE_ID,
  title: "覆盖索引机会",
  titleEn: "Covering index opportunity",
  needsSchema: true,
  needsMetrics: true,
  run(ctx: RuleContext): Finding[] {
    const { record, schema } = ctx;
    const rows = record.metrics?.rowsExamined ?? 0;
    if (rows < ROW_PRESSURE) return [];
    if (record.parsed.kind !== "select") return [];
    if (record.parsed.selectStar || record.parsed.selectColumns.length === 0) return [];
    // Cross-table projections would need one index per table; too easy to be wrong.
    if (record.parsed.tables.length !== 1) return [];

    const bucket = bucketByTable(record.parsed, schema)[0];
    const table = findTable(schema, bucket?.table ?? record.parsed.tables[0]!.name);
    if (!bucket || !table) return [];

    const predicate = dedupeColumns([...bucket.equality, ...bucket.inList, ...bucket.range]);
    if (predicate.length === 0) return [];

    // Ownership: no usable predicate index yet is SIA001's job.
    const predicateName = predicate.map((c) => c.column);
    const covering = table.indexes.find((index) =>
      predicateName.every((column, position) => index.columns[position] === column),
    );
    if (!covering) return [];

    const missing = record.parsed.selectColumns.filter((c) => !covering.columns.includes(c));
    const ordering = dedupeColumns(bucket.ordering).map((c) => c.column);
    const additions = [...new Set([...ordering, ...missing])].filter((c) => !covering.columns.includes(c));

    if (additions.length === 0) return [];
    const combined = [...covering.columns, ...additions];
    if (combined.length > 5) return [];

    let bytes = 0;
    for (const name of combined) {
      const column = findColumn(table, name);
      // An unknown column means the projection came from another table or an alias.
      if (!column) return [];
      const size = columnKeyBytes(column, table.charset);
      if (!Number.isFinite(size)) return [];
      bytes += size;
    }
    if (bytes > ctx.options.prefixBytes) return [];

    const ddl = addIndexDdl(table.name, combined);

    return [
      {
        rule: RULE_ID,
        severity: rows >= 1_000_000 ? "error" : "warn",
        sql: truncateSql(record.parsed.sql),
        fingerprint: record.fingerprint,
        source: record.source,
        queryTime: record.metrics?.queryTime,
        rowsExamined: rows,
        occurrences: record.occurrences,
        needsSchema: true,
        needsMetrics: true,
        table: table.name,
        indexColumns: combined,
        suggestedDDL: [ddl],
        message: [
          `该查询扫描 ${rows.toLocaleString("en-US")} 行，但只需要 ${combined.length} 个不同列（${combined.join(", ")}）。`,
          `现有索引 ${covering.name}(${covering.columns.join(", ")}) 能定位但取不全列，每一行都要回表读聚簇索引。`,
          `把它扩展成覆盖索引后，EXPLAIN 的 Extra 应出现 Using index，回表带来的随机 IO 直接消失。`,
          `代价：索引变宽后写放大与空间上升，且 ${additions.join(", ")} 上的更新会额外维护该索引，请人工评估写入频率。`,
        ].join(" "),
        messageEn: `Extending ${covering.name} to cover (${combined.join(", ")}) removes the 回表 for ${rows} examined rows.`,
      },
    ];
  },
};
