/**
 * SIA005: implicit type conversion kills the index.
 *
 * Direction matters. `varchar_col = 123` converts the *column* to a number for
 * every row, so no index on that column can be used. The reverse,
 * `int_col = '123'`, converts the constant once and still uses the index, so we
 * deliberately do not report it (docs/rules.md: 宁可漏报不误报).
 */

import type { ColumnRef, Finding, Rule, RuleContext } from "../core/types.js";
import {
  bucketByTable,
  isStringType,
  numericLiteral,
  quoteIdent,
  replacePredicate,
  truncateSql,
} from "./helpers.js";
import { findColumn, findTable } from "../schema/loader.js";

const RULE_ID = "SIA005";

export const sia005: Rule = {
  id: RULE_ID,
  title: "隐式类型转换导致索引失效",
  titleEn: "Implicit type conversion invalidates the index",
  needsSchema: true,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema } = ctx;
    const findings: Finding[] = [];

    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;

      for (const ref of [...bucket.equality, ...bucket.inList]) {
        const column = findColumn(table, ref.column);
        if (!column || !isStringType(column.type)) continue;

        const offenders = numericOperands(ref);
        if (offenders.length === 0) continue;

        const newPredicate = rewritePredicate(ref, offenders);
        if (!newPredicate || !ref.predicateText) continue;

        const substituted = replacePredicate(record.parsed.sql, ref.predicateText, newPredicate);

        findings.push({
          rule: RULE_ID,
          severity: "error",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          suggestedDDL: [],
          rewrite: substituted ?? newPredicate,
          message: [
            `${table.name}.${column.name} 是字符串类型（${column.type}），但条件 ${ref.predicateText} 拿数字去比，`,
            `MySQL 的规则是把列侧转成数字再比较，等于对整列套函数，${quoteIdent(column.name)} 上的索引直接失效（EXPLAIN 会显示 type=ALL）。`,
            `改法：字面量加引号，或在 Java 侧把参数类型改成 String。`,
            `注意 ${table.name}.${column.name} 若是手机号/订单号，还要确认业务上没有前导零丢失问题。`,
            substituted ? "" : "（只给出改写后的谓词：原语句结构与解析结果不一致，无法安全整句替换。）",
          ]
            .filter(Boolean)
            .join(" "),
          messageEn: `String column ${table.name}.${column.name} compared to a number forces a per-row cast and skips the index.`,
        });
      }
    }

    return findings;
  },
};

/** Which operand texts are bare numbers (the trigger). */
function numericOperands(ref: ColumnRef): string[] {
  if (ref.parameterized) return [];
  const text = ref.valueText ?? "";
  if (ref.op === "in") {
    return text
      .replace(/^\(\s*|\s*\)$/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => numericLiteral(part) !== undefined);
  }
  return numericLiteral(text) ? [text.trim()] : [];
}

function rewritePredicate(ref: ColumnRef, offenders: string[]): string | undefined {
  if (!ref.predicateText) return undefined;
  let out = ref.predicateText;
  for (const offender of offenders) {
    out = out.replace(new RegExp(`(?<![\\w.])${escapeRegExp(offender)}(?![\\w.])`), `'${offender}'`);
  }
  return out === ref.predicateText ? undefined : out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
