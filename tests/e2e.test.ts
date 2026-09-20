import { describe, expect, it } from "vitest";

import { loadInput } from "../src/core/input.js";
import { parseSlowLog } from "../src/parsers/slowlog.js";
import { discoverMapperFiles, loadMapperFiles, mapperStatementsToRecords } from "../src/parsers/mapper.js";

/**
 * End-to-end over the shipped examples. This is the M1 acceptance gate:
 * "CLI 能列出输入文件里的所有 SQL". If these numbers move, either the examples
 * changed on purpose or a parser regressed.
 */
describe("examples inventory", () => {
  it("slow.log yields 5 fingerprinted patterns ranked by total cost", () => {
    const { records } = loadInput("examples/slow.log");
    expect(records).toHaveLength(5);
    // The two `orders o` events share a fingerprint and merge into rank 2
    // (3.217 + 2.998 = 6.215s), behind the single 7.441s report query.
    const merged = records.find((r) => r.parsed.tables[0]?.name === "orders" && r.occurrences === 2);
    expect(merged?.totalQueryTime).toBeCloseTo(3.217443 + 2.99812, 6);
    expect(records.map((r) => r.parsed.tables[0]?.name)).toEqual([
      "orders",
      "orders",
      "users",
      "orders",
      "order_item",
    ]);
    expect(records[0]?.totalQueryTime).toBeGreaterThan(records[4]?.totalQueryTime ?? 0);
  });

  it("every slow.log record carries a usable line number", () => {
    const { records } = loadInput("examples/slow.log");
    expect(records.every((r) => (r.source?.line ?? 0) > 0)).toBe(true);
  });

  it("the mapper directory yields 8 statements including both <choose> branches", () => {
    const statements = loadMapperFiles(discoverMapperFiles("examples/mapper"));
    const records = mapperStatementsToRecords(statements);
    expect(records).toHaveLength(8);
    expect(statements).toHaveLength(7);
    expect(records.filter((r) => r.statementId?.startsWith("selectPage"))).toHaveLength(2);
    expect(records.find((r) => r.statementId === "searchByRemark")?.rawInterpolation).toBe(true);
  });

  it("inline SQL produces exactly one record", () => {
    const { records } = loadInput("SELECT id FROM t WHERE a = 1");
    expect(records).toHaveLength(1);
    expect(records[0]?.input).toBe("sql");
  });

  it("locks the example slow log as a golden sample", () => {
    const { records } = parseSlowLog(
      // A trimmed real-shape log: one repeated pattern plus one unique one.
      `# Time: 2026-09-20T01:00:00.000000Z
# User@Host: app[app] @ 10.0.0.1 [10.0.0.1]  Id: 1
# Query_time: 2.000000  Lock_time: 0.000000 Rows_sent: 1  Rows_examined: 100
SET timestamp=1758330000;
SELECT id FROM t WHERE a = 1;
# Time: 2026-09-20T01:00:05.000000Z
# User@Host: app[app] @ 10.0.0.1 [10.0.0.1]  Id: 2
# Query_time: 1.000000  Lock_time: 0.000000 Rows_sent: 1  Rows_examined: 50
SET timestamp=1758330005;
SELECT id FROM t WHERE a = 2;
`,
      "golden.log",
    );

    expect(records).toMatchObject([
      {
        occurrences: 2,
        totalQueryTime: 3,
        maxRowsExamined: 100,
        parsed: { tables: [{ name: "t" }], kind: "select" },
      },
    ]);
  });
});
