/**
 * SIA003: leftmost prefix violation.
 *
 * An index (a, b, c) is useless for `WHERE a = ? AND c = ?` beyond the `a`
 * lookup: `b` breaks the run, so `c` cannot narrow the range. This rule exists
 * because that mistake is invisible in EXPLAIN's key column (it still shows the
 * index as "used") and only shows up in `key_len`.
 */

import type { Finding, Rule, RuleContext } from "../core/types.js";
import {
  addIndexDdl,
  bucketByTable,
  truncateSql,
} from "./helpers.js";
import { findTable } from "../schema/loader.js";

const RULE_ID = "SIA003";

export const sia003: Rule = {
  id: RULE_ID,
  title: "最左前缀违反",
  titleEn: "Leftmost-prefix violation",
  needsSchema: true,
  needsMetrics: false,
  run(ctx: RuleContext): Finding[] {
    const { record, schema } = ctx;
    const findings: Finding[] = [];

    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;

      const used = new Set(
        [...bucket.equality, ...bucket.inList, ...bucket.range, ...bucket.ordering].map((c) => c.column),
      );
      if (used.size === 0) continue;

      for (const index of table.indexes) {
        if (index.columns.length < 2) continue;

        let run = 0;
        while (run < index.columns.length && used.has(index.columns[run]!)) run += 1;
        if (run === 0) continue; // leading column unused at all -> SIA001's job

        const gapIndex = index.columns.findIndex((c, position) => position > run && used.has(c));
        if (gapIndex === -1) continue;

        const skipped = index.columns.slice(run, gapIndex);
        const reached = index.columns.slice(0, run);
        const wanted = [...index.columns.slice(0, run), index.columns[gapIndex]!];

        findings.push({
          rule: RULE_ID,
          severity: "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          indexColumns: wanted,
          suggestedDDL: [addIndexDdl(table.name, wanted)],
          message: [
            `索引 ${index.name}(${index.columns.join(", ")}) 只能用到前 ${run} 列（${reached.join(", ")}），`,
            `条件跳过了 ${skipped.join(", ")} 却直接用了 ${index.columns[gapIndex]}，`,
            `MySQL 无法用 ${index.columns[gapIndex]} 缩小范围，只能扫描 ${index.name} 的每个 ${reached[reached.length - 1]} 区间（EXPLAIN 的 key 仍显示该索引，要看 key_len 才发现）。`,
            `两条出路：① 在 WHERE 中补上 ${skipped.join(" / ")} 的条件以命中现有索引；② 无法补时新建索引 (${wanted.join(", ")})。`,
            `选 ② 时注意新索引与 ${index.name} 存在写放大重叠，上线后需评估是否下线旧索引。`,
          ].join(""),
          messageEn: `Query uses ${index.name} but skips ${skipped.join(", ")}; only ${run} column(s) are usable as a range prefix.`,
        });

        // One hint per index is enough; the fix is the same for every gap.
        break;
      }
    }

    return findings;
  },
};
