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

  it("negative: primary key lookup needs no new index", () => {    expect(runRule(sia001, "SELECT * FROM orders WHERE id = 10", { schema: TEST_SCHEMA })).toEqual([]);
    expect(runRule(sia001, "SELECT * FROM orders WHERE id = 10")).toEqual([]);
  });

  it("negative: an existing index already covers the equality prefix", () => {
    expect(
      runRule(sia001, "SELECT id FROM orders WHERE user_id = 1 AND status = 'PAID'", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
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
});
