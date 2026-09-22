import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  columnKeyBytes,
  findColumn,
  findTable,
  hasUsablePrefix,
  validateSchema,
} from "../src/schema/loader.js";
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
