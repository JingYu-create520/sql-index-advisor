import { describe, expect, it } from "vitest";

import { parseSql, splitStatements } from "../src/parsers/sql.js";
import { loadInput } from "../src/core/input.js";
import { analyze } from "../src/rules/engine.js";
import { record } from "./support.js";

/**
 * Regression guard for the merge bug: a `.sql` file whose statements end at a
 * newline instead of a `;` used to be parsed as one statement, so the first FROM
 * set the table and a later WHERE set the columns. Two unrelated queries
 * produced `ALTER TABLE semantic_cache ADD INDEX (aggregate_id)`, and
 * `aggregate_id` belongs to `outbox`.
 */
const MERGED = "SELECT count(*) AS n FROM semantic_cache\nSELECT count(*) FROM outbox WHERE aggregate_id = 'x'";

describe("parseSql: statements merged by a missing ';'", () => {
  it("refuses to analyse them and says why", () => {
    const parsed = parseSql(MERGED);
    expect(parsed.tables).toEqual([]);
    expect(parsed.kind).toBe("unknown");
    expect(parsed.notes.join(" ")).toContain("分号");
  });

  it("emits no cross-table index recommendation", () => {
    const { findings } = analyze([record(MERGED)]);
    const ddl = findings.flatMap((f) => f.suggestedDDL ?? []).join("\n");
    expect(ddl).not.toMatch(/semantic_cache.*aggregate_id/);
    expect(findings.filter((f) => f.rule === "SIA001")).toEqual([]);
  });

  it("says why the rules stayed silent, instead of passing quietly", () => {
    const { skipped } = analyze([record(MERGED)]);
    expect(skipped.find((s) => s.id === "SIA001")?.reason).toContain("缺少分号");
  });

  it("still parses each statement when they are terminated properly", () => {
    const first = parseSql("SELECT count(*) AS n FROM semantic_cache;");
    const second = parseSql("SELECT count(*) FROM outbox WHERE aggregate_id = 'x';");
    expect(first.tables.map((t) => t.name)).toEqual(["semantic_cache"]);
    expect(second.tables.map((t) => t.name)).toEqual(["outbox"]);
    expect(second.notes).toEqual([]);
  });

  it("does not mistake a UNION for a merged pair", () => {
    const parsed = parseSql("SELECT id FROM orders UNION SELECT id FROM archived_orders");
    expect(parsed.notes.join(" ")).not.toContain("分号");
    expect(parsed.tables.map((t) => t.name)).toContain("orders");
  });

  it("does not mistake an IN subquery for a merged pair", () => {
    const parsed = parseSql(
      "SELECT COUNT(*) FROM order_item WHERE order_id IN (SELECT id FROM orders WHERE user_id = 1)",
    );
    expect(parsed.notes.join(" ")).not.toContain("分号");
    expect(parsed.tables.map((t) => t.name)).toEqual(["order_item"]);
  });

  it("does not mistake an INSERT ... SELECT for a merged pair", () => {
    const parsed = parseSql("INSERT INTO archive (id) SELECT id FROM orders WHERE user_id = 1");
    expect(parsed.notes.join(" ")).not.toContain("分号");
  });

  it("counts three statements as three", () => {
    const parsed = parseSql(
      "SELECT a FROM t1\nSELECT b FROM t2\nSELECT c FROM t3 WHERE d = 1",
    );
    expect(parsed.notes.join(" ")).toContain("3");
    expect(parsed.tables).toEqual([]);
  });
});

/**
 * `analyze_sql` documents "可用 ; 分隔多条", but the inline path used to parse the
 * whole blob as one statement — harmless only when every statement happens to
 * touch the same table.
 */
describe("splitStatements: the ';' contract the MCP tool advertises", () => {
  it("splits terminated statements", () => {
    expect(splitStatements("SELECT 1 FROM a; SELECT 2 FROM b;")).toEqual(["SELECT 1 FROM a", "SELECT 2 FROM b"]);
  });

  it("leaves a semicolon inside a string literal alone", () => {
    expect(splitStatements("SELECT 'x;y' AS v FROM a")).toEqual(["SELECT 'x;y' AS v FROM a"]);
  });

  it("leaves a semicolon inside a comment alone", () => {
    expect(splitStatements("SELECT 1 FROM a -- trailing ; here\n; SELECT 2 FROM b")).toEqual([
      "SELECT 1 FROM a -- trailing ; here",
      "SELECT 2 FROM b",
    ]);
  });

  it("gives the MCP inline path one record per statement", () => {
    const loaded = loadInput("SELECT id FROM order_item WHERE sku_id = 1; SELECT id FROM order_item WHERE sku_id = 2;", {
      inline: true,
    });
    expect(loaded.records).toHaveLength(2);
    expect(loaded.notes).toEqual([]);
    const { findings } = analyze(loaded.records);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.table === "order_item")).toBe(true);
  });
});
