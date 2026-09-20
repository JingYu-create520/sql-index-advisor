import { describe, expect, it } from "vitest";

import { sia007 } from "../src/rules/sia007.js";
import { ddls, runRule, TEST_SCHEMA } from "./support.js";

const heavy = { queryTime: 4.2, rowsExamined: 900000, rowsSent: 10 };

describe("SIA007 covering index opportunity", () => {
  it("positive: predicate index exists but every row still needs 回表", () => {
    const findings = runRule(sia007, "SELECT amount FROM orders WHERE user_id = 1", {
      schema: TEST_SCHEMA,
      metrics: heavy,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.message).toContain("Using index");
    expect(ddls(findings)).toEqual([
      "ALTER TABLE `orders` ADD INDEX `idx_orders_user_id_status_create_time_amount` (`user_id`, `status`, `create_time`, `amount`);",
    ]);
  });

  it("positive: a million examined rows raises it to an error", () => {
    const findings = runRule(sia007, "SELECT amount FROM orders WHERE user_id = 1", {
      schema: TEST_SCHEMA,
      metrics: { ...heavy, rowsExamined: 1_200_000 },
    });
    expect(findings[0]?.severity).toBe("error");
  });

  it("positive: a projection already inside the index needs no wider index", () => {
    expect(
      runRule(
        sia007,
        "SELECT user_id, status, create_time FROM orders WHERE user_id = 1 AND status = 'PAID' ORDER BY create_time DESC",
        { schema: TEST_SCHEMA, metrics: heavy },
      ),
    ).toEqual([]);
  });

  it("negative: SELECT * can never be covered", () => {
    expect(
      runRule(sia007, "SELECT * FROM orders WHERE user_id = 1", {
        schema: TEST_SCHEMA,
        metrics: heavy,
      }),
    ).toEqual([]);
  });

  it("negative: no observed row pressure means no expensive-index advice", () => {
    expect(
      runRule(sia007, "SELECT amount FROM orders WHERE user_id = 1", {
        schema: TEST_SCHEMA,
        metrics: { queryTime: 0.01, rowsExamined: 50 },
      }),
    ).toEqual([]);
  });

  it("negative: without metrics the rule is not even eligible", () => {
    expect(runRule(sia007, "SELECT amount FROM orders WHERE user_id = 1", { schema: TEST_SCHEMA })).toEqual(
      [],
    );
  });

  it("negative: an unindexed predicate belongs to SIA001, not here", () => {
    expect(
      runRule(sia007, "SELECT amount FROM orders WHERE shop_id = 1", {
        schema: TEST_SCHEMA,
        metrics: heavy,
      }),
    ).toEqual([]);
  });

  it("negative: a TEXT projection cannot live in an index", () => {
    expect(
      runRule(sia007, "SELECT remark FROM orders WHERE user_id = 1", {
        schema: TEST_SCHEMA,
        metrics: heavy,
      }),
    ).toEqual([]);
  });

  it("negative: cross-table projections are skipped", () => {
    expect(
      runRule(sia007, "SELECT oi.quantity FROM order_item oi JOIN orders o ON oi.order_id = o.id", {
        schema: TEST_SCHEMA,
        metrics: heavy,
      }),
    ).toEqual([]);
  });
});
