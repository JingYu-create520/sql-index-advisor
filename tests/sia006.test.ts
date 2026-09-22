import { describe, expect, it } from "vitest";

import { sia006 } from "../src/rules/sia006.js";
import { runRule, TEST_SCHEMA } from "./support.js";

const DEEP = "SELECT o.* FROM orders o WHERE o.user_id = 1 ORDER BY o.create_time DESC LIMIT 100000, 20";

describe("SIA006 deep pagination", () => {
  it("positive: literal offset above the threshold rewrites to a deferred join", () => {
    const findings = runRule(sia006, DEEP, { schema: TEST_SCHEMA });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rewrite).toBe(
      // The rewrite names its own alias rather than reusing `o`, because the
      // derived table also exposes `id` and an unqualified `ON id = page.id` is
      // ERROR 1052 in MySQL.
      "SELECT t.* FROM (SELECT `id` FROM `orders` WHERE user_id = 1 ORDER BY create_time DESC " +
        "LIMIT 100000, 20) AS page JOIN `orders` t ON t.`id` = page.`id` ORDER BY t.`create_time` DESC;",
    );
    expect(findings[0]?.message).toContain("游标");
  });

  it("positive: offers the keyset form with the real sort key", () => {
    const [finding] = runRule(sia006, DEEP, { schema: TEST_SCHEMA });
    expect(finding?.message).toContain("(t.`create_time` < ? OR (t.`create_time` = ? AND t.`id` < ?))");
  });

  it("positive: the deferred join keeps the original WHERE verbatim", () => {
    // A function-wrapped predicate must not be silently dropped from the rewrite.
    const [finding] = runRule(
      sia006,
      "SELECT o.* FROM orders o WHERE DATE(o.create_time) = '2026-09-17' AND o.user_id = 1 ORDER BY o.id DESC LIMIT 100000, 20",
      { schema: TEST_SCHEMA },
    );
    expect(finding?.rewrite).toContain(
      "WHERE DATE(create_time) = '2026-09-17' AND user_id = 1 ORDER BY id DESC LIMIT 100000, 20",
    );
    expect(finding?.rewrite).toContain("JOIN `orders` t ON t.`id` = page.`id` ORDER BY t.`id` DESC;");
  });

  it("positive: an unaliased query keeps its projection and stays unambiguous", () => {
    // Regression, caught by executing the rewrite the tool emitted against a live
    // MySQL 8.0.46: `ON `id` = page.`id`` failed with ERROR 1052 (ambiguous column)
    // and `SELECT *` had quietly widened `id, user_id, amount` to the whole row.
    const [finding] = runRule(
      sia006,
      "SELECT id, user_id, amount FROM orders WHERE status = 'PAID' LIMIT 100000, 20",
      { schema: TEST_SCHEMA },
    );
    expect(finding?.rewrite).toBe(
      "SELECT t.`id`, t.`user_id`, t.`amount` FROM (SELECT `id` FROM `orders` WHERE status = 'PAID' " +
        "LIMIT 100000, 20) AS page JOIN `orders` t ON t.`id` = page.`id`;",
    );
    expect(finding?.rewrite).not.toMatch(/ON `id`/);
    expect(finding?.rewrite).not.toMatch(/SELECT \* FROM/);
  });

  for (const [name, sql] of [
    ["a computed projection", "SELECT shop_id, SUM(amount) AS gmv FROM orders GROUP BY shop_id LIMIT 100000, 20"],
    ["DISTINCT", "SELECT DISTINCT user_id FROM orders LIMIT 100000, 20"],
    ["a renamed column", "SELECT user_id AS uid FROM orders LIMIT 100000, 20"],
    ["an expression sort key", "SELECT id FROM orders ORDER BY amount + 0 DESC LIMIT 100000, 20"],
    ["a sort on an output alias", "SELECT shop_id, SUM(amount) AS gmv FROM orders GROUP BY shop_id ORDER BY gmv DESC LIMIT 100000, 20"],
  ] as const) {
    it(`negative: ${name} withdraws the rewrite rather than changing the result set`, () => {
      const [finding] = runRule(sia006, sql, { schema: TEST_SCHEMA });
      expect(finding).toBeDefined();
      expect(finding?.rewrite).toBeUndefined();
      // The advice itself is still sound, so it stays in the message as a template.
      expect(finding?.message).toContain("JOIN `orders` t ON t.`id` = page.`id`");
      expect(finding?.messageEn).toContain("changes the result set");
    });
  }

  it("negative: a correlated subquery downgrades to a template, never a rewrite", () => {
    const [finding] = runRule(
      sia006,
      "SELECT o.* FROM orders o WHERE EXISTS (SELECT 1 FROM order_item oi WHERE oi.order_id = o.id) ORDER BY o.id DESC LIMIT 100000, 20",
      { schema: TEST_SCHEMA },
    );
    expect(finding?.severity).toBe("info");
    expect(finding?.rewrite).toBeUndefined();
    expect(finding?.message).toContain("只给模板");
  });

  it("positive: without a schema the primary key is assumed and flagged", () => {
    const [finding] = runRule(sia006, DEEP);
    expect(finding?.message).toContain("请确认主键确实是 id");
  });

  it("positive: LIMIT o, n OFFSET form and no ORDER BY still report", () => {
    const findings = runRule(sia006, "SELECT id FROM orders LIMIT 200000, 10", {
      schema: TEST_SCHEMA,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rewrite).toContain("LIMIT 200000, 10");
    expect(findings[0]?.message).toContain("无法生成 seek 条件");
  });

  it("negative: a parameterised LIMIT carries no static offset (R4)", () => {
    expect(
      runRule(sia006, "SELECT o.* FROM orders o WHERE o.user_id = ? LIMIT ?, ?", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
  });

  it("negative: a shallow offset is not a problem", () => {
    expect(runRule(sia006, "SELECT id FROM orders LIMIT 20, 10", { schema: TEST_SCHEMA })).toEqual([]);
  });

  it("negative: a configurable threshold raises the bar", () => {
    expect(
      runRule(sia006, DEEP, { schema: TEST_SCHEMA, options: { deepOffsetThreshold: 500000 } }),
    ).toEqual([]);
  });

  it("negative: multi-table paging is left alone rather than guessed", () => {
    expect(
      runRule(
        sia006,
        "SELECT o.* FROM orders o JOIN order_item oi ON oi.order_id = o.id LIMIT 100000, 20",
        { schema: TEST_SCHEMA },
      ),
    ).toEqual([]);
  });
});
