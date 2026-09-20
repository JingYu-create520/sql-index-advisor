import { describe, expect, it } from "vitest";

import { sia003 } from "../src/rules/sia003.js";
import { ddls, runRule, TEST_SCHEMA } from "./support.js";

describe("SIA003 leftmost prefix violation", () => {
  it("positive: the query skips a middle column of an existing composite index", () => {
    const findings = runRule(
      sia003,
      "SELECT id FROM orders WHERE user_id = 1 AND create_time > '2026-09-01'",
      { schema: TEST_SCHEMA },
    );
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("status");
    // The point of the rule: EXPLAIN still shows the index, key_len does not.
    expect(finding?.message).toContain("key_len");
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_user_id_create_time` (`user_id`, `create_time`);",
    ]);
  });

  it("positive: ordering counts as using a column", () => {
    const findings = runRule(
      sia003,
      "SELECT id FROM users WHERE level = 3 ORDER BY create_time DESC",
      { schema: TEST_SCHEMA },
    );
    // idx_level_time(level, create_time) is fully aligned, so nothing to report.
    expect(findings).toEqual([]);
  });

  it("negative: every prefix column is used", () => {
    expect(
      runRule(
        sia003,
        "SELECT id FROM orders WHERE user_id = 1 AND status = 'PAID' AND create_time > '2026-09-01'",
        { schema: TEST_SCHEMA },
      ),
    ).toEqual([]);
  });

  it("negative: the leading column is unused, which is SIA001's territory", () => {
    expect(
      runRule(sia003, "SELECT id FROM orders WHERE create_time > '2026-09-01'", {
        schema: TEST_SCHEMA,
      }),
    ).toEqual([]);
  });

  it("negative: single-column indexes cannot violate a prefix rule", () => {
    expect(runRule(sia003, "SELECT id FROM users WHERE mobile = '138'", { schema: TEST_SCHEMA })).toEqual(
      [],
    );
  });

  it("reports at most one finding per index", () => {
    const findings = runRule(
      sia003,
      "SELECT id FROM orders WHERE user_id = 1 AND create_time > '2026-09-01' AND pay_time IS NOT NULL",
      { schema: TEST_SCHEMA },
    );
    expect(findings.filter((f) => f.rule === "SIA003")).toHaveLength(1);
  });
});
