import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  discoverMapperFiles,
  loadMapperFiles,
  mapperStatementsToRecords,
  parseMapperText,
  readMapperFile,
  type MapperStatement,
} from "../src/parsers/mapper.js";

const text = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

function byId(statements: MapperStatement[], id: string): MapperStatement {
  const found = statements.find((s) => s.id === id);
  if (!found) throw new Error(`statement ${id} not found; got ${statements.map((s) => s.id).join(",")}`);
  return found;
}

describe("parseMapperText: statement inventory", () => {
  const source = text("../examples/mapper/UserMapper.xml");
  const statements = parseMapperText(source, "UserMapper.xml");

  it("finds every statement and its namespace", () => {
    expect(statements.map((s) => s.id).sort()).toEqual([
      "batchInsert",
      "countByMobiles",
      "deleteStale",
      "searchByRemark",
      "selectPage",
      "selectShopGmv",
      "updateStatus",
    ]);
    expect(statements[0]?.namespace).toBe("com.example.order.mapper.UserMapper");
  });

  it("reports the line of each statement tag (GitHub Action line comments)", () => {
    for (const stmt of statements) {
      const rawLine = source.split("\n").slice(stmt.line - 1, stmt.line + 1).join("\n");
      expect(rawLine).toContain(`<${stmt.kind} id="${stmt.id}"`);
    }
  });
});

describe("parseMapperText: dynamic SQL", () => {
  const statements = parseMapperText(text("../examples/mapper/UserMapper.xml"), "UserMapper.xml");

  it("expands <choose> branches into separate variants", () => {
    const stmt = byId(statements, "selectPage");
    expect(stmt.variants.length).toBeGreaterThanOrEqual(2);
    expect(stmt.variants.some((v) => /order by u\.create_time desc/i.test(v.sql))).toBe(true);
    expect(stmt.variants.some((v) => /order by u\.id desc/i.test(v.sql))).toBe(true);
  });

  it("keeps <if> predicates so index candidates are not lost", () => {
    const stmt = byId(statements, "selectPage");
    const sql = stmt.variants[0]!.sql;
    expect(sql).toMatch(/u\.level = \?/i);
    expect(sql).toMatch(/a\.city = \?/i);
    expect(sql).toMatch(/u\.create_time >= \?/i);
    expect(sql).toMatch(/\bwhere\b/i);
  });

  it("collapses <foreach> lists to a single placeholder", () => {
    const stmt = byId(statements, "countByMobiles");
    expect(stmt.variants[0]?.sql).toMatch(/in \(\s*\?\s*\)/i);
  });

  it("inlines <include refid>", () => {
    const stmt = byId(statements, "selectPage");
    expect(stmt.variants[0]?.sql).toMatch(/select u\.id, u\.mobile, u\.name, u\.level from users u/i);
  });

  it("turns <set> into a SET clause and trims the trailing comma", () => {
    const stmt = byId(statements, "updateStatus");
    const sql = stmt.variants[0]!.sql;
    expect(sql).toMatch(/\bset\s+status = \?, pay_time = \? where/i);
    expect(sql).not.toMatch(/,\s*where/i);
  });

  it("flags ${} interpolation without breaking the statement", () => {
    const stmt = byId(statements, "searchByRemark");
    expect(stmt.rawInterpolation).toBe(true);
    expect(stmt.variants[0]?.sql).toMatch(/o\.remark = \?/i);
  });

  it("normalises #{} to ? everywhere", () => {
    for (const stmt of statements) {
      for (const variant of stmt.variants) {
        expect(variant.sql).not.toMatch(/[#${]\{/);
      }
    }
  });
});

describe("parseMapperText: entities, CDATA and trim", () => {
  const statements = parseMapperText(text("./fixtures/MapperDyn.xml"), "MapperDyn.xml");

  it("decodes &gt; / &lt; into comparison operators", () => {
    const stmt = byId(statements, "byRange");
    expect(stmt.variants[0]?.sql).toMatch(/create_time > \? AND create_time < \?/);
  });

  it("unwraps CDATA", () => {
    const stmt = byId(statements, "cdata");
    expect(stmt.variants[0]?.sql).toMatch(/amount >= \?/);
    expect(stmt.variants[0]?.sql).not.toContain("CDATA");
  });

  it("applies <trim> prefix and prefixOverrides", () => {
    const stmt = byId(statements, "trimmed");
    expect(stmt.variants[0]?.sql).toMatch(/^UPDATE orders SET/i);
    expect(stmt.variants[0]?.sql).not.toMatch(/SET\s+AND/i);
    expect(stmt.variants[0]?.sql).toMatch(/SET status = \?, amount = \? WHERE id = \?/);
  });

  it("recurses into a <choose> nested inside a <when>", () => {
    const stmt = byId(statements, "nestedChoose");
    const sqls = stmt.variants.map((v) => v.sql);
    // A mutually exclusive branch must never appear merged into one statement.
    expect(sqls.some((s) => /pay_time is not null and pay_time is null/i.test(s))).toBe(false);
    expect(sqls.some((s) => /shop_id = \? and pay_time is not null/i.test(s))).toBe(true);
    expect(sqls.some((s) => /user_id = \?/i.test(s))).toBe(true);
    expect(sqls.every((s) => !/\bwhere\s+(and|or)\b/i.test(s))).toBe(true);
  });
});

describe("mapper records", () => {
  const statements = loadMapperFiles(discoverMapperFiles("examples/mapper"));

  it("produces one QueryRecord per variant with source info", () => {
    const records = mapperStatementsToRecords(
      parseMapperText(text("../examples/mapper/UserMapper.xml"), "UserMapper.xml"),
    );
    expect(records.length).toBeGreaterThan(statements.length);
    const selectPage = records.find((r) => r.statementId?.startsWith("selectPage"));
    expect(selectPage?.source?.file).toBe("UserMapper.xml");
    expect(selectPage?.input).toBe("mapper");
    expect(selectPage?.parsed.fingerprint).toBeTruthy();
  });

  it("marks parameterised LIMIT as non-literal so SIA006 stays quiet", () => {
    const records = mapperStatementsToRecords(
      parseMapperText(text("../examples/mapper/UserMapper.xml"), "UserMapper.xml"),
    );
    const paged = records.find((r) => r.statementId?.startsWith("selectPage"));
    expect(paged?.parsed.limit?.literal).toBe(false);
    const gmv = records.find((r) => r.statementId === "selectShopGmv");
    expect(gmv?.parsed.limit).toMatchObject({ offset: 100000, literal: true });
  });
});

describe("discoverMapperFiles", () => {
  it("only picks files that really contain <mapper>", () => {
    const files = discoverMapperFiles("examples");
    expect(files.filter((f) => f.endsWith("UserMapper.xml"))).toHaveLength(1);
    expect(files.some((f) => f.endsWith("package.json"))).toBe(false);
  });
});

describe("parseMapperText: damage control", () => {
  it("survives truncated and malformed XML", () => {
    expect(() => parseMapperText("<mapper><select id='a'>SELECT 1", "x.xml")).not.toThrow();
    expect(() => parseMapperText("not xml at all", "x.xml")).not.toThrow();
    expect(() => parseMapperText("", "x.xml")).not.toThrow();
    expect(parseMapperText("<mapper></mapper>", "x.xml")).toEqual([]);
  });

  it("reads a file without a byte-order-mark problem", () => {
    expect(() => readMapperFile("examples/mapper/UserMapper.xml")).not.toThrow();
  });
});
