import { describe, expect, it } from "vitest";

import { sia004 } from "../src/rules/sia004.js";
import { ddls, runRule, TEST_SCHEMA } from "./support.js";

describe("SIA004 function or expression on an indexed column", () => {
  it("positive: DATE(col) = literal rewrites into a half-open range", () => {
    const findings = runRule(sia004, "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'", {
      schema: TEST_SCHEMA,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.rewrite).toBe(
      "create_time >= '2026-09-17 00:00:00' AND create_time < '2026-09-18 00:00:00'",
    );
  });

  it("positive: a bound date parameter still gets a sargable shape", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE DATE(create_time) = ?", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.rewrite).toBe("create_time >= ? AND create_time < DATE_ADD(?, INTERVAL 1 DAY)");
  });

  it("positive: YEAR(col) = 2026 becomes the year window", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE YEAR(create_time) = 2026", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.rewrite).toBe(
      "create_time >= '2026-01-01 00:00:00' AND create_time < '2027-01-01 00:00:00'",
    );
  });

  it("positive: LEFT(col, n) = 'abc' becomes a prefix LIKE", () => {
    const [finding] = runRule(sia004, "SELECT id FROM users WHERE LEFT(mobile, 3) = '138'", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.rewrite).toBe("mobile LIKE '138%'");
  });

  it("positive: arithmetic on the column moves to the right-hand side", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE amount + 1 = 10", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.rewrite).toBe("amount = 9");
  });

  it("positive: MySQL 8.0 also offers the functional index", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'", {
      schema: TEST_SCHEMA,
    });
    expect(ddls([finding!])).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));",
    ]);
  });

  it("negative: 5.7 gets no functional index DDL, and says why", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'", {
      schema: TEST_SCHEMA,
      options: { mysqlVersion: 5.7 },
    });
    expect(finding?.suggestedDDL).toEqual([]);
    expect(finding?.message).toContain("5.7 不支持函数索引");
  });

  it("negative: a bare column predicate is fine", () => {
    expect(runRule(sia004, "SELECT id FROM orders WHERE create_time = '2026-09-17'", {
      schema: TEST_SCHEMA,
    })).toEqual([]);
  });

  it("negative: aggregate projection is not a predicate", () => {
    expect(runRule(sia004, "SELECT COUNT(*) FROM orders WHERE user_id = 1", { schema: TEST_SCHEMA })).toEqual(
      [],
    );
  });
});
