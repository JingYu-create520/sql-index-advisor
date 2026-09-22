import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadInput } from "../src/core/input.js";
import { runPipeline } from "../src/core/pipeline.js";
import { renderTerminal } from "../src/report/terminal.js";
import { buildJsonReport, renderJson } from "../src/report/json.js";
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

  it("the mapper directory yields 8 statements, plus the body of its subquery", () => {
    const statements = loadMapperFiles(discoverMapperFiles("examples/mapper"));
    const records = mapperStatementsToRecords(statements);
    expect(records).toHaveLength(9);
    expect(statements).toHaveLength(7);
    expect(records.filter((r) => r.statementId?.startsWith("selectPage"))).toHaveLength(3);
    expect(records.find((r) => r.statementId === "searchByRemark")?.rawInterpolation).toBe(true);
    // The EXISTS body inside selectPage is analysed as a statement of its own, so
    // the table behind it gets a verdict instead of a caveat.
    const lifted = records.find((r) => r.parsed.subquery);
    expect(lifted?.parsed.tables.map((t) => t.name)).toEqual(["user_address"]);
    expect(lifted?.source?.line ?? 0).toBeGreaterThan(0);
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

/**
 * The promise the whole tool is built on: silence is only ever produced by
 * something, and the report has to name that something. Two real cases, both
 * from running this over other people's projects.
 */
describe("an empty report still says why", () => {
  it("a directory with no mappers is not reported as a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sia-empty-"));
    try {
      const { loaded, result } = await runPipeline(dir, { loadKind: "mapper" });
      expect(result.findings).toEqual([]);
      expect(loaded.notes).toHaveLength(1);
      expect(loaded.notes[0]?.note).toContain("没有找到");
      const report = renderTerminal(result, { lang: "zh" });
      expect(report).toContain("!");
      // The green check is a claim of cleanliness; this run has none.
      expect(report).not.toContain("✓");
      const json = JSON.parse(renderJson(buildJsonReport(result, dir)));
      expect(json.notes[0].noteEn).toContain("No <mapper> XML files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("predicates that only exist at runtime are counted, not passed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sia-dyn-"));
    try {
      writeFileSync(
        join(dir, "Item.xml"),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<!DOCTYPE mapper PUBLIC \"-//mybatis.org//DTD Mapper 3.0//EN\" \"http://mybatis.org/dtd/mybatis-3-mapper.dtd\">",
          '<mapper namespace="x.Item">',
          '  <select id="list" resultType="map">select id, name from tb_item where ${criterion.condition}</select>',
          '  <select id="byShop" resultType="map">select id from tb_item where shop_id = #{shopId}</select>',
          "</mapper>",
        ].join("\n"),
      );
      const loaded = loadInput(dir, { kind: "mapper" });
      expect(loaded.notes.map((n) => n.note).join(" ")).toContain("1 条语句");
      expect(loaded.notes.map((n) => n.noteEn).join(" ")).toContain("unrecognised predicate skipped");
      // and the analysable statement is still analysed
      expect(loaded.records).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
