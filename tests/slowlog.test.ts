import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseSlowLog } from "../src/parsers/slowlog.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("parseSlowLog: MySQL 8.0 basic format", () => {
  const result = parseSlowLog(fixture("slow-80.log"), "slow-80.log");

  it("aggregates repeated patterns into one record", () => {
    expect(result.totalEvents).toBe(3);
    expect(result.records).toHaveLength(2);
  });

  it("sums cost and counts occurrences per fingerprint", () => {
    const [top] = result.records;
    expect(top?.occurrences).toBe(2);
    expect(top?.totalQueryTime).toBeCloseTo(4, 5);
    expect(top?.maxRowsExamined).toBe(200000);
    expect(top?.metrics?.queryTime).toBeCloseTo(2.5, 5);
  });

  it("ranks by total time, not by raw log order", () => {
    expect(result.records[0]?.fingerprint).toContain("products");
    expect(result.records[1]?.fingerprint).toContain("brand_name");
  });

  it("keeps the line number of the first SQL line", () => {
    expect(result.records[0]?.source).toMatchObject({ file: "slow-80.log", line: 8 });
  });

  it("parses the statement, not just the header", () => {
    const parsed = result.records[0]!.parsed;
    expect(parsed.tables[0]?.name).toBe("products");
    expect(parsed.columns.map((c) => c.column)).toEqual(["category_id"]);
    expect(parsed.orderBy[0]).toMatchObject({ column: "score", desc: true });
    expect(parsed.limit).toMatchObject({ rowCount: 10, literal: true });
  });
});

describe("parseSlowLog: blocks without # Time:", () => {
  const result = parseSlowLog(fixture("slow-no-time.log"), "slow-no-time.log");

  it("still splits events on # User@Host and ignores use/SET noise", () => {
    expect(result.totalEvents).toBe(3);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.parsed.kind)).toEqual(["select", "update"]);
  });

  it("collapses the two identical cart queries", () => {
    const carts = result.records.find((r) => r.parsed.tables[0]?.name === "carts");
    expect(carts?.occurrences).toBe(2);
    expect(carts?.totalQueryTime).toBeCloseTo(7.1, 5);
  });
});

describe("parseSlowLog: messy real-world log", () => {
  const result = parseSlowLog(fixture("slow-messy.log"), "slow-messy.log");

  it("drops administrator commands and never throws", () => {
    expect(result.records.every((r) => !r.sql.includes("administrator"))).toBe(true);
    expect(result.ignoredEvents).toBeGreaterThan(0);
  });

  it("joins multi-line statements and reads deep literal offsets (SIA006 input)", () => {
    const heavy = result.records.find((r) => r.sql.includes("order_item"));
    expect(heavy?.parsed.limit).toMatchObject({ offset: 500000, rowCount: 20, literal: true });
    expect(heavy?.parsed.columns.filter((c) => c.scope === "join-on").map((c) => c.column)).toEqual([
      "order_id",
      "id",
    ]);
  });

  it("keeps an unterminated trailing statement as a degraded record", () => {
    const broken = result.records.find((r) => r.sql.includes("broken"));
    expect(broken).toBeDefined();
    expect(broken?.parsed.kind).toBe("select");
  });
});

describe("parseSlowLog: snapshot", () => {
  it("locks the aggregated shape", () => {
    expect(
      parseSlowLog(fixture("slow-80.log"), "slow-80.log").records.map((r) => ({
        fp: r.fingerprint,
        occurrences: r.occurrences,
        total: r.totalQueryTime,
        line: r.source?.line,
        tables: r.parsed.tables,
      })),
    ).toMatchSnapshot();
  });
});
