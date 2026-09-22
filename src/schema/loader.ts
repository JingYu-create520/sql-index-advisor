import { z } from "zod";

import type { PlainSchemaIndex, Schema, SchemaColumn, SchemaIndex, SchemaTable } from "../core/types.js";
import { readFileSync } from "node:fs";

/**
 * `information_schema` reports "not applicable" as an explicit null, and
 * schema-dump.sql passes those through, so optional metadata must accept both a
 * missing key and a null one. `.optional()` alone rejects null, which made our
 * own dump unreadable by our own loader. This bit twice: first on table/column
 * metadata, then on `indexes[].columns`, where a MySQL 8.0 functional index
 * really does have a null key part (see `onlyPlainParts`).
 */
const optionalText = z.string().nullish();
const optionalNumber = z.number().nullish();

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  length: optionalNumber,
  nullable: z.boolean().optional(),
  charset: optionalText,
});

const indexSchema = z.object({
  name: z.string().min(1),
  // `nullable()` because that is what MySQL 8.0 reports for a functional index
  // key part. Rejecting it used to fail the *whole* file, so one
  // `CREATE INDEX … ((DATE(create_time)))` anywhere in the database cost the user
  // every schema-gated rule — and SIA004 is the rule that tells them to write one.
  columns: z.array(z.string().nullable()).min(1),
  unique: z.boolean().optional(),
  primary: z.boolean().optional(),
  subParts: z.array(z.number().nullable()).optional(),
});

const tableSchema = z.object({
  name: z.string().min(1),
  engine: optionalText,
  charset: optionalText,
  columns: z.array(columnSchema).min(1),
  indexes: z.array(indexSchema).default([]),
  rowCountEstimate: optionalNumber,
});

const schemaFileSchema = z.object({
  mysqlVersion: optionalText,
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
    engine: t.engine ?? undefined,
    charset: t.charset ?? undefined,
    rowCountEstimate: t.rowCountEstimate ?? undefined,
    columns: t.columns.map((c): SchemaColumn => ({
      name: c.name.toLowerCase(),
      type: c.type.toLowerCase(),
      length: c.length ?? undefined,
      nullable: c.nullable,
      charset: c.charset ?? undefined,
    })),
    indexes: t.indexes.map((i): SchemaIndex => ({
      name: i.name,
      // A functional or multi-valued index key part has no column name at all
      // (`COLUMN_NAME` is NULL in information_schema), so `null` is kept rather
      // than dropped: dropping it would silently shorten the index and let a rule
      // read `(user_id)` out of `(cast(x as date), user_id)`.
      columns: i.columns.map((c) => c?.toLowerCase() ?? null),
      unique: i.unique,
      primary: i.primary,
      subParts: i.subParts,
    })),
  }));

  return {
    schema: { mysqlVersion: parsed.data.mysqlVersion ?? undefined, tables },
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

/**
 * Can a rule reason about this index column by column?
 *
 * A functional or multi-valued key part has no column name in
 * `information_schema`, so an index containing one cannot be compared against a
 * query's predicates: `(cast(create_time as date), user_id)` does *not* serve
 * `WHERE user_id = ?` as a left prefix, and calling anything on it a "left prefix
 * violation" would be a guess. Rules that name or extend existing indexes stay
 * away from these; `hasUsablePrefix` needs no special case because a null part
 * simply never equals a wanted column.
 */
export function onlyPlainParts(index: SchemaIndex): index is PlainSchemaIndex {
  return index.columns.every((part) => part !== null);
}

/** How an index reads to a human: an expression part has no name to print. */
export function describeIndexParts(index: SchemaIndex, lang: "zh" | "en" = "zh"): string {
  return index.columns
    .map((part) => part ?? (lang === "zh" ? "〈表达式〉" : "(expression)"))
    .join(", ");
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
