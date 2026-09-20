import { z } from "zod";

import type { Schema, SchemaColumn, SchemaIndex, SchemaTable } from "../core/types.js";
import { readFileSync } from "node:fs";

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  length: z.number().optional(),
  nullable: z.boolean().optional(),
  charset: z.string().optional(),
});

const indexSchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string()).min(1),
  unique: z.boolean().optional(),
  primary: z.boolean().optional(),
  subParts: z.array(z.number().nullable()).optional(),
});

const tableSchema = z.object({
  name: z.string().min(1),
  engine: z.string().optional(),
  charset: z.string().optional(),
  columns: z.array(columnSchema).min(1),
  indexes: z.array(indexSchema).default([]),
  rowCountEstimate: z.number().optional(),
});

const schemaFileSchema = z.object({
  mysqlVersion: z.string().optional(),
  tables: z.array(tableSchema).min(1),
});

export interface SchemaLoadResult {
  schema?: Schema;
  errors: string[];
}

/** Validate and normalise a parsed schema.json object. */
export function validateSchema(input: unknown): SchemaLoadResult {
  const parsed = schemaFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }

  const tables: SchemaTable[] = parsed.data.tables.map((t) => ({
    name: t.name.toLowerCase(),
    engine: t.engine,
    charset: t.charset,
    rowCountEstimate: t.rowCountEstimate,
    columns: t.columns.map((c): SchemaColumn => ({
      name: c.name.toLowerCase(),
      type: c.type.toLowerCase(),
      length: c.length,
      nullable: c.nullable,
      charset: c.charset,
    })),
    indexes: t.indexes.map((i): SchemaIndex => ({
      name: i.name,
      columns: i.columns.map((c) => c.toLowerCase()),
      unique: i.unique,
      primary: i.primary,
      subParts: i.subParts,
    })),
  }));

  return {
    schema: { mysqlVersion: parsed.data.mysqlVersion, tables },
    errors: [],
  };
}

export function loadSchema(path: string): SchemaLoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`无法读取 schema 文件 ${path}：${(err as Error).message}`] };
  }
  try {
    return validateSchema(JSON.parse(text));
  } catch (err) {
    return { errors: [`${path} 不是合法 JSON：${(err as Error).message}`] };
  }
}

// --- lookup helpers used by rules -------------------------------------------

export function findTable(schema: Schema | undefined, name: string): SchemaTable | undefined {
  if (!schema) return undefined;
  const lower = name.toLowerCase();
  return schema.tables.find((t) => t.name === lower);
}

export function findColumn(
  table: SchemaTable | undefined,
  column: string,
): SchemaColumn | undefined {
  return table?.columns.find((c) => c.name === column.toLowerCase());
}

/** Approximate index key size in bytes; utf8mb4 costs 4 bytes per character. */
export function columnKeyBytes(column: SchemaColumn, charset = "utf8mb4"): number {
  const bytesPerChar = charsetBytes(charset);
  switch (column.type) {
    case "tinyint":
      return 1;
    case "smallint":
      return 2;
    case "mediumint":
      return 3;
    case "int":
    case "integer":
    case "float":
      return 4;
    case "bigint":
    case "double":
      return 8;
    case "datetime":
    case "timestamp":
      return 8;
    case "date":
      return 3;
    case "time":
      return 3;
    case "decimal":
      return 16;
    case "char":
      return (column.length ?? 1) * bytesPerChar;
    case "varchar":
      return (column.length ?? 255) * bytesPerChar;
    case "text":
    case "mediumtext":
    case "longtext":
      return Infinity;
    default:
      return 8;
  }
}

export function charsetBytes(charset: string): number {
  if (charset.startsWith("utf8mb4")) return 4;
  if (charset.startsWith("utf8")) return 3;
  if (charset.startsWith("latin1") || charset.startsWith("ascii")) return 1;
  return 4;
}

/** Does any existing index usable for `columns` as a left prefix? */
export function hasUsablePrefix(
  table: SchemaTable | undefined,
  columns: string[],
): SchemaIndex | undefined {
  if (!table) return undefined;
  const wanted = columns.map((c) => c.toLowerCase());
  for (const index of table.indexes) {
    if (index.columns.length < wanted.length) continue;
    const ok = wanted.every((c, i) => index.columns[i] === c);
    if (ok) return index;
  }
  return undefined;
}
