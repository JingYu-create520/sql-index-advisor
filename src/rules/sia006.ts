/**
 * SIA006: deep pagination.
 *
 * `LIMIT 100000, 20` still walks and throws away 100000 index entries. Only
 * literal offsets are judged, because a MyBatis `LIMIT #{offset}, #{size}` carries
 * no static value and guessing is exactly the false positive we promised to avoid
 * (docs/DESIGN-NOTES.md D4).
 */

import type { Finding, Rule, RuleContext } from "../core/types.js";
import { quoteIdent, truncateSql } from "./helpers.js";
import { findTable } from "../schema/loader.js";

const RULE_ID = "SIA006";

export const sia006: Rule = {
  id: RULE_ID,
  title: "深分页",
  titleEn: "Deep pagination",
  needsSchema: false,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema, options } = ctx;
    const limit = record.parsed.limit;
    if (!limit?.literal || limit.offset === undefined) return [];
    if (limit.offset < options.deepOffsetThreshold) return [];
    if (record.parsed.kind !== "select") return [];
    // Deferred join across a multi-table FROM changes semantics; stay quiet.
    if (record.parsed.tables.length !== 1) return [];

    const table = record.parsed.tables[0]!;
    const alias = table.alias ?? "";
    const aliasInUse = alias.length > 0;
    const schemaTable = findTable(schema, table.name);
    const pk = schemaTable?.indexes.find((i) => i.primary)?.columns[0] ?? "id";

    // Rebuild the derived table from the *original* clause text. Reconstructing it
    // from classified columns would silently drop predicates we could not
    // classify (a function-wrapped column, an OR group), and a rewrite that
    // changes the result set is worse than no rewrite at all.
    const rawWhere = record.parsed.whereText ?? "";
    const rawOrder = record.parsed.orderByText ?? "";
    const order = rawOrder ? ` ORDER BY ${rawOrder}` : "";
    const projection = aliasInUse ? `${alias}.*` : "*";
    const qualified = (column: string): string =>
      aliasInUse ? `${alias}.${quoteIdent(column)}` : quoteIdent(column);

    // Inside the unaliased derived table the outer alias is not visible.
    const innerWhere = rawWhere ? ` WHERE ${unqualify(rawWhere, alias)}` : "";
    const innerOrder = rawOrder ? ` ORDER BY ${unqualify(rawOrder, alias)}` : "";

    const deferredJoin =
      `SELECT ${projection} ` +
      `FROM (SELECT ${quoteIdent(pk)} FROM ${quoteIdent(table.name)}${innerWhere}${innerOrder} LIMIT ${limit.offset}, ${limit.rowCount ?? 20}) AS page ` +
      `JOIN ${quoteIdent(table.name)}${aliasInUse ? ` ${alias}` : ""} ON ${aliasInUse ? `${alias}.` : ""}${quoteIdent(pk)} = page.${quoteIdent(pk)}${order};`;

    // A correlated subquery would have to move into the derived table wholesale;
    // that is easy to get wrong statically, so we hand over a template instead.
    const correlated = /\(\s*select\b/i.test(rawWhere) && aliasInUse;

    const ordering = record.parsed.orderBy[0];
    const cmp = ordering?.desc ? "<" : ">";
    const seek = ordering
      ? `SELECT ${projection} FROM ${quoteIdent(table.name)}${aliasInUse ? ` ${alias}` : ""} ` +
        `WHERE (${qualified(ordering.column)} ${cmp} ? OR (${qualified(ordering.column)} = ? AND ${qualified(pk)} ${cmp} ?))` +
        `${order} LIMIT ${limit.rowCount ?? 20};`
      : undefined;

    const finding: Finding = {
      rule: RULE_ID,
      severity: correlated ? "info" : "warn",
      sql: truncateSql(record.parsed.sql),
      fingerprint: record.fingerprint,
      source: record.source,
      queryTime: record.metrics?.queryTime,
      rowsExamined: record.metrics?.rowsExamined,
      occurrences: record.occurrences,
      needsSchema: false,
      needsMetrics: false,
      table: table.name,
      suggestedDDL: [],
      rewrite: correlated ? undefined : deferredJoin,
      message: [
        `LIMIT ${limit.offset}, ${limit.rowCount ?? "?"}：MySQL 仍要扫描并丢弃前 ${limit.offset} 行，页码越深代价越高，Pages_read 全部白付。`,
        correlated
          ? `该语句的 WHERE 含子查询，静态改写延迟关联容易出错，这里只给模板，请人工核对子查询在派生表中的可见性：${deferredJoin}`
          : `方案一（延迟关联，改动最小）：先在索引里翻主键，再回表取整行：${deferredJoin}`,
        ...(seek
          ? [`方案二（游标/seek 分页，适合无限下拉）：用上一页最后一行的排序键替代偏移量：${seek}`]
          : [`方案二（游标分页）：当前查询没有 ORDER BY，无法生成 seek 条件；深分页必须先有稳定排序键。`]),
        ...(schemaTable
          ? []
          : [`未提供 --schema，改写语句按主键列名 id 生成，执行前请确认主键确实是 id。`]),
        `注意：派生表只决定取哪几行，最终顺序仍由外层 ORDER BY 决定，外层排序不能省。`,
      ].join(" "),
      messageEn: `OFFSET ${limit.offset} scans and discards rows before returning ${limit.rowCount ?? "?"}; use a deferred join or keyset pagination.`,
    };

    return [finding];
  },
};

/** `o.user_id = 1` -> `user_id = 1`, for use inside an unaliased derived table. */
function unqualify(text: string, alias: string): string {
  if (!alias) return text;
  return text.replace(new RegExp(`\`?${escapeRegExp(alias)}\`?\\s*\\.\\s*`, "gi"), "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
