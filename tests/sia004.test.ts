import { describe, expect, it } from "vitest";

import { sia004 } from "../src/rules/sia004.js";
import { ddls, FUNCTIONAL_SCHEMA, runRule, TEST_SCHEMA } from "./support.js";

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
    // The English field used to offer the functional index unconditionally, so a
    // `--lang en` or JSON reader on 5.7 was told to do something the server
    // cannot do, in the same run where no such DDL was emitted.
    expect(finding?.messageEn).toContain("5.7 has no functional index");
    expect(finding?.messageEn).not.toContain("or add a functional index");
  });

  it("8.0 offers the functional index in both languages", () => {
    const [finding] = runRule(sia004, "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'", {
      schema: TEST_SCHEMA,
      options: { mysqlVersion: 8.0 },
    });
    expect(finding?.suggestedDDL.join(" ")).toContain("((DATE(create_time)))");
    expect(finding?.message).toContain("MySQL 8.0 可用函数索引");
    expect(finding?.messageEn).toContain("MySQL 8.0 can index the expression");
  });

  /**
   * A leading-wildcard LIKE used to produce an empty report. The rule exists so
   * that silence is always attributable to something: here the honest answer is
   * "no index can help this predicate", not "nothing to report".
   */
  it("a LIKE that starts with % is reported, with no DDL, in both languages", () => {
    const findings = runRule(sia004, "SELECT id FROM orders WHERE remark LIKE '%abc%'", {
      schema: TEST_SCHEMA,
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.severity).toBe("info");
    expect(finding.suggestedDDL).toEqual([]);
    expect(finding.message).toContain("全文索引");
    expect(finding.messageEn).toContain("fulltext index");
    expect(finding.messageEn).toContain("no B-tree index");
  });

  it("positive: a right-anchored LIKE is indexable and stays quiet here", () => {
    expect(runRule(sia004, "SELECT id FROM orders WHERE remark LIKE 'abc%'", { schema: TEST_SCHEMA })).toEqual([]);
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

  /**
   * A wrapped column only matters where it is being tested. This statement formats
   * a date for output while its WHERE clause stays a clean range, and the old
   * answer told the user that their usable index was unusable.
   */
  it("negative: a function in the projection is not a predicate problem", () => {
    expect(
      runRule(
        sia004,
        "SELECT DATE_FORMAT(pay_time, '%Y-%m-%d') AS d, COUNT(*) FROM orders WHERE pay_time >= '2026-01-01' AND pay_time < '2026-02-01' GROUP BY d",
        { schema: TEST_SCHEMA },
      ),
    ).toEqual([]);
  });

  it("positive: the same function in the WHERE is still reported", () => {
    const findings = runRule(
      sia004,
      "SELECT id FROM orders WHERE DATE_FORMAT(pay_time, '%Y-%m-%d') = '2026-01-05'",
      { schema: TEST_SCHEMA },
    );
    expect(findings).toHaveLength(1);
    // warn rather than error: no provably equivalent range exists for an
    // arbitrary DATE_FORMAT pattern, so there is no rewrite to hand over.
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.rewrite).toBeUndefined();
  });
});

describe("SIA004 stops asking for an index that is already there", () => {
  // FUNCTIONAL_SCHEMA is a real 8.0.46 dump taken *after* the DDL this rule emits
  // was applied, which is exactly the state that used to produce the same
  // `ADD INDEX` again on the next run - and a migration file that then fails on
  // duplicate key name.
  it("suppresses the DDL once the advice has been followed", () => {
    const findings = runRule(
      sia004,
      "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'",
      { schema: FUNCTIONAL_SCHEMA },
    );
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(ddls(findings)).toEqual([]);
    expect(finding?.severity).toBe("warn");
    // The rewrite is still worth having: it is the other way to make this sargable.
    expect(finding?.rewrite).toContain("create_time >=");
    expect(finding?.message).toContain("idx_orders_create_time");
    expect(finding?.messageEn).toContain("idx_orders_create_time");
    expect(finding?.messageEn).toContain("not proof");
  });

  it("still asks when no index carries that name", () => {
    const [finding] = runRule(
      sia004,
      "SELECT id FROM orders WHERE UPPER(status) = 'PAID'",
      { schema: FUNCTIONAL_SCHEMA },
    );
    expect(finding?.suggestedDDL).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_status` ((UPPER(status)));",
    ]);
  });

  it("is unchanged against a schema without the index", () => {
    const [finding] = runRule(
      sia004,
      "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'",
      { schema: TEST_SCHEMA },
    );
    expect(finding?.suggestedDDL).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));",
    ]);
    expect(finding?.severity).toBe("error");
  });
});
