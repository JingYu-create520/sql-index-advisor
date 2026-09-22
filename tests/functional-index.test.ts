import { describe, expect, it } from "vitest";

import { sia001 } from "../src/rules/sia001.js";
import { sia003 } from "../src/rules/sia003.js";
import { sia007 } from "../src/rules/sia007.js";
import { validateSchema } from "../src/schema/loader.js";
import type { Schema } from "../src/core/types.js";
import { ddls, FUNCTIONAL_SCHEMA, runRule } from "./support.js";

/**
 * Expression key parts, as MySQL 8.0 actually reports them.
 *
 * `CREATE INDEX … ((DATE(create_time)))` and a multi-valued JSON index leave
 * `COLUMN_NAME` NULL in `information_schema.STATISTICS`, so a dumped schema holds
 * `"columns": [null]`. Two things must both be true then: the file still loads, and
 * no rule pretends to know the name of that part.
 */

const heavy = { queryTime: 3.1, rowsExamined: 800000, rowsSent: 20 };

describe("SIA001 against a functional index", () => {
  it("does not mistake DATE(create_time) for an index on create_time", () => {
    // The functional index really exists; it really cannot serve a plain range.
    const findings = runRule(
      sia001,
      "SELECT id FROM orders WHERE create_time >= '2026-09-01'",
      { schema: FUNCTIONAL_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` (`create_time`);",
    ]);
  });

  it("names an expression part as one when it points at a partially covering index", () => {
    // idx_mixed really starts on the column the query sorts by, so SIA001 reaches
    // for it and has to print a key part it has no name for.
    const schema: Schema = validateSchema({
      mysqlVersion: "8.0.46",
      tables: [
        {
          name: "orders",
          charset: "utf8mb4",
          rowCountEstimate: 500000,
          columns: [
            { name: "id", type: "bigint", nullable: false },
            { name: "status", type: "varchar", length: 16, nullable: true, charset: "utf8mb4" },
            { name: "amount", type: "decimal", nullable: false },
          ],
          indexes: [
            { name: "PRIMARY", columns: ["id"], primary: true, unique: true },
            { name: "idx_mixed", columns: ["status", null] },
          ],
        },
      ],
    }).schema!;
    const findings = runRule(sia001, "SELECT id FROM orders WHERE amount > 100 ORDER BY status", {
      schema,
    });
    const [finding] = findings;
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("idx_mixed(status, 〈表达式〉)");
    expect(finding?.messageEn).toContain("idx_mixed(status, (expression))");
    expect(`${finding?.message}${finding?.messageEn}`).not.toContain("null");
  });
});

describe("rules never speak a column name they do not have", () => {
  const statements = [
    "SELECT id FROM orders WHERE user_id = 1 AND status = 'PAID'",
    "SELECT id FROM orders WHERE user_id = 1 ORDER BY create_time DESC LIMIT 20",
    "SELECT id, status FROM orders WHERE create_time > '2026-01-01' AND user_id = 2",
    "SELECT id FROM orders WHERE user_id = 1 AND create_time BETWEEN '2026-01-01' AND '2026-12-31'",
  ];

  for (const [i, sql] of statements.entries()) {
    it(`statement ${i + 1}: no DDL or message contains a null key part`, () => {
      for (const rule of [sia001, sia003, sia007]) {
        const findings = runRule(rule, sql, { schema: FUNCTIONAL_SCHEMA, metrics: heavy });
        for (const finding of findings) {
          expect(finding.indexColumns ?? []).not.toContain(null);
          for (const ddl of finding.suggestedDDL) expect(ddl).not.toMatch(/`null`|\(null\)/);
          expect(`${finding.message} ${finding.messageEn}`).not.toMatch(/\bnull\b/);
        }
      }
    });
  }

  it("SIA007 will not widen an index whose predicate prefix runs into an expression", () => {
    // The only index on this table starts on user_id and then has an expression
    // part, so there is no column list this rule could legitimately extend.
    const schema: Schema = validateSchema({
      mysqlVersion: "8.0.46",
      tables: [
        {
          name: "orders",
          charset: "utf8mb4",
          rowCountEstimate: 900000,
          columns: [
            { name: "user_id", type: "bigint", nullable: false },
            { name: "amount", type: "decimal", nullable: false },
            { name: "status", type: "varchar", length: 16, nullable: true, charset: "utf8mb4" },
          ],
          indexes: [{ name: "idx_mixed", columns: ["user_id", null] }],
        },
      ],
    }).schema!;
    expect(
      runRule(sia007, "SELECT amount FROM orders WHERE user_id = 1", { schema, metrics: heavy }),
    ).toEqual([]);
  });
});
