import { describe, expect, it } from "vitest";

import { evidence, fingerprint, maskLiterals, stripComments } from "../src/parsers/fingerprint.js";

describe("stripComments", () => {
  it("removes block and line comments", () => {
    const sql = "SELECT 1 /* inline */ FROM t -- trailing\nWHERE a = 1 # hash";
    expect(stripComments(sql)).not.toMatch(/inline|trailing|hash/);
  });

  it("leaves comment markers inside string literals alone", () => {
    const sql = "SELECT 'a /* not a comment */ b' FROM t";
    expect(stripComments(sql)).toContain("/* not a comment */");
  });
});

describe("maskLiterals", () => {
  it("masks quoted strings including doubled-quote escapes", () => {
    expect(maskLiterals("WHERE name = 'O''Brien' AND city = \"杭州\"")).toBe(
      "WHERE name = ? AND city = ?",
    );
  });

  it("masks integers, decimals and scientific notation", () => {
    expect(maskLiterals("WHERE a = 42 AND b = 3.14 AND c = 1e10 AND d = .5")).toBe(
      "WHERE a = ? AND b = ? AND c = ? AND d = ?",
    );
  });

  it("does not mask digits glued into identifiers", () => {
    expect(maskLiterals("SELECT t1.amount2 FROM tbl_2024 t1")).toBe(
      "SELECT t1.amount2 FROM tbl_2024 t1",
    );
  });
});

describe("fingerprint", () => {
  it("collapses different literals of the same shape into one key", () => {
    const a = "SELECT * FROM orders WHERE user_id = 42 AND status = 'PAID' LIMIT 20;";
    const b = "select   *  from orders where user_id=7 and status='NEW'  limit 20";
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("treats an IN list of any length as one pattern", () => {
    const short = "SELECT id FROM t WHERE a IN (1, 2)";
    const long = "SELECT id FROM t WHERE a IN (1,2,3,4,5,6,7,8,9,10)";
    expect(fingerprint(short)).toBe(fingerprint(long));
    expect(fingerprint(short)).toContain("in(?)");
  });

  it("treats a negative literal as one value, not an operator plus a number", () => {
    // Found by the fuzz suite: `x = -3` masked to `x=-?` while `x = 3` gave `x=?`,
    // which split one query pattern into two fingerprints and broke aggregation.
    const positive = "SELECT id FROM t WHERE a = 3 AND b = 12";
    const negative = "SELECT id FROM t WHERE a = -3 AND b = -12";
    expect(fingerprint(positive)).toBe(fingerprint(negative));
    expect(fingerprint(negative)).toContain("a=?");

    expect(maskLiterals("WHERE a = -3.5 AND b IN (-1, -2)")).toBe("WHERE a = ? AND b IN (?, ?)");
  });

  it("keeps arithmetic visible instead of folding it into an equality", () => {
    // `1` and `5` are literals and do get masked; the point is that the minus
    // survives, so `a - 1 = 5` never collapses onto `a = 5`.
    expect(fingerprint("SELECT id FROM t WHERE a - 1 = 5")).toBe(
      fingerprint("SELECT id FROM t WHERE a - 9 = 12"),
    );
    expect(fingerprint("SELECT id FROM t WHERE a - 1 = 5")).not.toBe(
      fingerprint("SELECT id FROM t WHERE a = 5"),
    );
  });

  it("handles signed exponents and negative column aliases in IN lists", () => {
    expect(fingerprint("SELECT id FROM t WHERE a IN (1e3, -2.5, +7)")).toBe(
      fingerprint("SELECT id FROM t WHERE a IN (9, -88, 1e9)"),
    );
  });
  it("keeps structurally different queries apart", () => {
    expect(fingerprint("SELECT id FROM t WHERE a = 1")).not.toBe(
      fingerprint("SELECT id FROM t WHERE b = 1"),
    );
  });
});

describe("evidence", () => {
  it("collapses whitespace and truncates long statements", () => {
    const long = `SELECT ${"a,".repeat(200)} b FROM t`;
    const out = evidence(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });
});
