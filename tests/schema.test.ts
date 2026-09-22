import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  columnKeyBytes,
  describeIndexParts,
  findColumn,
  findTable,
  hasUsablePrefix,
  onlyPlainParts,
  validateSchema,
} from "../src/schema/loader.js";
import type { SchemaIndex } from "../src/core/types.js";
import { loadInput } from "../src/core/input.js";

const valid = {
  mysqlVersion: "8.0.36",
  tables: [
    {
      name: "Orders",
      columns: [
        { name: "id", type: "bigint", nullable: false },
        { name: "remark", type: "varchar", length: 1000, charset: "utf8mb4" },
        { name: "note", type: "text" },
      ],
      indexes: [
        { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
        { name: "idx_user_time", columns: ["user_id", "create_time"] },
      ],
    },
  ],
};

describe("validateSchema: the real schema-dump.sql output", () => {
  it("accepts the explicit nulls information_schema produces", () => {
    // Regression, found only by running schema-dump.sql against a live MySQL 8:
    // every non-string column comes back as "length": null / "charset": null,
    // and `.optional()` rejects an explicit null. Our own dump failed our own
    // loader, so the documented quickstart could not have worked.
    const doc = JSON.parse(readFileSync("tests/fixtures/schema-live-dump.json", "utf8"));
    const { schema, errors } = validateSchema(doc);
    expect(errors).toEqual([]);

    const orders = findTable(schema, "orders");
    expect(orders?.columns.find((c) => c.name === "id")).toMatchObject({
      type: "bigint",
      length: undefined,
      charset: undefined,
    });
    expect(orders?.columns.find((c) => c.name === "status")).toMatchObject({
      type: "varchar",
      length: 16,
    });
    expect(orders?.indexes.map((i) => i.name)).toContain("idx_user_pay");
    expect(schema?.mysqlVersion).toMatch(/^8\./);
  });

  it("still computes byte budgets for columns the dump left unqualified", () => {
    const doc = JSON.parse(readFileSync("tests/fixtures/schema-live-dump.json", "utf8"));
    const table = findTable(validateSchema(doc).schema, "orders");
    const remark = findColumn(table, "remark");
    expect(columnKeyBytes(remark!)).toBe(Infinity);
    const orderId = findColumn(findTable(validateSchema(doc).schema, "order_item"), "order_id");
    expect(columnKeyBytes(orderId!)).toBe(8);
  });
});

describe("a functional index does not poison the file", () => {
  // Dumped by examples/schema-dump.sql from a live MySQL 8.0.46 whose table carries
  // `CREATE INDEX idx_ct ON orders ((DATE(create_time)))` and a multi-valued
  // `CAST(tags AS CHAR(64) ARRAY)` index. Both report `COLUMN_NAME = NULL`, which
  // the loader used to reject outright - and SIA004 is the rule that tells people to
  // create a functional index, so following the advice broke the next run.
  const doc = JSON.parse(readFileSync("tests/fixtures/schema-functional.json", "utf8"));

  it("loads, and keeps the null key part rather than dropping it", () => {
    const { schema, errors } = validateSchema(doc);
    expect(errors).toEqual([]);
    const orders = findTable(schema, "orders");
    const functional = orders?.indexes.find((i) => i.name === "idx_ct");
    expect(functional?.columns).toEqual([null]);
    // A dropped null would have read as an index with no parts, and one shortened
    // prefix would let a rule claim coverage the server does not give.
    expect(orders?.indexes.find((i) => i.name === "idx_user_status")?.columns).toEqual([
      "user_id",
      "status",
    ]);
  });

  it("treats an expression part as serving no column lookup", () => {
    const orders = findTable(validateSchema(doc).schema, "orders");
    // `DATE(create_time)` is not an index on `create_time`.
    expect(hasUsablePrefix(orders, ["create_time"])).toBeUndefined();
    // idx_mixed(user_id, UPPER(status)) is hit first, and it is a fair hit: its
    // *first* key part is the column the query filters on. An expression part only
    // breaks coverage from its own position onwards.
    expect(hasUsablePrefix(orders, ["user_id"])?.name).toBe("idx_mixed");
    expect(hasUsablePrefix(orders, ["user_id", "status"])?.name).toBe("idx_user_status");
    expect(orders!.indexes.filter(onlyPlainParts).map((i) => i.name)).toEqual([
      "ft_status",
      "idx_user_status",
      "PRIMARY",
    ]);
  });

  it("prints an expression part as one, never as the word null", () => {
    const functional: SchemaIndex = { name: "idx_ct", columns: [null] };
    const mixed: SchemaIndex = { name: "idx_mix", columns: ["user_id", null] };
    expect(describeIndexParts(functional, "en")).toBe("(expression)");
    expect(describeIndexParts(mixed, "zh")).toBe("user_id, 〈表达式〉");
    // An index this narrow is what the DDL builders are allowed to consume.
    expect(onlyPlainParts(mixed)).toBe(false);
  });
});

describe("validateSchema", () => {
  it("normalises table and column names to lower case", () => {
    const { schema, errors } = validateSchema(valid);
    expect(errors).toEqual([]);
    expect(schema?.tables[0]?.name).toBe("orders");
    expect(findTable(schema, "ORDERS")?.columns[1]?.name).toBe("remark");
    expect(findColumn(findTable(schema, "orders"), "REMARK")?.length).toBe(1000);
  });

  it("rejects a schema with no tables and reports the path", () => {
    const { schema, errors } = validateSchema({ tables: [] });
    expect(schema).toBeUndefined();
    expect(errors.join(" ")).toContain("tables");
  });

  it("rejects an index without columns", () => {
    const { errors } = validateSchema({
      tables: [{ name: "t", columns: [{ name: "a", type: "int" }], indexes: [{ name: "i", columns: [] }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts the shipped example", () => {
    const example = loadInput("examples/schema.json");
    expect(example.records).toEqual([]);
    expect(example.notes.map((n) => n.note).join(" ")).toContain("--schema");
    // Both languages, or an English reader loses the only warning in the run.
    expect(example.notes.map((n) => n.noteEn).join(" ")).toContain("--schema");
  });
});

describe("columnKeyBytes", () => {
  it("sizes fixed types in bytes", () => {
    const table = validateSchema(valid).schema!.tables[0]!;
    expect(columnKeyBytes(findColumn(table, "id")!)).toBe(8);
    expect(columnKeyBytes(findColumn(table, "note")!)).toBe(Infinity);
  });

  it("charges 4 bytes per character for utf8mb4 varchar (R7)", () => {
    const table = validateSchema(valid).schema!.tables[0]!;
    expect(columnKeyBytes(findColumn(table, "remark")!, "utf8mb4")).toBe(4000);
    expect(columnKeyBytes(findColumn(table, "remark")!, "latin1")).toBe(1000);
  });
});

describe("hasUsablePrefix", () => {
  const table = validateSchema(valid).schema!.tables[0]!;

  it("matches a left prefix of an existing composite index", () => {
    expect(hasUsablePrefix(table, ["user_id"])?.name).toBe("idx_user_time");
    expect(hasUsablePrefix(table, ["user_id", "create_time"])?.name).toBe("idx_user_time");
  });

  it("does not match when the leading column is skipped (SIA003 input)", () => {
    expect(hasUsablePrefix(table, ["create_time"])).toBeUndefined();
  });

  it("matches the primary key", () => {
    expect(hasUsablePrefix(table, ["id"])?.name).toBe("PRIMARY");
  });
});
