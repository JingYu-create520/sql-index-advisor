import type { Finding, QueryMetrics, QueryRecord, Rule, RuleOptions, Schema } from "../src/core/types.js";
import { DEFAULT_RULE_OPTIONS } from "../src/core/types.js";
import { parseSql } from "../src/parsers/sql.js";
import { validateSchema } from "../src/schema/loader.js";

/** Build a record the way the slow-log loader would. */
export function record(sql: string, metrics?: QueryMetrics): QueryRecord {
  const parsed = parseSql(sql);
  return {
    fingerprint: parsed.fingerprint,
    sql,
    parsed,
    input: metrics ? "slowlog" : "sql",
    source: { file: "test.sql", line: 1 },
    occurrences: 1,
    ...(metrics ? { metrics, totalQueryTime: metrics.queryTime, maxRowsExamined: metrics.rowsExamined } : {}),
  };
}

/**
 * A schema that mirrors examples/schema.json but is deliberately small, so a
 * rule test says exactly which index state it depends on.
 */
export const TEST_SCHEMA: Schema = validateSchema({
  mysqlVersion: "8.0.36",
  tables: [
    {
      name: "orders",
      charset: "utf8mb4",
      columns: [
        { name: "id", type: "bigint" },
        { name: "user_id", type: "bigint" },
        { name: "shop_id", type: "bigint" },
        { name: "status", type: "varchar", length: 16, charset: "utf8mb4" },
        { name: "order_no", type: "varchar", length: 600, charset: "utf8mb4" },
        { name: "remark", type: "text", charset: "utf8mb4" },
        { name: "amount", type: "decimal" },
        { name: "create_time", type: "datetime" },
        { name: "pay_time", type: "datetime" },
      ],
      indexes: [
        { name: "PRIMARY", columns: ["id"], primary: true, unique: true },
        { name: "idx_user_status_time", columns: ["user_id", "status", "create_time"] },
        { name: "uk_order_no", columns: ["order_no"], unique: true },
      ],
    },
    {
      name: "order_item",
      charset: "utf8mb4",
      columns: [
        { name: "id", type: "bigint" },
        { name: "order_id", type: "bigint" },
        { name: "sku_id", type: "bigint" },
        { name: "quantity", type: "int" },
      ],
      indexes: [{ name: "PRIMARY", columns: ["id"], primary: true, unique: true }],
    },
    {
      name: "users",
      charset: "utf8mb4",
      columns: [
        { name: "id", type: "bigint" },
        { name: "mobile", type: "varchar", length: 20, charset: "utf8mb4" },
        { name: "level", type: "int" },
        { name: "create_time", type: "datetime" },
      ],
      indexes: [
        { name: "PRIMARY", columns: ["id"], primary: true, unique: true },
        { name: "idx_level_time", columns: ["level", "create_time"] },
      ],
    },
  ],
}).schema!;

export interface RunOptions {
  schema?: Schema;
  options?: Partial<RuleOptions>;
  metrics?: QueryMetrics;
}

export function runRule(rule: Rule, sql: string, opts: RunOptions = {}): Finding[] {
  const options: RuleOptions = { ...DEFAULT_RULE_OPTIONS, ...opts.options };
  return rule.run({
    record: record(sql, opts.metrics),
    schema: opts.schema,
    options,
  });
}

export function ddls(findings: Finding[]): string[] {
  return findings.flatMap((f) => f.suggestedDDL);
}
