/**
 * Shared plumbing for rules: alias-aware table lookup, index naming, and the
 * per-table bucketing that every index recommendation starts from.
 */

import type {
  ColumnRef,
  ColumnRefScope,
  ParsedQuery,
  RuleOptions,
  Schema,
  SchemaColumn,
  SchemaTable,
  Severity,
} from "../core/types.js";
import { resolveTable } from "../parsers/sql.js";
import { tokenize } from "../parsers/token.js";
import { charsetBytes, columnKeyBytes, findTable } from "../schema/loader.js";

export interface TableBucket {
  table: string;
  /** Alias as used in the query, if any. */
  alias?: string;
  equality: ColumnRef[];
  inList: ColumnRef[];
  range: ColumnRef[];
  ordering: ColumnRef[];
  grouping: ColumnRef[];
  /** Columns whose predicate has a function or arithmetic on it (SIA004). */
  wrapped: ColumnRef[];
  /** Every column mentioned for this table, in appearance order. */
  all: ColumnRef[];
  isDriving: boolean;
  schemaTable?: SchemaTable;
}

const EQ_OPS = new Set(["=", "in", "in-subquery", "like-prefix"]);

/** Scopes where a column is being tested, as opposed to produced or grouped. */
const PREDICATE_SCOPES = new Set<ColumnRefScope>([
  "where-eq",
  "where-in",
  "where-range",
  "where-like-prefix",
  "where-null",
  "join-on",
]);
const RANGE_OPS = new Set([">", "<", ">=", "<=", "!=", "<>", "between", "like-middle"]);

/** Group every parsed reference by the physical table it belongs to. */
export function bucketByTable(parsed: ParsedQuery, schema: Schema | undefined): TableBucket[] {
  if (parsed.tables.length === 0) return [];

  const buckets = new Map<string, TableBucket>();
  const ensure = (name: string, alias?: string, isDriving = false): TableBucket => {
    const key = name.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        table: name,
        alias,
        equality: [],
        inList: [],
        range: [],
        ordering: [],
        grouping: [],
        wrapped: [],
        all: [],
        isDriving,
        schemaTable: findTable(schema, name),
      };
      buckets.set(key, bucket);
    }
    if (isDriving) bucket.isDriving = true;
    if (!bucket.alias && alias) bucket.alias = alias;
    return bucket;
  };

  parsed.tables.forEach((t, index) => {
    ensure(t.name, t.alias, index === 0);
  });

  const refs = [...parsed.columns, ...parsed.orderBy, ...parsed.groupBy];
  for (const ref of refs) {
    // `ORDER BY gmv` where gmv is `SUM(amount) AS gmv` sorts an output alias:
    // there is no such column, and recommending an index on it would be wrong.
    if (parsed.selectAliases.includes(ref.column) && !parsed.selectColumns.includes(ref.column)) {
      continue;
    }
    const table = resolveTable(ref, parsed);
    if (!table) continue;
    const bucket = ensure(table);
    bucket.all.push(ref);

    if (ref.wrapped) {
      // "An expression sits on top of this column" only matters where the column
      // is being tested. `DATE_FORMAT(t, '%Y-%m-%d')` in the SELECT list or the
      // GROUP BY is a projection, and the WHERE clause on the same statement can
      // be perfectly sargable; flagging those told users their usable index was
      // unusable. `wrapped` therefore means "wrapped inside a predicate".
      if (PREDICATE_SCOPES.has(ref.scope)) bucket.wrapped.push(ref);
      continue;
    }
    if (ref.scope === "order-by") {
      bucket.ordering.push(ref);
      continue;
    }
    if (ref.scope === "group-by") {
      bucket.grouping.push(ref);
      continue;
    }
    if (ref.scope === "select" || ref.scope === "set") continue;

    const op = ref.op ?? "=";
    if (ref.scope === "where-in" || op === "in" || op === "in-subquery") bucket.inList.push(ref);
    else if (EQ_OPS.has(op) || ref.scope === "where-eq" || ref.scope === "join-on") bucket.equality.push(ref);
    else if (RANGE_OPS.has(op) || ref.scope === "where-range") bucket.range.push(ref);
    else if (ref.scope === "where-null") bucket.equality.push(ref);
  }

  // WHERE filters lead the composite index; join keys come after them. For an
  // inner (joined) table the join key usually *is* the first column, and it has
  // no WHERE equality of its own, so the ordering only ever helps.
  for (const bucket of buckets.values()) {
    bucket.equality.sort((a, b) => rank(a) - rank(b));
  }
  return [...buckets.values()];
}

/** Lower rank = earlier in the composite index. */
function rank(ref: ColumnRef): number {
  if (ref.scope === "where-eq") return 0;
  if (ref.scope === "where-null") return 1;
  return 2;
}

export function dedupeColumns(refs: ColumnRef[]): ColumnRef[] {
  const seen = new Map<string, ColumnRef>();
  for (const ref of refs) {
    if (!seen.has(ref.column)) seen.set(ref.column, ref);
  }
  return [...seen.values()];
}

/** `idx_orders_user_id_status`, truncated to MySQL's 64-character limit. */
export function indexName(table: string, columns: string[]): string {
  const base = `idx_${table}_${columns.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return base.length > 64 ? base.slice(0, 64).replace(/_+$/, "") : base;
}

export function quoteIdent(name: string): string {
  return `\`${name}\``;
}

export function addIndexDdl(table: string, columns: string[], unique = false): string {
  const names = columns.map((c) => quoteIdent(c)).join(", ");
  return `ALTER TABLE ${quoteIdent(table)} ADD ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(
    indexName(table, columns),
  )} (${names});`;
}

/** Column sizes that would blow the index key budget and must be prefixed. */
export function oversizedColumns(
  table: SchemaTable | undefined,
  columns: string[],
  options: RuleOptions,
): SchemaColumn[] {
  if (!table) return [];
  const charset = table.charset ?? "utf8mb4";
  return columns
    .map((c) => table.columns.find((col) => col.name === c.toLowerCase()))
    .filter((c): c is SchemaColumn => !!c)
    .filter((c) => columnKeyBytes(c, charset) > options.prefixBytes / 2);
}

export function isStringType(type: string): boolean {
  return ["varchar", "char", "text", "tinytext", "mediumtext", "longtext", "enum"].includes(type);
}

export function isNumericType(type: string): boolean {
  return [
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint",
    "decimal", "numeric", "float", "double", "bit",
  ].includes(type);
}

export function bytesPerChar(table: SchemaTable | undefined): number {
  return charsetBytes(table?.charset ?? "utf8mb4");
}

/**
 * Asking price, in characters, for a prefix index. The byte budget below is the
 * hard ceiling; this is the practical one. Past roughly 128 characters a prefix
 * is already longer than what distinguishes most strings, and this tool cannot
 * measure distinctness because it never connects, so it asks for a short prefix
 * and prints the ratio query for you to check. Keeping the two separate also
 * means `--prefix-bytes` shrinks the suggestion when you lower it, instead of the
 * version budget silently overriding everything.
 */
const PRACTICAL_MAX_PREFIX_CHARS = 128;

/**
 * True for a table name that only exists at runtime. MyBatis writes
 * \`device_message_\${deviceId}\` and sharding suffixes, which collapse to a
 * placeholder here, so the statement really means "some table whose name the
 * caller builds". There is no index to name on such a table, and the DDL fails
 * on the server the moment anyone runs the migration file.
 */
export function isDynamicTable(name: string): boolean {
  return /[?${}]/.test(name) || /_$/.test(name);
}

/** A prefix length in characters that keeps a string column inside the key budget. */
export function suggestPrefixChars(
  column: SchemaColumn,
  table: SchemaTable | undefined,
  options: RuleOptions,
): number {
  const perChar = bytesPerChar(table);
  const budget = options.mysqlVersion >= 8 ? 3072 : 767;
  const byBytes = Math.floor(Math.min(budget, options.prefixBytes) / perChar);
  const declared = column.length ?? 64;
  return Math.max(8, Math.min(declared, byBytes, PRACTICAL_MAX_PREFIX_CHARS));
}

export function severityFor(hasSchema: boolean, base: Severity, withoutSchema: Severity): Severity {
  return hasSchema ? base : withoutSchema;
}

export function truncateSql(sql: string, max = 200): string {
  return sql.length > max ? `${sql.slice(0, max - 1)}…` : sql;
}

/**
 * Swap one predicate for its rewritten form inside the statement.
 *
 * Matching is whitespace-insensitive because `ParsedQuery.sql` is the collapsed
 * text while the caller may hand us the original. If the predicate cannot be
 * found we return undefined rather than emitting a half-edited statement.
 */
export function replacePredicate(sql: string, from: string, to: string): string | undefined {
  const tokens = tokenize(from);
  if (tokens.length === 0) return undefined;
  // Every token (punctuation included) is matched literally, with any amount of
  // whitespace allowed between them, so `IN (138,139)` and `IN(138, 139)` agree.
  const pattern = tokens.map((t) => escapeRegExp(t.value)).join("\\s*");
  const re = new RegExp(`(?<![\\w.])${pattern}`, "i");
  if (!re.test(sql)) return undefined;
  return sql.replace(re, () => to);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `2026-09-17` / `2026-09-17 08:00:00` / `2026/09/17` into a Date, or null. */
export function parseDateLiteral(text: string): Date | null {
  const cleaned = text.replace(/'/g, "").trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(cleaned);
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** A numeric literal as it appears in SQL, e.g. `42`, `-3`, `1.5`. */
export function numericLiteral(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : undefined;
}
