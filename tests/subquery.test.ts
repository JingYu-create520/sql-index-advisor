import { describe, expect, it } from "vitest";

import { loadInput } from "../src/core/input.js";
import type { QueryRecord } from "../src/core/types.js";
import { withSubqueryRecords } from "../src/core/subqueries.js";
import { analyze } from "../src/rules/engine.js";
import { parseSqlAll } from "../src/parsers/sql.js";
import { record } from "./support.js";

/**
 * Subqueries as statements of their own.
 *
 * Two things had to be true at once: the table behind `IN (SELECT ...)` gets
 * examined (it used to be reported as a known miss), and nothing from the outer
 * query leaks into the advice for the inner one. The second is the dangerous
 * half, which is why most of this file is negative tests.
 */

const innerOf = (sql: string): QueryRecord[] =>
  withSubqueryRecords([record(sql)]).filter((r) => r.parsed.subquery);

describe("parseSqlAll: subquery bodies", () => {
  it("returns the outer statement plus the body of an IN subquery", () => {
    const all = parseSqlAll(
      "SELECT id FROM orders o WHERE o.user_id = 7 AND o.status IN (SELECT s.code FROM status s WHERE s.enabled = 1)",
    );
    expect(all).toHaveLength(2);
    expect(all[0]!.subquery).toBeUndefined();
    expect(all[0]!.tables.map((t) => t.name)).toEqual(["orders"]);
    expect(all[1]!.subquery).toBe(true);
    expect(all[1]!.kind).toBe("select");
    expect(all[1]!.tables.map((t) => t.name)).toEqual(["status"]);
    expect(all[1]!.columns.map((c) => c.column)).toContain("enabled");
  });

  it("does not mistake an IN value list for a subquery", () => {
    expect(parseSqlAll("SELECT id FROM orders WHERE status IN ('A','B')")).toHaveLength(1);
  });

  it("reaches every nesting level", () => {
    const all = parseSqlAll(
      "SELECT id FROM a WHERE x IN (SELECT y FROM b WHERE z IN (SELECT w FROM c WHERE v = 1))",
    );
    expect(all.map((p) => p.tables.map((t) => t.name))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("lifts a correlated EXISTS body out as its own statement", () => {
    const all = parseSqlAll(
      "SELECT id FROM users u WHERE u.level = 1 AND EXISTS (SELECT 1 FROM user_address a WHERE a.user_id = u.id AND a.city = 'HZ')",
    );
    expect(all).toHaveLength(2);
    expect(all[1]!.tables.map((t) => t.name)).toEqual(["user_address"]);
  });

  it("keeps a UNION branch of a subquery as one body", () => {
    const all = parseSqlAll("SELECT id FROM a WHERE x IN (SELECT y FROM b UNION SELECT z FROM c)");
    expect(all).toHaveLength(2);
    expect(all[1]!.notes.join()).toContain("UNION");
  });
});

describe("subquery records: what must not leak in", () => {
  it("drops an unqualified right-hand column that may belong to the outer query", () => {
    // MySQL resolves `id` inner-first: when `order_item` has no such column it is
    // the outer query's, and an index on it would be DDL for a column that does
    // not exist on this table. The suggestion keeps only what it can name.
    const { findings } = analyze(
      withSubqueryRecords([
        record(
          "SELECT id FROM orders o WHERE o.status = 'PAID' AND EXISTS (SELECT 1 FROM order_item oi WHERE oi.order_id = id AND oi.quantity = 0)",
        ),
      ]),
    );
    const item = findings.find((f) => f.table === "order_item");
    expect(item?.indexColumns).toEqual(["order_id", "quantity"]);
    expect(item?.indexColumns).not.toContain("id");
  });

  it("keeps the inner side of a bare correlation and drops the outer name", () => {
    const { findings } = analyze(
      withSubqueryRecords([record("SELECT id FROM parents WHERE flag = 1 AND a IN (SELECT b FROM u WHERE u_id = id)")]),
    );
    expect(findings.find((f) => f.table === "u")?.indexColumns).toEqual(["u_id"]);
  });

  it("never proposes an index for a derived table alias", () => {
    const findings = analyze(
      withSubqueryRecords([
        record(
          "SELECT d.total FROM (SELECT shop_id, SUM(amount) AS total FROM orders GROUP BY shop_id) d WHERE d.total > 10",
        ),
      ]),
    ).findings;
    expect(findings.some((f) => f.table === "d")).toBe(false);
    expect(findings.flatMap((f) => f.suggestedDDL).join()).not.toMatch(/`d`/);
  });

  it("still indexes the physical table behind a derived table", () => {
    const findings = analyze(
      withSubqueryRecords([
        record(
          "SELECT d.cnt FROM (SELECT user_id, COUNT(*) AS cnt FROM order_item WHERE sku_id = 9 GROUP BY user_id) d WHERE d.cnt > 3",
        ),
      ]),
    ).findings;
    const ddl = findings.flatMap((f) => f.suggestedDDL).join(" ");
    expect(ddl).toContain("ALTER TABLE `order_item`");
    expect(ddl).toContain("`sku_id`");
  });

  it("advises the inner side of a correlated IN list, which is the point", () => {
    const findings = analyze(
      withSubqueryRecords([
        record(
          "SELECT id FROM users WHERE level = 1 AND id IN (SELECT user_id FROM order_item WHERE quantity = 0 AND shop_id = 3)",
        ),
      ]),
    ).findings;
    const tables = new Set(findings.map((f) => f.table));
    expect(tables.has("order_item")).toBe(true);
    const inner = findings.find((f) => f.table === "order_item");
    expect(inner!.indexColumns).toEqual(["quantity", "shop_id"]);
  });
});

describe("withSubqueryRecords: bookkeeping", () => {
  it("puts a subquery record behind its parent and inherits its weight", () => {
    const parent: QueryRecord = {
      ...record("SELECT id FROM a WHERE x IN (SELECT y FROM b WHERE z = 1)"),
      occurrences: 12,
      totalQueryTime: 4.5,
      maxRowsExamined: 900,
    };
    const out = withSubqueryRecords([parent, record("SELECT id FROM t WHERE q = 1")]);
    expect(out.map((r) => r.parsed.tables[0]?.name)).toEqual(["a", "b", "t"]);
    expect(out[1]!.occurrences).toBe(12);
    expect(out[1]!.totalQueryTime).toBe(4.5);
    expect(out[1]!.maxRowsExamined).toBe(900);
  });

  it("folds two statements that contain the same body into one record", () => {
    const body = "SELECT y FROM b WHERE z = 1";
    const a = { ...record(`SELECT id FROM a WHERE x IN (${body})`), occurrences: 2 };
    const c = { ...record(`SELECT id FROM c WHERE w IN (${body})`), occurrences: 3 };
    const out = withSubqueryRecords([a, c]);
    const inners = out.filter((r) => r.parsed.subquery);
    expect(inners).toHaveLength(1);
    expect(inners[0]!.occurrences).toBe(5);
  });

  it("gives the body a statement id a reader can trace back", () => {
    const out = withSubqueryRecords([
      { ...record("SELECT id FROM a WHERE x IN (SELECT y FROM b WHERE z = 1)"), statementId: "findByX" },
    ]);
    expect(out[1]!.statementId).toBe("findByX#subquery");
  });

  it("does not expand a record that is itself a body", () => {
    const out = withSubqueryRecords(innerOf("SELECT id FROM a WHERE x IN (SELECT y FROM b WHERE z = 1)"));
    expect(out).toHaveLength(1);
  });

  it("says so when an inline run contains nothing but a subquery body", () => {
    const loaded = loadInput(
      "SELECT d.total FROM (SELECT shop_id, SUM(amount) AS total FROM orders GROUP BY shop_id) d WHERE d.total > 10",
      { inline: true },
    );
    expect(loaded.records.filter((r) => r.parsed.subquery)).toHaveLength(1);
    expect(loaded.notes.some((n) => n.note.includes("派生表"))).toBe(true);
    expect(loaded.notes.some((n) => n.noteEn.includes("derived table"))).toBe(true);
  });

  it("translates every caveat it adds about what it still cannot see", () => {
    const runs = [
      "WITH c AS (SELECT id FROM t WHERE a = 1) SELECT * FROM c",
      "SELECT id FROM t WHERE a = 1 UNION SELECT id FROM u WHERE b = 2",
      "SELECT d.x FROM (SELECT x FROM t WHERE a = 1) d WHERE d.x > 2",
    ];
    for (const sql of runs) {
      const loaded = loadInput(sql, { inline: true });
      expect(loaded.notes.length, sql).toBeGreaterThan(0);
      for (const note of loaded.notes) {
        // An English reader gets the caveat or nothing; a half-translated sentence
        // is the worst of both, which is how `messageEn` once read "no existing
        // index serves this access path" over a Chinese prefix warning.
        expect(note.noteEn, `${sql} -> ${note.noteEn}`).not.toMatch(/[㐀-鿿]/);
      }
    }
    const union = loadInput(runs[1]!, { inline: true });
    expect(union.notes[0]!.noteEn).toContain("only the first UNION branch");
  });
});
