import { describe, expect, it } from "vitest";

import { sia002 } from "../src/rules/sia002.js";
import { ddls, runRule, TEST_SCHEMA } from "./support.js";

describe("SIA002 prefix index", () => {
  it("positive: a TEXT column in an equality predicate needs a prefix length", () => {
    const findings = runRule(sia002, "SELECT id FROM orders WHERE remark = 'note'", {
      schema: TEST_SCHEMA,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_remark` (`remark`(64));",
    ]);
  });

  it("positive: thresholds are byte-based, not the utf8mb3-era 255 chars (R7)", () => {
    // varchar(600) utf8mb4 = 2400 bytes, over half the 3072-byte key budget.
    const findings = runRule(sia002, "SELECT id FROM orders WHERE order_no = 'A0001'", {
      schema: TEST_SCHEMA,
    });
    expect(findings[0]?.severity).toBe("warn");
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_order_no` (`order_no`(128));",
    ]);
  });

  it("positive: tells you how to verify the prefix is selective enough", () => {
    const [finding] = runRule(sia002, "SELECT id FROM orders WHERE remark = 'x'", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.message).toContain("COUNT(DISTINCT LEFT(remark, 64))");
    expect(finding?.message).toContain("COUNT(DISTINCT remark)");
  });

  it("negative: a short varchar needs no prefix", () => {
    expect(runRule(sia002, "SELECT id FROM orders WHERE status = 'PAID'", { schema: TEST_SCHEMA })).toEqual(
      [],
    );
  });

  it("negative: a numeric column is never a prefix candidate", () => {
    expect(runRule(sia002, "SELECT id FROM orders WHERE user_id = 1", { schema: TEST_SCHEMA })).toEqual([]);
  });

  it("negative: columns outside the predicates are left alone", () => {
    expect(runRule(sia002, "SELECT remark FROM orders WHERE user_id = 1", { schema: TEST_SCHEMA })).toEqual(
      [],
    );
  });

  it("scales the prefix to a tighter key budget", () => {
    // status varchar(16) utf8mb4 = 64 bytes; half of 64 is the trigger point.
    const findings = runRule(sia002, "SELECT id FROM orders WHERE status = 'PAID'", {
      schema: TEST_SCHEMA,
      options: { prefixBytes: 64 },
    });
    expect(findings).toHaveLength(1);
    expect(ddls(findings)[0]).toContain("`status`(16)");
  });

  it("uses the 5.7 key budget when the schema says 5.7", () => {
    const findings = runRule(sia002, "SELECT id FROM orders WHERE order_no = 'A0001'", {
      schema: TEST_SCHEMA,
      options: { mysqlVersion: 5.7, prefixBytes: 767 },
    });
    // 767 bytes / 4 bytes per char = 191 chars, still under the 600 declared.
    expect(ddls(findings)[0]).toContain("`order_no`(128)");
  });
});
