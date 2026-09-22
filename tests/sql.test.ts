import { describe, expect, it } from "vitest";

import { parseSql, resolveTable } from "../src/parsers/sql.js";

function cols(sql: string, scope: string): string[] {
  const parsed = parseSql(sql);
  const all = [...parsed.columns, ...parsed.orderBy, ...parsed.groupBy];
  return all.filter((c) => c.scope === scope).map((c) => c.column);
}

describe("parseSql: tables and aliases", () => {
  it("reads a qualified table with an alias", () => {
    const parsed = parseSql("SELECT o.* FROM orders o WHERE o.user_id = 1");
    expect(parsed.tables).toEqual([{ name: "orders", alias: "o", role: "FROM" }]);
    expect(resolveTable(parsed.columns[0]!, parsed)).toBe("orders");
  });

  it("reads comma joins and ANSI joins", () => {
    const parsed = parseSql(
      "SELECT 1 FROM users u LEFT JOIN user_address a ON a.user_id = u.id, orders o WHERE o.uid = u.id",
    );
    expect(parsed.tables.map((t) => t.name)).toEqual(["users", "user_address", "orders"]);
    expect(parsed.tables[1]?.role).toBe("LEFT JOIN");
  });

  it("strips backticks and schema qualifiers", () => {
    const parsed = parseSql("SELECT `id` FROM `shop`.`orders` `o` WHERE o.`user_id` = 1");
    expect(parsed.tables[0]?.name).toBe("orders");
    expect(parsed.tables[0]?.alias).toBe("o");
    expect(cols("SELECT id FROM shop.orders o WHERE o.user_id = 1", "where-eq")).toEqual(["user_id"]);
  });
});

describe("parseSql: predicates", () => {
  it("classifies equality, IN, range, LIKE and IS NULL", () => {
    const sql =
      "SELECT id FROM t WHERE a = 1 AND b IN (1,2,3) AND c > 5 AND d <= 9 AND e LIKE 'pre%' AND f IS NULL";
    const parsed = parseSql(sql);
    expect(cols(sql, "where-eq")).toEqual(["a"]);
    expect(cols(sql, "where-in")).toEqual(["b"]);
    expect(cols(sql, "where-range")).toEqual(["c", "d"]);
    expect(cols(sql, "where-like-prefix")).toEqual(["e"]);
    expect(cols(sql, "where-null")).toEqual(["f"]);
    const like = parsed.columns.find((c) => c.column === "e");
    expect(like?.op).toBe("like-prefix");
  });

  it("marks a middle-wildcard LIKE as not prefix-searchable", () => {
    const parsed = parseSql("SELECT id FROM t WHERE remark LIKE '%kw%'");
    expect(parsed.columns[0]?.op).toBe("like-middle");
  });

  it("does not split the AND that belongs to BETWEEN", () => {
    const parsed = parseSql(
      "SELECT id FROM t WHERE create_time BETWEEN '2026-09-01' AND '2026-09-08' AND status = 'PAID'",
    );
    expect(cols("SELECT id FROM t WHERE create_time BETWEEN 'a' AND 'b' AND status = 'PAID'", "where-eq")).toEqual([
      "status",
    ]);
    expect(parsed.columns.some((c) => c.column === "create_time" && c.op === "between")).toBe(true);
  });

  it("records both sides of a join-style equality", () => {
    const parsed = parseSql("SELECT 1 FROM orders o WHERE o.user_id = u.id");
    expect(parsed.columns.map((c) => c.column)).toEqual(["user_id", "id"]);
  });

  it("flags functions applied to a column (SIA004 input)", () => {
    const parsed = parseSql("SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'");
    const ref = parsed.columns[0];
    expect(ref?.column).toBe("create_time");
    expect(ref?.wrapped).toBe(true);
  });

  it("flags arithmetic on a column", () => {
    const parsed = parseSql("SELECT id FROM t WHERE amount + 0 > 10");
    expect(parsed.columns[0]?.wrapped).toBe(true);
  });

  it("knows when a predicate is parameterised", () => {
    const parsed = parseSql("SELECT id FROM t WHERE a = ? AND b = 1");
    const a = parsed.columns.find((c) => c.column === "a");
    const b = parsed.columns.find((c) => c.column === "b");
    expect(a?.parameterized).toBe(true);
    expect(b?.parameterized).toBe(false);
  });

  it("handles an IN subquery without swallowing the list", () => {
    const parsed = parseSql(
      "SELECT COUNT(*) FROM order_item WHERE order_id IN (SELECT id FROM orders WHERE user_id = 1)",
    );
    expect(parsed.columns[0]?.op).toBe("in-subquery");
  });
});

describe("parseSql: projection, ordering, paging", () => {
  it("detects SELECT * and named columns", () => {
    expect(parseSql("SELECT * FROM t").selectStar).toBe(true);
    expect(parseSql("SELECT u.id, mobile FROM t u").selectColumns).toEqual(["id", "mobile"]);
    expect(parseSql("SELECT o.id FROM orders o").selectColumns).toEqual(["id"]);
  });

  it("keeps ORDER BY direction", () => {
    const parsed = parseSql("SELECT id FROM t ORDER BY create_time DESC, id ASC");
    expect(parsed.orderBy.map((o) => [o.column, o.desc])).toEqual([
      ["create_time", true],
      ["id", false],
    ]);
  });

  it("reads GROUP BY", () => {
    expect(cols("SELECT shop_id FROM t GROUP BY shop_id HAVING COUNT(*) > 2", "group-by")).toEqual([
      "shop_id",
    ]);
  });

  it("distinguishes LIMIT n from LIMIT offset, n", () => {
    const plain = parseSql("SELECT id FROM t LIMIT 20").limit;
    expect(plain).toMatchObject({ rowCount: 20, literal: true });
    expect(plain?.offset).toBeUndefined();

    expect(parseSql("SELECT id FROM t LIMIT 100000, 20").limit).toMatchObject({
      offset: 100000,
      rowCount: 20,
      literal: true,
    });
    expect(parseSql("SELECT id FROM t LIMIT 20 OFFSET 40").limit).toMatchObject({
      offset: 40,
      rowCount: 20,
      literal: true,
    });
  });

  it("reports a parameterised LIMIT as non-literal (SIA006 must not fire)", () => {
    expect(parseSql("SELECT id FROM t LIMIT ?, ?").limit).toMatchObject({ literal: false });
  });
});

describe("parseSql: other statement kinds", () => {
  it("reads UPDATE SET targets and its WHERE", () => {
    const parsed = parseSql("UPDATE orders SET status = ?, pay_time = NOW() WHERE id = ? AND user_id = ?");
    expect(parsed.kind).toBe("update");
    expect(cols("UPDATE orders SET status = ?, pay_time = NOW() WHERE id = ? AND user_id = ?", "set")).toEqual([
      "status",
      "pay_time",
    ]);
    expect(parsed.tables[0]?.name).toBe("orders");
  });

  it("reads DELETE FROM ... WHERE", () => {
    const parsed = parseSql("DELETE FROM order_item WHERE order_id = 1 AND quantity = 0");
    expect(parsed.kind).toBe("delete");
    expect(parsed.tables[0]?.name).toBe("order_item");
    expect(cols("DELETE FROM order_item WHERE order_id = 1 AND quantity = 0", "where-eq")).toEqual([
      "order_id",
      "quantity",
    ]);
  });

  it("reads INSERT column list", () => {
    const parsed = parseSql("INSERT INTO order_item (order_id, sku_id) VALUES (1, 2)");
    expect(parsed.tables[0]?.name).toBe("order_item");
    expect(parsed.notes.join(" ")).toContain("INSERT");
  });
});

describe("parseSql: SELECT aliases", () => {
  it("records both explicit and implicit aliases", () => {
    expect(parseSql("SELECT SUM(amount) AS gmv, COUNT(*) total FROM t").selectAliases).toEqual([
      "gmv",
      "total",
    ]);
  });

  it("keeps aliases out of the projection column list", () => {
    const parsed = parseSql("SELECT SUM(amount) AS gmv FROM t GROUP BY shop_id ORDER BY gmv DESC");
    expect(parsed.selectColumns).toEqual([]);
    expect(parsed.orderBy.map((o) => o.column)).toEqual(["gmv"]);
    expect(parsed.groupBy.map((g) => g.column)).toEqual(["shop_id"]);
  });
});

describe("parseSql: graceful degradation", () => {
  const junk = [
    "",
    "   ",
    "not sql at all",
    "SELEC * FRM t WHRE a = 1",
    "SELECT * FROM (SELECT 1) x WHERE",
    "INSERT INTO t VALUES (1),(2),(3)",
    "SELECT * FROM t WHERE a = 'unterminated",
    "CREATE INDEX i ON t (a)",
    "WITH cte AS (SELECT 1) SELECT * FROM cte",
    "((((",
  ];

  it("never throws, whatever comes in", () => {
    for (const input of junk) {
      expect(() => parseSql(input)).not.toThrow();
      const parsed = parseSql(input);
      expect(Array.isArray(parsed.notes)).toBe(true);
      expect(typeof parsed.fingerprint).toBe("string");
    }
  });

  it("records a note when something is outside the supported subset", () => {
    expect(parseSql("CREATE INDEX i ON t (a)").notes.length).toBeGreaterThan(0);
  });
});

describe("parseSql: snapshot", () => {
  it("locks the shape of a representative order-listing query", () => {
    expect(
      parseSql(
        "SELECT o.* FROM orders o WHERE o.user_id = 42 AND o.status = 'PAID' AND o.amount > 100 ORDER BY o.create_time DESC LIMIT 20",
      ),
    ).toMatchSnapshot();
  });
});

/**
 * Parenthesised condition groups used to be opaque: their inner tokens sit at
 * depth 1, so the AND/OR split helpers never saw them and every
 * `AND (a = ? OR b = ?)` in a MyBatis <where> block came back as an unrecognised
 * predicate. An OR over different columns is also not one access path, and an OR
 * over the same column is an IN list.
 */
describe("parseSql: parenthesised groups and OR", () => {
  const cols = (sql: string) => parseSql(sql).columns.map((c) => c.column + ":" + c.scope);

  it("reads a bracketed conjunction", () => {
    expect(cols("SELECT id FROM t WHERE (a = 1 AND b = 2) AND c = 3")).toEqual([
      "a:where-eq",
      "b:where-eq",
      "c:where-eq",
    ]);
  });

  it("folds an OR over one column into an IN list", () => {
    expect(cols("SELECT id FROM t WHERE (status = 1 OR status = 2)")).toEqual(["status:where-in"]);
    expect(parseSql("SELECT id FROM t WHERE (status = 1 OR status = 2)").notes).toEqual([]);
  });

  it("keeps an OR over different columns as branches, next to the AND-ed parts", () => {
    expect(cols("SELECT id FROM t WHERE a = 1 AND (status = 1 OR status = 2)")).toEqual([
      "a:where-eq",
      "status:where-in",
    ]);
    expect(cols("SELECT id FROM t WHERE a = 1 OR b = 2")).toEqual(["a:where-or", "b:where-or"]);
  });

  it("never invents a column from an OR branch", () => {
    const parsed = parseSql("SELECT id FROM t WHERE a = 1 OR b = 2");
    expect(parsed.columns.every((c) => c.column === "a" || c.column === "b")).toBe(true);
    expect(parsed.notes.join(" ")).toContain("OR");
  });
});
