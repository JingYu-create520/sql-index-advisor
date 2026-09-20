import { describe, expect, it } from "vitest";

import { sia006 } from "../src/rules/sia006.js";
import { runRule, TEST_SCHEMA } from "./support.js";

const DEEP = "SELECT o.* FROM orders o WHERE o.user_id = 1 ORDER BY o.create_time DESC LIMIT 100000, 20";

describe("SIA006 deep pagination", () => {
  it("positive: literal offset above the threshold rewrites to a deferred join", () => {
    const findings = runRule(sia006, DEEP, { schema: TEST_SCHEMA });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rewrite).toBe(
      "SELECT o.* FROM (SELECT `id` FROM `orders` WHERE user_id = 1 ORDER BY create_time DESC " +
        "LIMIT 100000, 20) AS page JOIN `orders` o ON o.`id` = page.`id` ORDER BY o.create_time DESC;",
    );
    expect(findings[0]?.message).toContain("游标");
  });

  it("positive: offers the keyset form with the real sort key", () => {
    const [finding] = runRule(sia006, DEEP, { schema: TEST_SCHEMA });
    expect(finding?.message).toContain("(o.`create_time` < ? OR (o.`create_time` = ? AND o.`id` < ?))");
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
    expect(finding?.rewrite).toContain("JOIN `orders` o ON o.`id` = page.`id` ORDER BY o.id DESC;");
  });

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
