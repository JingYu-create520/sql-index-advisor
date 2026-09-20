import { describe, expect, it } from "vitest";

import type { Finding, QueryRecord, Rule } from "../src/core/types.js";
import { analyze } from "../src/rules/engine.js";
import { ALL_RULES } from "../src/rules/registry.js";
import { record, TEST_SCHEMA } from "./support.js";

const sample = (sql: string, metrics?: QueryRecord["metrics"]): QueryRecord[] => [
  record(sql, metrics),
];

describe("analyze: input dependency gating", () => {
  it("explains which rules stayed silent and why", () => {
    const result = analyze(sample("SELECT id FROM orders WHERE user_id = 1 AND create_time > '2026-01-01'"));
    const skipped = new Map(result.skipped.map((s) => [s.id, s.reason]));
    expect(skipped.get("SIA002")).toContain("--schema");
    expect(skipped.get("SIA003")).toContain("--schema");
    expect(skipped.get("SIA005")).toContain("--schema");
    // SIA007 needs both, and the schema reason is reported first.
    expect(skipped.get("SIA007")).toContain("--schema");
    expect(result.records).toBe(1);
  });

  it("reports the missing slow-log metric once the schema is present", () => {
    const result = analyze(sample("SELECT amount FROM orders WHERE user_id = 1"), {
      schema: TEST_SCHEMA,
    });
    const sia007 = result.skipped.find((s) => s.id === "SIA007");
    expect(sia007?.reason).toContain("Rows_examined");
  });

  it("enables schema rules once --schema is supplied", () => {
    const sql = "SELECT id FROM orders WHERE user_id = 1 AND create_time > '2026-01-01'";
    const withSchema = analyze(sample(sql), { schema: TEST_SCHEMA });
    expect(withSchema.findings.some((f) => f.rule === "SIA003")).toBe(true);
    expect(withSchema.skipped.find((s) => s.id === "SIA003")).toBeUndefined();
  });

  it("gates metrics rules on the record, not just on the run", () => {
    const sql = "SELECT amount FROM orders WHERE user_id = 1";
    expect(analyze(sample(sql), { schema: TEST_SCHEMA }).findings.some((f) => f.rule === "SIA007")).toBe(
      false,
    );
    const withMetrics = analyze(
      sample(sql, { queryTime: 3, rowsExamined: 800000 }),
      { schema: TEST_SCHEMA },
    );
    expect(withMetrics.findings.some((f) => f.rule === "SIA007")).toBe(true);
  });
});

describe("analyze: severity and ordering", () => {
  const sql =
    "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17' AND user_id = 1 AND create_time > '2026-01-01'";

  it("minSeverity drops quieter findings", () => {
    const all = analyze(sample(sql), { schema: TEST_SCHEMA });
    expect(all.findings.length).toBeGreaterThan(1);
    const errorsOnly = analyze(sample(sql), { schema: TEST_SCHEMA, minSeverity: "error" });
    expect(errorsOnly.findings.every((f) => f.severity === "error")).toBe(true);
    expect(errorsOnly.findings.length).toBeLessThan(all.findings.length);
  });

  it("sorts by severity before payoff", () => {
    const result = analyze(sample(sql), { schema: TEST_SCHEMA });
    const severities = result.findings.map((f) => f.severity);
    const rank = { error: 3, warn: 2, info: 1 } as const;
    for (let i = 1; i < severities.length; i += 1) {
      expect(rank[severities[i]!] <= rank[severities[i - 1]!]).toBe(true);
    }
  });

  it("slow-log cost dominates the payoff ranking", () => {
    const cheap = record("SELECT id FROM orders WHERE shop_id = 1", { queryTime: 0.01, rowsExamined: 10 });
    const expensive = record("SELECT id FROM users WHERE level = 1 AND mobile = 'x'", {
      queryTime: 9,
      rowsExamined: 5_000_000,
    });
    const result = analyze([cheap, expensive]);
    expect(result.findings[0]?.table).toBeDefined();
    const first = result.findings[0]!;
    expect(first.rowsExamined).toBe(5_000_000);
  });
});

describe("analyze: robustness", () => {
  it("a throwing rule is contained and reported, never fatal", () => {
    const boom: Rule = {
      id: "SIA999",
      title: "explosive",
      titleEn: "explosive",
      needsSchema: false,
      needsMetrics: false,
      run(): Finding[] {
        throw new Error("boom");
      },
    };
    const result = analyze(sample("SELECT id FROM orders WHERE shop_id = 1"), { rules: [boom] });
    expect(result.findings).toEqual([]);
    expect(result.errors.join(" ")).toContain("SIA999");
    expect(result.errors.join(" ")).toContain("boom");
  });

  it("skips statements whose table cannot be identified", () => {
    const result = analyze(sample("CREATE INDEX i ON orders (user_id)"));
    expect(result.findings).toEqual([]);
    expect(result.skipped.length).toBe(ALL_RULES.length);
    expect(result.skipped[0]?.reason).toBe("没有识别到表名");
  });

  it("deduplicates the same advice from the same fingerprint", () => {
    const sql = "SELECT id FROM order_item WHERE sku_id = 1";
    const twice = analyze([record(sql), record(sql)]);
    const once = analyze([record(sql)]);
    expect(twice.findings).toHaveLength(once.findings.length);
  });

  it("drops a narrower index that the wider one already serves", () => {
    // Two real queries on the same table: (sku_id) is a left prefix of
    // (sku_id, warehouse_id), so proposing both is pure write amplification.
    const result = analyze([
      record("SELECT quantity FROM stock WHERE sku_id = 1 AND warehouse_id = 2"),
      record("SELECT quantity FROM stock WHERE sku_id = 1"),
    ]);
    const ddls = result.findings.flatMap((f) => f.suggestedDDL);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("(`sku_id`, `warehouse_id`)");
    expect(ddls.join("")).not.toContain("ADD INDEX `idx_stock_sku_id` (`sku_id`)");
    expect(result.findings[0]?.message).toContain("无需重复建");
  });

  it("keeps two indexes when neither is a prefix of the other", () => {
    const result = analyze([
      record("SELECT id FROM stock WHERE sku_id = 1"),
      record("SELECT id FROM stock WHERE warehouse_id = 2"),
    ]);
    expect(result.findings.flatMap((f) => f.suggestedDDL)).toHaveLength(2);
  });

  it("never puts a boolean flag column above info and says why", () => {
    const result = analyze([record("UPDATE stock SET synced = 1 WHERE synced = 0")]);
    const finding = result.findings.find((f) => f.rule === "SIA001");
    expect(finding?.severity).toBe("info");
    expect(finding?.lowCardinalityRisk).toBe(true);
    expect(finding?.message).toContain("区分度");
  });

  it("a composite starting with a flag column is not penalised", () => {
    const result = analyze([
      record("SELECT id FROM stock WHERE synced = 0 AND sku_id = 5"),
    ]);
    const finding = result.findings.find((f) => f.rule === "SIA001");
    expect(finding?.lowCardinalityRisk).toBeFalsy();
    // Two equality columns keep WHERE appearance order: without statistics there
    // is no basis to claim one is more selective than the other.
    expect(finding?.indexColumns).toEqual(["synced", "sku_id"]);
  });

  it("never emits a finding without a fingerprint or rule id", () => {
    const result = analyze(
      [
        record("SELECT o.* FROM orders o JOIN order_item oi ON oi.order_id = o.id WHERE o.user_id = 1"),
        record("UPDATE orders SET status = 'X' WHERE id = 5"),
        record("SELECT id FROM orders WHERE remark = 'y'"),
      ],
      { schema: TEST_SCHEMA },
    );
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.fingerprint).toBeTruthy();
      expect(finding.rule).toMatch(/^SIA00[1-7]$/);
      expect(finding.message.length).toBeGreaterThan(10);
      expect(finding.messageEn.length).toBeGreaterThan(10);
    }
  });
});

describe("rule catalogue", () => {
  it("registers all seven rules with unique ids", () => {
    expect(ALL_RULES).toHaveLength(7);
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(7);
    expect(ALL_RULES.map((r) => r.id)).toEqual([
      "SIA001",
      "SIA002",
      "SIA003",
      "SIA004",
      "SIA005",
      "SIA006",
      "SIA007",
    ]);
  });

  it("declares dependencies that match the plan", () => {
    const byId = new Map(ALL_RULES.map((r) => [r.id, r]));
    expect(byId.get("SIA001")?.needsSchema).toBe(false);
    expect(byId.get("SIA002")?.needsSchema).toBe(true);
    expect(byId.get("SIA003")?.needsSchema).toBe(true);
    expect(byId.get("SIA004")?.needsSchema).toBe(false);
    expect(byId.get("SIA005")?.needsSchema).toBe(true);
    expect(byId.get("SIA006")?.needsSchema).toBe(false);
    expect(byId.get("SIA007")?.needsSchema).toBe(true);
    expect(byId.get("SIA007")?.needsMetrics).toBe(true);
  });
});
