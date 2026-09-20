import { describe, expect, it } from "vitest";

import { sia005 } from "../src/rules/sia005.js";
import { runRule, TEST_SCHEMA } from "./support.js";

describe("SIA005 implicit type conversion", () => {
  it("positive: string column compared to a number kills the index", () => {
    const findings = runRule(sia005, "SELECT id FROM users WHERE mobile = 13800000000", {
      schema: TEST_SCHEMA,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.rewrite).toBe("SELECT id FROM users WHERE mobile = '13800000000'");
    expect(findings[0]?.message).toContain("type=ALL");
  });

  it("positive: quotes every numeric element of an IN list", () => {
    const [finding] = runRule(sia005, "SELECT id FROM users WHERE mobile IN (138, 139)", {
      schema: TEST_SCHEMA,
    });
    expect(finding?.rewrite).toBe("SELECT id FROM users WHERE mobile IN ('138', '139')");
  });

  it("negative: the other direction is safe and must stay quiet", () => {
    // int_col = '123' converts the constant, not the column: index still usable.
    expect(
      runRule(sia005, "SELECT id FROM users WHERE level = '3'", { schema: TEST_SCHEMA }),
    ).toEqual([]);
  });

  it("negative: a bound parameter reveals no type, so no claim is made", () => {
    expect(runRule(sia005, "SELECT id FROM users WHERE mobile = ?", { schema: TEST_SCHEMA })).toEqual([]);
  });

  it("negative: numeric columns are not candidates", () => {
    expect(runRule(sia005, "SELECT id FROM orders WHERE user_id = 1", { schema: TEST_SCHEMA })).toEqual([]);
  });

  it("negative: unknown tables are skipped instead of guessed", () => {
    expect(
      runRule(sia005, "SELECT id FROM other_table WHERE code = 123", { schema: TEST_SCHEMA }),
    ).toEqual([]);
  });
});
