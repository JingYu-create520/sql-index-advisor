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
    const sourceAlias = table.alias ?? "";
    /**
     * The rewrite always introduces its own alias, because the derived table
     * `page` exposes the primary key too: without a qualifier, `ON id = page.id`
     * is `ERROR 1052 Column 'id' in on clause is ambiguous` and the statement the
     * tool hands over does not run. That was exactly the case for an unaliased
     * `SELECT id, user_id, amount FROM orders … LIMIT 100000, 20`.
     */
    const outer = "t";
    const schemaTable = findTable(schema, table.name);
    const pk = schemaTable?.indexes.find((i) => i.primary)?.columns[0] ?? "id";

    // Rebuild the derived table from the *original* clause text. Reconstructing it
    // from classified columns would silently drop predicates we could not
    // classify (a function-wrapped column, an OR group), and a rewrite that
    // changes the result set is worse than no rewrite at all.
    const rawWhere = record.parsed.whereText ?? "";
    const rawOrder = record.parsed.orderByText ?? "";

    // Inside the unaliased derived table the outer alias is not visible.
    const innerWhere = rawWhere ? ` WHERE ${unqualify(rawWhere, sourceAlias)}` : "";
    const innerOrder = rawOrder ? ` ORDER BY ${unqualify(rawOrder, sourceAlias)}` : "";

    /**
     * The projection and the outer sort have to survive re-qualification, or the
     * rewrite is a different query. `SELECT *` becomes the row through the new
     * alias; a plain column list is rebuilt in order; anything computed, renamed
     * or DISTINCT cannot be expressed this way, so the rewrite is withdrawn and
     * only the template is shown.
     */
    const isOutputAlias = (column: string): boolean =>
      record.parsed.selectAliases.includes(column) && !record.parsed.selectColumns.includes(column);
    const projection = record.parsed.selectStar
      ? `${outer}.*`
      : record.parsed.selectPlain
        ? record.parsed.selectColumns.map((c) => `${outer}.${quoteIdent(c)}`).join(", ")
        : undefined;
    const sortable =
      rawOrder === "" ||
      (record.parsed.orderBy.length > 0 &&
        record.parsed.orderBy.every(
          (c) =>
            !c.wrapped &&
            !isOutputAlias(c.column) &&
            // The only qualifier that can appear is this statement's own table or
            // its alias - the FROM has exactly one table - and both map onto `t`.
            (!c.table || c.table === sourceAlias.toLowerCase() || c.table === table.name.toLowerCase()),
        ));
    const outerOrder =
      rawOrder === ""
        ? ""
        : sortable
          ? ` ORDER BY ${record.parsed.orderBy
              .map((c) => `${outer}.${quoteIdent(c.column)}${c.desc ? " DESC" : ""}`)
              .join(", ")}`
          : "";
    const faithful = projection !== undefined && sortable && !record.parsed.selectDistinct;

    const deferredJoin =
      `SELECT ${projection ?? `${outer}.* /* 把原查询的投影逐列搬过来 */`} ` +
      `FROM (SELECT ${quoteIdent(pk)} FROM ${quoteIdent(table.name)}${innerWhere}${innerOrder} LIMIT ${limit.offset}, ${limit.rowCount ?? 20}) AS page ` +
      `JOIN ${quoteIdent(table.name)} ${outer} ON ${outer}.${quoteIdent(pk)} = page.${quoteIdent(pk)}${outerOrder};`;

    // A correlated subquery would have to move into the derived table wholesale;
    // that is easy to get wrong statically, so we hand over a template instead.
    const correlated = /\(\s*select\b/i.test(rawWhere) && sourceAlias.length > 0;
    const templateOnly = correlated || !faithful;

    const ordering = record.parsed.orderBy[0];
    const cmp = ordering?.desc ? "<" : ">";
    const seek =
      ordering && !isOutputAlias(ordering.column) && faithful
        ? `SELECT ${projection} FROM ${quoteIdent(table.name)} ${outer} ` +
          `WHERE (${outer}.${quoteIdent(ordering.column)} ${cmp} ? OR (${outer}.${quoteIdent(ordering.column)} = ? AND ${outer}.${quoteIdent(pk)} ${cmp} ?))` +
          `${outerOrder} LIMIT ${limit.rowCount ?? 20};`
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
      rewrite: templateOnly ? undefined : deferredJoin,
      message: [
        `LIMIT ${limit.offset}, ${limit.rowCount ?? "?"}：MySQL 仍要扫描并丢弃前 ${limit.offset} 行，页码越深代价越高，Pages_read 全部白付。`,
        correlated
          ? `该语句的 WHERE 含子查询，静态改写延迟关联容易出错，这里只给模板，请人工核对子查询在派生表中的可见性：${deferredJoin}`
          : !faithful
            ? `延迟关联的写法是成熟的（模板见下），但这条查询的投影或排序本工具无法逐列搬进改写里（含函数、改名 AS、DISTINCT 或带表名限定的排序键），给出一份会改变结果集的 SQL 比不给更糟，所以 rewrite 字段留空：${deferredJoin}`
            : `方案一（延迟关联，改动最小）：先在索引里翻主键，再回表取整行：${deferredJoin}`,
        ...(seek
          ? [`方案二（游标/seek 分页，适合无限下拉）：用上一页最后一行的排序键替代偏移量：${seek}`]
          : !ordering
            ? [`方案二（游标分页）：当前查询没有 ORDER BY，无法生成 seek 条件；深分页必须先有稳定排序键。`]
            : [`方案二（游标分页）：需要先把排序键换成上一页的值，本工具没有生成模板，因为这条查询的投影无法逐列搬过来。`]),
        ...(schemaTable
          ? []
          : [`未提供 --schema，改写语句按主键列名 id 生成，执行前请确认主键确实是 id。`]),
        `注意：派生表只决定取哪几行，最终顺序仍由外层 ORDER BY 决定，外层排序不能省。`,
      ].join(" "),
      messageEn: [
        `OFFSET ${limit.offset} scans and discards rows before returning ${limit.rowCount ?? "?"}; use a deferred join or keyset pagination.`,
        correlated
          ? `The WHERE clause contains a subquery, and moving it into a derived table is easy to get wrong statically, so this is a template only: check how the subquery sees the derived table.`
          : !faithful
            ? `The deferred-join shape below is the standard fix, but the rewrite is left empty because this query's projection or sort cannot be carried over column by column (a function, an \`AS\` rename, DISTINCT, or a qualified sort key): handing back SQL that changes the result set is worse than handing back none.`
            : `Option one (deferred join, smallest change): page through the primary key in the index, then fetch the rows.`,
        ...(ordering && !seek
          ? [`Option two (keyset pagination) is not generated here: the columns cannot be carried over.`]
          : seek
            ? [`Option two (keyset pagination) replaces the offset with the last sort key of the previous page.`]
            : [`Option two (keyset pagination) needs a stable sort key, and this query has no ORDER BY.`]),
        schemaTable
          ? ""
          : `No --schema was passed, so the rewrite assumes the primary key is named id; confirm before running it.`,
      ]
        .filter(Boolean)
        .join(" "),
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
