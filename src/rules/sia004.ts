/**
 * SIA004: a function or expression sits on the indexed column.
 *
 * `WHERE DATE(create_time) = '2026-09-17'` cannot use an index on create_time:
 * the index stores raw datetimes, not the function's output. Two ways out, and
 * we prefer the rewrite because it costs no storage (docs/DESIGN-NOTES.md D7).
 */

import type { ColumnRef, Finding, Rule, RuleContext } from "../core/types.js";
import {
  bucketByTable,
  formatDate,
  indexName,
  parseDateLiteral,
  quoteIdent,
  truncateSql,
} from "./helpers.js";
import { findTable } from "../schema/loader.js";

const RULE_ID = "SIA004";

interface Rewrite {
  predicate: string;
  why: string;
  /** Same argument in English: `messageEn` must not be thinner than `message`. */
  whyEn: string;
}

export const sia004: Rule = {
  id: RULE_ID,
  title: "索引列上使用函数或运算",
  titleEn: "Function or expression on an indexed column",
  needsSchema: false,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema, options } = ctx;
    const findings: Finding[] = [];

    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      for (const ref of dedupe(bucket.wrapped)) {
        const rewrite = buildRewrite(ref);
        const wantedName = table ? indexName(table.name, [ref.column]) : "";
        /**
         * Has this advice already been followed? A functional index reports no
         * column name in `information_schema` (its expression lives in a column a
         * 5.7 server does not have, so the shared dump cannot carry it), which
         * leaves the name we would have used as the only handle: create the index
         * this tool suggests, re-export the schema, and without this check the same
         * `ADD INDEX` comes back — into a migration file that then fails on
         * duplicate key name.
         *
         * A name match is not proof the indexed expression is the same one, so the
         * finding stays and only the DDL goes, with the verification step named.
         */
        const alreadyNamed =
          wantedName !== "" &&
          table!.indexes.some((i) => i.name.toLowerCase() === wantedName.toLowerCase());
        const functionalDdl =
          options.mysqlVersion >= 8 && table && !alreadyNamed
            ? [
                `ALTER TABLE ${quoteIdent(table.name)} ADD INDEX ${quoteIdent(
                  indexName(table.name, [ref.column]),
                )} ((${ref.raw}));`,
              ]
            : [];

        findings.push({
          rule: RULE_ID,
          severity: alreadyNamed ? "warn" : rewrite ? "error" : "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: false,
          needsMetrics: false,
          table: bucket.table,
          suggestedDDL: functionalDdl,
          rewrite: rewrite?.predicate,
          message: [
            alreadyNamed
              ? `条件 ${ref.predicateText ?? ref.raw} 在列 ${ref.column} 上套了函数或运算，按原值建的索引对它无效；不过这张表上已有一个叫 ${wantedName} 的索引，而它正是本条建议会取的名字，若它索引的正是 ${ref.raw}，这个条件已经能走索引。`
              : `条件 ${ref.predicateText ?? ref.raw} 在列 ${ref.column} 上套了函数或运算，索引里存的是原值，因此该列上的索引完全用不上。`,
            rewrite ? `改写方案：${rewrite.predicate}（${rewrite.why}）` : "该表达式没有等价改写形式，可考虑函数索引。",
            ...(options.mysqlVersion >= 8
              ? [`MySQL 8.0 可用函数索引 ((${ref.raw})) 直接索引表达式结果，但查询必须写成完全相同的表达式才能命中；5.7 不支持。`]
              : [`MySQL 5.7 不支持函数索引，只能改写查询。`]),
            functionalDdl.length === 0 && !rewrite && !alreadyNamed
              ? "当前输入未提供 --schema 或版本低于 8.0，未生成 DDL。"
              : "",
            alreadyNamed
              ? `按名字对齐只是提示而不是证明：函数索引索引的表达式在 information_schema 里没有可读的列名（EXPRESSION 这一列 5.7 也不存在），所以请用 SHOW INDEX 自己确认一次。`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          messageEn: [
            alreadyNamed
              ? `Expression \`${ref.raw}\` on ${bucket.table}.${ref.column} is not served by an index on the raw column` +
                ` value; this table already carries an index named ${wantedName}, which is the name this advice` +
                ` would use, so if that one indexes ${ref.raw} the predicate is served today.`
              : `Expression \`${ref.raw}\` on ${bucket.table}.${ref.column} prevents index use: the index holds the raw value, so no index on that column can serve this predicate.`,
            rewrite
              ? `Rewrite it as: ${rewrite.predicate} (${rewrite.whyEn}).`
              : `No equivalent rewrite is provable for this shape, so a functional index is the only way out.`,
            options.mysqlVersion >= 8
              ? `MySQL 8.0 can index the expression itself with ((${ref.raw})), but only a query written with exactly that expression will match it; 5.7 cannot.`
              : `MySQL 5.7 has no functional index, so rewriting the query is the only option.`,
            functionalDdl.length === 0 && !rewrite && !alreadyNamed
              ? `No DDL was generated: this input has no --schema, or the target version is below 8.0.`
              : "",
            alreadyNamed
              ? `That match is by name, not proof: an expression key part carries no readable column name in` +
                ` information_schema (the EXPRESSION column is absent on 5.7 too), so confirm with SHOW INDEX.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
      }

      /**
       * A `LIKE '%x%'` cannot narrow a B-tree seek at all, and the honest answer is
       * not silence. Without this branch the report says "nothing to report" over a
       * guaranteed full scan, which is the one failure mode this tool promises it
       * will not commit; silence has to be attributable. No DDL is offered, because
       * no index helps this predicate.
       */
      for (const ref of dedupe(bucket.range.filter((r) => r.op === "like-middle"))) {
        const shown = ref.predicateText ?? `${ref.raw} LIKE ...`;
        findings.push({
          rule: RULE_ID,
          severity: "info",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: false,
          needsMetrics: false,
          table: bucket.table,
          suggestedDDL: [],
          message: `条件 ${shown} 的 LIKE 模式以 % 开头，B+ 树索引对它无能为力：既不能定位也不能缩小范围，只能在别的条件把行筛出来之后逐行比对。所以本条不给 DDL。出路只有三条：改成右锚定 LIKE（'abc%' 可以命中索引）、给该列建全文索引用 MATCH AGAINST、或者由调用方强制要求前缀长度。`,
          messageEn: `Predicate ${shown} uses a LIKE pattern that starts with %, which no B-tree index can use to seek or narrow: the rows have to arrive for some other reason before the pattern is checked. Hence no DDL here. The three ways out are a right-anchored LIKE ('abc%', indexable), a fulltext index with MATCH AGAINST, or requiring a leading prefix from the caller.`,
        });
      }
    }

    return findings;
  },
};

function dedupe(refs: ColumnRef[]): ColumnRef[] {
  const seen = new Set<string>();
  const out: ColumnRef[] = [];
  for (const ref of refs) {
    const key = ref.predicateText ?? ref.raw;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Turn the wrapped predicate into a sargable range. Only the shapes we can prove
 * equivalent are rewritten; everything else stays a warning.
 */
function buildRewrite(ref: ColumnRef): Rewrite | undefined {
  const raw = ref.raw ?? "";
  const value = (ref.valueText ?? "?").trim();

  const dateCall = /^DATE\(\s*([\w.`]+)\s*\)$/i.exec(raw);
  const day = dateCall && value !== "?" ? parseDateLiteral(value) : null;
  if (dateCall && ref.op === "=") {
    const target = dateCall[1]!;
    if (day) {
      const next = new Date(day.getTime() + 24 * 3600 * 1000);
      return {
        predicate: `${target} >= '${formatDate(day)}' AND ${target} < '${formatDate(next)}'`,
        why: "按天等值等价于左闭右开区间，可命中该列索引",
        whyEn: "equality on one day is the same set as a half-open range over it, which the column index can serve",
      };
    }
    return {
      predicate: `${target} >= ? AND ${target} < DATE_ADD(?, INTERVAL 1 DAY)`,
      why: "绑定参数为日期时同样可改写为区间；注意两个 ? 传同一个值",
      whyEn: "a bound date parameter rewrites the same way; both ? must carry the same value",
    };
  }

  const yearCall = /^YEAR\(\s*([\w.`]+)\s*\)$/i.exec(raw);
  if (yearCall && ref.op === "=") {
    const target = yearCall[1]!;
    const yearValue = /^\d{4}$/.test(value.replace(/'/g, "")) ? Number(value.replace(/'/g, "")) : null;
    if (yearValue) {
      return {
        predicate: `${target} >= '${yearValue}-01-01 00:00:00' AND ${target} < '${yearValue + 1}-01-01 00:00:00'`,
        why: "按年等值等价于该年左闭右开区间",
        whyEn: "equality on a year is the same set as that year as a half-open range",
      };
    }
    return {
      predicate: `${target} >= MAKEDATE(YEAR(?), 1) AND ${target} < MAKEDATE(YEAR(?) + 1, 1)`,
      why: "参数化场景改写为区间",
      whyEn: "range form for the parameterised case",
    };
  }

  const leftCall = /^LEFT\(\s*([\w.`]+)\s*,\s*(\d+)\s*\)$/i.exec(raw);
  if (leftCall && ref.op === "=") {
    const target = leftCall[1]!;
    if (value !== "?") {
      const escaped = value.slice(1, -1).replace(/[%_]/g, (c) => `\\${c}`);
      return {
        predicate: `${target} LIKE '${escaped}%'`,
        why: "取前缀后等值等价于前缀 LIKE，右前缀 LIKE 可用索引",
        whyEn: "comparing a fixed prefix is the same predicate as a LIKE that ends in %, and a leading-anchor LIKE is sargable",
      };
    }
    return { predicate: `${target} LIKE CONCAT(?, '%')`, why: "前缀匹配改写", whyEn: "prefix match rewritten as a LIKE" };
  }

  // `col + 1 = 5` / `col * 2 > 10`: move the arithmetic to the right-hand side.
  const arithmetic = /^([\w.`]+)\s*([+\-])\s*(\d+(?:\.\d+)?)$/i.exec(raw);
  if (arithmetic && ref.op && ["=", ">", "<", ">=", "<=", "!=", "<>"].includes(ref.op)) {
    const [, colPart, sign, numPart] = arithmetic;
    const rhs = numericToOtherSide(sign === "+" ? "-" : "+", numPart!, value);
    if (rhs) {
      return {
        predicate: `${colPart} ${ref.op} ${rhs}`,
        why: "把运算移到右边，左边保持裸列",
        whyEn: "the arithmetic moves to the right side so the left side stays a bare column",
      };
    }
  }

  // Still worth offering the substitution even when we cannot compute a range.
  return undefined;
}

function numericToOtherSide(sign: string, offset: string, value: string): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value === "?" ? `? ${sign} ${offset}` : undefined;
  }
  return String(sign === "-" ? numeric - Number(offset) : numeric + Number(offset));
}
