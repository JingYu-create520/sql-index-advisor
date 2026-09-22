import { describe, expect, it } from "vitest";

import { sia001 } from "../src/rules/sia001.js";
import { ddls, record, runRule, TEST_SCHEMA } from "./support.js";

describe("SIA001 missing index candidate", () => {
  it("positive: recommends the join key for an unindexed inner table", () => {
    const findings = runRule(
      sia001,
      "SELECT o.id FROM orders o JOIN order_item oi ON oi.order_id = o.id WHERE o.user_id = 1",
      { schema: TEST_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `order_item` ADD INDEX `idx_order_item_order_id` (`order_id`);",
    ]);
    // The driving table is already served by idx_user_status_time(user_id, ...).
    expect(findings.some((f) => f.table === "orders")).toBe(false);
  });

  it("positive: orders columns as equality -> ordering -> range (DESIGN-NOTES D1)", () => {
    const findings = runRule(
      sia001,
      "SELECT id FROM orders WHERE status = 'PAID' AND amount > 100 ORDER BY create_time DESC",
      { schema: TEST_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_status_create_time_amount` (`status`, `create_time`, `amount`);",
    ]);
    // Putting the range column before the sort column would force a filesort.
    expect(findings[0]!.message).toContain("等值 -> 排序 -> 范围");
  });

  it("positive: keeps IN and equality columns in the same access class", () => {
    const findings = runRule(
      sia001,
      "SELECT id FROM order_item WHERE order_id = 5 AND sku_id IN (1, 2, 3)",
      { schema: TEST_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `order_item` ADD INDEX `idx_order_item_order_id_sku_id` (`order_id`, `sku_id`);",
    ]);
  });

  it("positive: without a schema the advice is a candidate, not a verdict", () => {
    const findings = runRule(sia001, "SELECT id FROM orders WHERE shop_id = 1 ORDER BY create_time DESC");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.messageEn).toContain("--schema");
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_shop_id_create_time` (`shop_id`, `create_time`);",
    ]);
  });

  it("both languages carry the existing-prefix caveat, and neither claims it is clean", () => {
    const schema = structuredClone(TEST_SCHEMA);
    schema.tables
      .find((t) => t.name === "order_item")!
      .indexes.push({ name: "idx_order_id", columns: ["order_id"], unique: false, primary: false });

    const findings = runRule(
      sia001,
      "SELECT id FROM order_item WHERE order_id = 5 AND sku_id = 7",
      { schema },
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("已有索引 idx_order_id(order_id)");
    // The English text used to assert "no existing index serves this access
    // path" on exactly this branch, which is simply false.
    expect(finding.messageEn).toContain("idx_order_id(order_id)");
    expect(finding.messageEn).not.toMatch(/no existing index serves/i);
  });

  it("negative: primary key lookup needs no new index", () => {
    expect(runRule(sia001, "SELECT * FROM orders WHERE id = 10", { schema: TEST_SCHEMA })).toEqual([]);
    expect(runRule(sia001, "SELECT * FROM orders WHERE id = 10")).toEqual([]);
  });

  /**
   * From a real project (macrozheng/mall, OmsOrderDao.delivery): a batch update
   * whose WHERE is `id IN ( ? ) AND status = 1` used to be answered with
   * `(status, id)`. The engine reads the primary key for that list either way, so
   * the proposal was a second structure nobody would choose.
   */
  it("negative: a primary key IN list is already the access path", () => {
    expect(
      runRule(sia001, "UPDATE orders SET remark = 'x' WHERE id IN (1, 2, 3) AND status = 'PAID'", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
  });

  it("positive: an IN list on a non-key column is still a real candidate", () => {
    const findings = runRule(
      sia001,
      "SELECT id FROM order_item WHERE order_id = 5 AND sku_id IN (1, 2, 3)",
      { schema: TEST_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `order_item` ADD INDEX `idx_order_item_order_id_sku_id` (`order_id`, `sku_id`);",
    ]);
  });

  it("negative: an existing index already covers the equality prefix", () => {
    expect(
      runRule(sia001, "SELECT id FROM orders WHERE user_id = 1 AND status = 'PAID'", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
  });

  /**
   * `ON d.order_id = o.id` puts the driving table's primary key in the bucket, but
   * there it is a value handed to the inner table, not a filter. InnoDB already
   * appends the PK to every secondary index, so that slot bought nothing and it
   * pushed the sort column past the ordering it was meant to serve.
   */
  it("positive: the driving side's primary key is not indexed for a join", () => {
    const findings = runRule(
      sia001,
      "SELECT o.id FROM orders o JOIN order_item oi ON oi.order_id = o.id WHERE o.shop_id = 1 AND o.status = 'PAID' ORDER BY o.create_time",
      { schema: TEST_SCHEMA },
    );
    const orders = findings.find((f) => f.table === "orders");
    expect(orders?.indexColumns).toEqual(["shop_id", "status", "create_time"]);
    // and the inner table still gets its join key
    expect(findings.some((f) => f.table === "order_item" && f.indexColumns?.[0] === "order_id")).toBe(true);
  });

  it("without a schema the join key cannot be recognised, so the advice stays conservative", () => {
    const findings = runRule(
      sia001,
      "SELECT o.id FROM orders o JOIN order_item oi ON oi.order_id = o.id WHERE o.shop_id = 1 AND o.status = 'PAID' ORDER BY o.create_time",
    );
    const orders = findings.find((f) => f.table === "orders");
    expect(orders?.indexColumns).toEqual(["shop_id", "status", "id", "create_time"]);
    expect(orders?.severity).toBe("info");
  });

  it("negative: a unique lookup returns one row, extra predicates need no index", () => {
    expect(
      runRule(sia001, "SELECT id FROM orders WHERE order_no = 'A1' AND status = 'PAID'", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
  });

  it("negative: a bare projection with no predicates produces nothing", () => {
    expect(runRule(sia001, "SELECT COUNT(*) FROM users LIMIT 10", { schema: TEST_SCHEMA })).toEqual([]);
  });

  it("negative: INSERT statements are out of scope", () => {
    expect(
      runRule(sia001, "INSERT INTO users (id, mobile) VALUES (1, 'a')", { schema: TEST_SCHEMA }),
    ).toEqual([]);
  });

  it("negative: ORDER BY over a SELECT alias is not a column", () => {
    const findings = runRule(
      sia001,
      "SELECT shop_id, SUM(amount) AS gmv FROM orders WHERE create_time >= '2026-09-01' GROUP BY shop_id ORDER BY gmv DESC",
      { schema: TEST_SCHEMA },
    );
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_shop_id_create_time` (`shop_id`, `create_time`);",
    ]);
    expect(findings[0]?.message).not.toContain("gmv");
  });

  it("attaches evidence and source location", () => {
    const [finding] = runRule(sia001, "SELECT id FROM order_item WHERE sku_id = 1");
    expect(finding?.source).toEqual({ file: "test.sql", line: 1 });
    expect(finding?.sql).toContain("order_item");
    expect(finding?.fingerprint).toBe(record("SELECT id FROM order_item WHERE sku_id = 1").fingerprint);
  });

  /**
   * `device_message_${deviceId}` is how a real project names its sharded tables.
   * By the time the parser is done, the name is a stub with no physical table
   * behind it, so the only honest output is an explanation with no DDL: the
   * migration this used to emit failed with "table doesn't exist" on import.
   */
  it("negative: a table name built at runtime gets an explanation, not DDL", () => {
    const findings = runRule(sia001, "SELECT id FROM device_message_ WHERE tenant_id = 5");
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.severity).toBe("info");
    expect(finding.suggestedDDL).toEqual([]);
    expect(finding.message).toContain("运行时拼出来");
    expect(finding.messageEn).toContain("built at runtime");
  });

  /**
   * The advice was fine; the sentence beside it was wrong. It told people to pass
   * --schema when they had passed one and the table simply was not in it, which
   * is a different problem with a different fix.
   */
  it("distinguishes 'no schema' from 'this table is not in your schema'", () => {
    const without = runRule(sia001, "SELECT id FROM orders WHERE shop_id = 1");
    expect(without[0]?.messageEn).toContain("Pass --schema");

    const missingTable = runRule(sia001, "SELECT id FROM invoice_lines WHERE customer_id = 1", {
      schema: TEST_SCHEMA,
    });
    expect(missingTable).toHaveLength(1);
    expect(missingTable[0]?.messageEn).toContain("is not among the tables in the schema.json");
    expect(missingTable[0]?.messageEn).not.toContain("Pass --schema");
    expect(missingTable[0]?.message).toContain("不在你给的 schema.json");
  });
});
