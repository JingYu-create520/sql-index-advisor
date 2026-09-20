/**
 * SIA002 — prefix index.
 *
 * A long VARCHAR / TEXT column cannot occupy a full index key: InnoDB caps a key
 * at 3072 bytes (8.0 DYNAMIC) or 767 bytes (5.7 COMPACT), and utf8mb4 costs four
 * bytes per character. The old "VARCHAR > 255" rule of thumb is a utf8mb3 relic,
 * so the threshold here is computed in bytes (docs/PLAN.md R7).
 */

import type { Finding, Rule, RuleContext } from "../core/types.js";
import {
  bucketByTable,
  dedupeColumns,
  indexName,
  isStringType,
  quoteIdent,
  suggestPrefixChars,
  truncateSql,
} from "./helpers.js";
import { columnKeyBytes, findColumn, findTable } from "../schema/loader.js";

const RULE_ID = "SIA002";

export const sia002: Rule = {
  id: RULE_ID,
  title: "前缀索引",
  titleEn: "Prefix index",
  needsSchema: true,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema, options } = ctx;
    const findings: Finding[] = [];

    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;

      const predicateColumns = dedupeColumns([...bucket.equality, ...bucket.inList, ...bucket.range]);
      for (const ref of predicateColumns) {
        const column = findColumn(table, ref.column);
        if (!column || !isStringType(column.type)) continue;

        const bytes = columnKeyBytes(column, table.charset);
        const isBlobLike = column.type.endsWith("text") || column.type === "blob";
        if (!isBlobLike && bytes <= options.prefixBytes / 2) continue;

        const existing = table.indexes.find((i) => i.columns[0] === column.name && i.subParts?.[0]);
        if (existing) continue;

        const prefix = suggestPrefixChars(column, table, options);
        const name = indexName(table.name, [column.name]);

        findings.push({
          rule: RULE_ID,
          severity: isBlobLike ? "error" : "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          indexColumns: [column.name],
          suggestedDDL: [
            `ALTER TABLE ${quoteIdent(table.name)} ADD INDEX ${quoteIdent(name)} (${quoteIdent(
              column.name,
            )}(${prefix}));`,
          ],
          message: [
            `${table.name}.${column.name} 是 ${column.type}${column.length ? `(${column.length})` : ""}，`,
            `${isBlobLike ? "该类列必须指定前缀长度才能建索引" : `整列键长约 ${bytes} 字节，超过 ${options.prefixBytes} 字节上限的 1/2`}。`,
            `先用这条 SQL 验证前缀区分度，再决定 N：`,
            `SELECT COUNT(DISTINCT LEFT(${column.name}, ${prefix})) / COUNT(DISTINCT ${column.name}) AS ratio FROM ${table.name};`,
            `ratio 接近 1 说明前缀足够；否则调大 N 或改查询条件。`,
          ].join(" "),
          messageEn: `${table.name}.${column.name} is too long for a full index key; index a verified prefix instead.`,
        });
      }
    }

    return findings;
  },
};
