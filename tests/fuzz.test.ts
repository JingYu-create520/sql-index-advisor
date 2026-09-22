import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { QueryRecord, Schema } from "../src/core/types.js";
import { analyze } from "../src/rules/engine.js";
import { parseSql } from "../src/parsers/sql.js";
import { parseSlowLog } from "../src/parsers/slowlog.js";
import { parseMapperText, mapperStatementsToRecords } from "../src/parsers/mapper.js";
import { withSubqueryRecords } from "../src/core/subqueries.js";
import { fingerprint } from "../src/parsers/fingerprint.js";
import { validateSchema } from "../src/schema/loader.js";

/**
 * Adversarial corpus + invariant checks.
 *
 * Hand-written fixtures agree with whatever the parser already assumes, so they
 * cannot find the interesting bugs. This file instead hammers the pipeline with
 * thousands of generated and deliberately nasty statements and asserts properties
 * that must hold for *any* input: never crash, never index a column the query
 * does not mention, never propose two indexes where one covers the other, and be
 * deterministic — which is the whole claim behind "rules, not a black box".
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260921);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length]!;
const some = (p: number): boolean => rnd() < p;

const TABLES = ["orders", "order_item", "users", "user_address", "payments"] as const;
const COLUMNS = [
  "user_id", "shop_id", "status", "amount", "create_time", "pay_time", "order_id",
  "sku_id", "quantity", "city", "level", "mobile", "is_default", "channel", "priority",
] as const;
const OPS = ["=", ">", "<", ">=", "<=", "IN (1,2)", "LIKE 'ab%'", "IS NULL", "BETWEEN 1 AND 9"] as const;

function makeStatement(): string {
  const table = pick(TABLES);
  const alias = some(0.6) ? " t" : "";
  const where: string[] = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i += 1) {
    const col = pick(COLUMNS);
    const qualified = alias && some(0.7) ? `t.${col}` : col;
    where.push(`${qualified} ${pick(OPS)}`);
  }
  // A correlated body of its own, because that is where the two halves of a
  // statement used to meet: the inner table must be examined, and the outer
  // column it correlates on must not end up in the inner index.
  if (some(0.3)) {
    const inner = pick(TABLES);
    const col = pick(COLUMNS);
    const outer = `${alias ? "t." : ""}${pick(COLUMNS)}`;
    where.push(
      some(0.5)
        ? `${outer} IN (SELECT ${col} FROM ${inner} i WHERE i.${pick(COLUMNS)} = ${outer} AND i.${pick(COLUMNS)} > 1)`
        : `EXISTS (SELECT 1 FROM ${inner} i WHERE i.${col} = ${outer} AND i.${pick(COLUMNS)} = ${some(0.5) ? "i." : ""}${pick(COLUMNS)})`,
    );
  }
  const order = some(0.5) ? ` ORDER BY ${pick(COLUMNS)} ${pick(["ASC", "DESC"])}` : "";
  const group = some(0.25) ? ` GROUP BY ${pick(COLUMNS)}` : "";
  const limit = some(0.4)
    ? ` LIMIT ${some(0.3) ? `${100000 + Math.floor(rnd() * 500000)}, 20` : "20"}`
    : "";
  const join = some(0.3)
    ? ` JOIN ${pick(TABLES)} j ON j.${pick(COLUMNS)} = ${alias ? "t." : ""}${pick(COLUMNS)}`
    : "";
  return `SELECT ${some(0.3) ? "*" : `${pick(COLUMNS)}, ${pick(COLUMNS)}`} FROM ${table}${alias}${join} WHERE ${where.join(" AND ")}${group}${order}${limit}`;
}

/** Statements that should be unparseable-but-survivable rather than valid. */
const NASTY: string[] = [
  "",
  "   ",
  ";",
  ";;",
  "SELECT",
  "SELECT * FROM",
  "SELECT * FROM t WHERE",
  "SELECT * FROM t WHERE a = ",
  "SELECT * FROM (SELECT * FROM (SELECT 1 FROM deep) x) y WHERE y.a = 1",
  "SELECT * FROM t WHERE a = 'unterminated",
  'SELECT * FROM t WHERE a = "doubled "" quote"',
  "SELECT * FROM t WHERE a = 1 /* comment /* nested */ still */ AND b = 2",
  "SELECT * FROM t -- trailing\nWHERE a = 1",
  "SELECT * FROM t WHERE a = 1 # hash tail\nAND b = 2",
  "SELECT `weird``col` FROM `my table` WHERE `col x` = 1",
  "SELECT * FROM t1,t2,t3,t4 WHERE t1.a=t2.a AND t2.b=t3.b AND t3.c=t4.c",
  "SELECT a FROM t GROUP BY a HAVING COUNT(*) > 2 AND SUM(x) < 5",
  "WITH c AS (SELECT 1) SELECT * FROM c",
  "SELECT 1 UNION SELECT 2",
  "SELECT * FROM t WHERE a IN (SELECT b FROM u WHERE c = 1) OR d = 2",
  "UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.a = 1 WHERE t2.b = 2",
  "DELETE t1 FROM t1 LEFT JOIN t2 ON t1.id=t2.id WHERE t2.id IS NULL",
  "INSERT INTO t SELECT * FROM u WHERE a = 1",
  "INSERT INTO t (a,b) VALUES (1,2),(3,4)",
  "REPLACE INTO t VALUES (1)",
  "SELECT * FROM t WHERE a = 1 AND (b = 2 OR c = 3) AND d = 4",
  "SELECT * FROM t WHERE NOT (a = 1)",
  "SELECT * FROM t WHERE a <=> 1",
  "SELECT * FROM t FORCE INDEX (idx) WHERE a = 1",
  "SELECT * FROM t WHERE a = 1e999",
  "SELECT * FROM t WHERE a = --\n",
  "SELECT CAST(x AS DECIMAL(10,2)) FROM t WHERE y = 1",
  "SELECT * FROM t WHERE JSON_EXTRACT(meta, '$.a') = 1 AND b = 2",
  "SELECT * FROM t ORDER BY (a + b) DESC, c",
  "SELECT * FROM t LIMIT 5 OFFSET 10 FOR UPDATE",
  "SELECT * FROM t WHERE a = '\\'' AND b = '\\\\'",
  "SELCT * FRM t WHER a 1",
  "SELECT * FROM `orders` WHERE `user_id` IN ()",
  "SELECT * FROM t WHERE a = ?",
  "SELECT * FROM t WHERE a = #{userId} AND b = ${orderBy}",
  "\uFEFFSELECT * FROM t WHERE a = 1",
  "SELECT * FROM t\r\nWHERE a = 1\r\n  AND b = 2",
  "SELECT * FROM t where a=1and b=2",
  "SELECT ((((a)))) FROM t WHERE ((a)) = 1",
];

function corpus(size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < size; i += 1) out.push(makeStatement());
  return out.concat(NASTY);
}

/** A schema over the same tables/columns so the schema-gated rules also run. */
function makeSchema(): Schema {
  const tables = TABLES.map((name, index) => ({
    name,
    engine: "InnoDB",
    charset: "utf8mb4",
    rowCountEstimate: 100000 + index * 1000,
    columns: COLUMNS.map((c) => ({
      name: c,
      type: c === "mobile" || c === "city" || c === "status" || c === "channel" ? "varchar" : c.includes("time") ? "datetime" : c === "is_default" ? "tinyint" : "bigint",
      length: c === "mobile" ? 20 : c === "city" ? 32 : undefined,
      nullable: false,
      charset: "utf8mb4",
    })),
    indexes: [
      { name: "PRIMARY", columns: ["user_id"], primary: true, unique: true },
      ...(index % 2 === 0
        ? [{ name: "idx_a_b", columns: ["shop_id", "status", "create_time"] }]
        : []),
    ],
  }));
  return validateSchema({ mysqlVersion: "8.0.46", tables }).schema!;
}

function toRecord(sql: string, i: number): QueryRecord {
  const parsed = parseSql(sql);
  return {
    fingerprint: parsed.fingerprint,
    sql,
    parsed,
    input: i % 3 === 0 ? "slowlog" : "sql",
    source: { file: "fuzz.sql", line: i + 1 },
    occurrences: 1,
    ...(i % 3 === 0
      ? {
          metrics: { queryTime: 0.5 + (i % 40) / 10, rowsSent: 10, rowsExamined: 1000 + i * 137 },
          totalQueryTime: 0.5 + (i % 40) / 10,
          maxRowsExamined: 1000 + i * 137,
        }
      : {}),
  };
}

/** The same, with the subquery bodies inside it lifted out — what the pipeline runs. */
function toRecords(sql: string, i: number): QueryRecord[] {
  return withSubqueryRecords([toRecord(sql, i)]);
}

const DDL_SHAPE =
  /^ALTER TABLE `[^`]+` ADD (UNIQUE )?INDEX `[^`]+` \(`[^`]+`(?:\(\d+\))?(?:, `[^`]+`(?:\(\d+\))?)*\);$/;

describe("fuzz: the pipeline never dies", () => {
  const statements = corpus(1200);

  it(`parses ${statements.length} statements without throwing`, () => {
    for (const sql of statements) {
      expect(() => parseSql(sql)).not.toThrow();
      expect(() => fingerprint(sql)).not.toThrow();
    }
  });

  it("runs every rule over every statement without throwing", () => {
    const schema = makeSchema();
    const records = statements.flatMap(toRecords);
    expect(() => analyze(records, {})).not.toThrow();
    expect(() => analyze(records, { schema })).not.toThrow();
    expect(() => analyze(records, { schema, minSeverity: "error" })).not.toThrow();
  });

  it("survives garbage fed through the slow-log and mapper readers", () => {
    for (const junk of [...NASTY, "\0\0binary", "<>", "&lt;", "<mapper>", "<select>"]) {
      expect(() => parseSlowLog(junk, "junk.log")).not.toThrow();
      expect(() => parseMapperText(junk, "junk.xml")).not.toThrow();
    }
  });
});

describe("fuzz: emitted advice obeys its own contract", () => {
  const schema = makeSchema();
  // Built once: the generator is stateful, so a second call would differ.
  const statements = corpus(1200);
  const result = analyze(statements.flatMap(toRecords), { schema });

  it("only ever emits ADD INDEX as executable DDL", () => {
    const ddls = result.findings.flatMap((f) => f.suggestedDDL);
    expect(ddls.length).toBeGreaterThan(0);
    for (const ddl of ddls) {
      expect(ddl).toMatch(DDL_SHAPE);
      expect(ddl).not.toMatch(/\bDROP\b/i);
    }
  });

  it("never invents a column", () => {
    // Two different guarantees, because two different mechanisms:
    //  - SIA001/002 derive columns from the query, so each must appear in it.
    //    This is what catches the alias class of false positive (ORDER BY gmv
    //    where gmv is `SUM(x) AS gmv`).
    //  - SIA003/007 extend or repair an *existing* index, so their column list
    //    legitimately contains columns the query never mentions; those must
    //    nevertheless exist in the table.
    let fromQuery = 0;
    let fromSchema = 0;
    for (const [i, sql] of statements.entries()) {
      const findings = analyze(toRecords(sql, i), { schema }).findings;
      for (const f of findings) {
        const cols = f.indexColumns ?? [];
        if (cols.length === 0) continue;
        if (f.rule === "SIA001" || f.rule === "SIA002") {
          for (const col of cols) {
            expect(sql.toLowerCase(), `${col} not in ${sql}`).toContain(col.toLowerCase());
            fromQuery += 1;
          }
        }
        // The schema only describes the generated tables; statements over `t`
        // from the nasty list cannot be checked this way.
        const table = schema.tables.find((x) => x.name === f.table?.toLowerCase());
        if (!table) continue;
        for (const col of cols) {
          expect(
            table.columns.some((c) => c.name === col.toLowerCase()),
            `${f.table}.${col} is not a real column; query: ${sql}`,
          ).toBe(true);
          fromSchema += 1;
        }
      }
    }
    // Non-vacuous: both guards above must have run on real advice.
    expect(fromQuery).toBeGreaterThan(50);
    expect(fromSchema).toBeGreaterThan(50);
  });

  it("never advises a table that no statement named", () => {
    // Subqueries are parsed as their own statements now, so a derived table's
    // alias (`FROM (SELECT ...) d`) is one step from being mistaken for a
    // physical table — and `ALTER TABLE d` is the kind of wrong output that gets
    // run by somebody who trusts the tool.
    const named = new Set(
      statements.flatMap(toRecords).flatMap((r) => r.parsed.tables.map((t) => t.name.toLowerCase())),
    );
    for (const f of result.findings) {
      if (f.suggestedDDL.length === 0) continue;
      expect(named, `${f.table} was never a table in the run`).toContain(f.table!.toLowerCase());
    }
  });

  it("never proposes two indexes where one already covers the other", () => {
    const withCols = result.findings.filter((f) => (f.indexColumns?.length ?? 0) > 0);
    for (const a of withCols) {
      for (const b of withCols) {
        if (a === b || a.table !== b.table) continue;
        const x = a.indexColumns!;
        const y = b.indexColumns!;
        if (x.length >= y.length) continue;
        const isPrefix = y.slice(0, x.length).join(",") === x.join(",");
        expect(isPrefix, `${x.join(",")} is a prefix of ${y.join(",")} on ${a.table}`).toBe(false);
      }
    }
  });

  it("never proposes the same set of columns twice in a different order", () => {
    const seen = new Map<string, string>();
    for (const f of result.findings.filter((x) => (x.indexColumns?.length ?? 0) > 0)) {
      const key = [f.table, [...f.indexColumns!].sort().join(",")].join("::");
      const previous = seen.get(key);
      expect(
        previous,
        `${f.indexColumns!.join(",")} on ${f.table} repeats ${previous ?? ""} as a permutation`,
      ).toBeUndefined();
      seen.set(key, f.indexColumns!.join(","));
    }
  });

  it("reports every finding with the fields a reviewer needs", () => {
    for (const f of result.findings) {
      expect(["error", "warn", "info"]).toContain(f.severity);
      expect(f.rule).toMatch(/^SIA00[1-7]$/);
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.messageEn.length).toBeGreaterThan(5);
      expect(f.needsSchema).toBeTypeOf("boolean");
      expect(f.needsMetrics).toBeTypeOf("boolean");
      if (f.needsSchema) expect(schema).toBeDefined();
      if (f.rule === "SIA007") expect(f.rowsExamined).toBeTypeOf("number");
    }
  });
});

describe("fuzz: determinism, which is the actual product claim", () => {
  const statements = corpus(400);

  it("the same input analysed twice is byte-identical", () => {
    const schema = makeSchema();
    const a = analyze(statements.flatMap(toRecords), { schema });
    const b = analyze(statements.flatMap(toRecords), { schema });
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
    expect(JSON.stringify(a.skipped)).toBe(JSON.stringify(b.skipped));
  });

  it("changing only literals keeps the fingerprint and the finding identical", () => {
    const base = "SELECT id FROM orders WHERE user_id = 1 AND status = 'PAID' ORDER BY create_time DESC LIMIT 20";
    const variants = [
      base,
      "SELECT id FROM orders WHERE user_id = 99999 AND status = 'NEW' ORDER BY create_time DESC LIMIT 20",
      "select  id  from  orders  where  user_id=7  and  status='REFUND'  order by create_time desc  limit 20",
      "SELECT id FROM orders WHERE user_id = -3 AND status = '' ORDER BY create_time DESC LIMIT 20;",
    ];
    const fps = new Set(variants.map((v) => fingerprint(v)));
    expect(fps.size).toBe(1);

    const schema = makeSchema();
    const outputs = variants.map((v) => analyze([toRecord(v, 1)], { schema }).findings.map((f) => f.suggestedDDL));
    expect(new Set(outputs.map((o) => JSON.stringify(o))).size).toBe(1);
  });
});

describe("fuzz: provenance survives", () => {
  it("mapper findings keep a usable line number per variant", () => {
    const xml = readFileSync("tests/fixtures/MapperDyn.xml", "utf8");
    const records = mapperStatementsToRecords(parseMapperText(xml, "MapperDyn.xml"));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.source?.line ?? 0).toBeGreaterThan(0);
      expect(record.source?.file).toBe("MapperDyn.xml");
    }
  });

  it("slow-log findings keep a line number inside the file", () => {
    const log = readFileSync("tests/fixtures/slow-80.log", "utf8");
    const parsed = parseSlowLog(log, "slow-80.log");
    for (const record of parsed.records) {
      expect(record.source!.line).toBeGreaterThan(0);
      expect(record.source!.line).toBeLessThanOrEqual(log.split("\n").length);
    }
  });
});
