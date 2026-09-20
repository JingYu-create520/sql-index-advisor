/**
 * Core data model shared by parsers, rules, reports and the MCP layer.
 *
 * Everything downstream of the parsers speaks these types, so the parsers never
 * have to know anything about rules and rules never have to know anything about
 * input formats.
 */

export type Severity = "error" | "warn" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 3,
  warn: 2,
  info: 1,
};

export type StatementKind = "select" | "insert" | "update" | "delete" | "unknown";

/** Where a query came from. Line numbers power the GitHub Action's line comments. */
export interface SourceLocation {
  file: string;
  line: number;
  /** 1-based, may be absent when the input is a bare SQL string. */
  endLine?: number;
}

/** Metrics available only from the slow query log; several rules need them. */
export interface QueryMetrics {
  queryTime?: number;
  lockTime?: number;
  rowsSent?: number;
  rowsExamined?: number;
}

export type ColumnRefScope =
  | "where-eq"
  | "where-in"
  | "where-range"
  | "where-like-prefix"
  | "where-null"
  | "join-on"
  | "group-by"
  | "order-by"
  | "select"
  | "set";

/** A column reference with the role it plays in the statement. */
export interface ColumnRef {
  /** Raw text as it appears, e.g. `o.user_id` or `create_time`. */
  raw: string;
  /** Qualifier / alias if present, otherwise undefined. */
  table?: string;
  /** Column name without the qualifier, lower-cased. */
  column: string;
  scope: ColumnRefScope;
  /** For ranges: the comparison operator, lower-cased (`>`, `<`, `>=`, `between`, `!=`). */
  op?: string;
  /** For ORDER BY: sort direction. */
  desc?: boolean;
  /** True when the predicate wraps the column in a function or expression (SIA004). */
  wrapped?: boolean;
  /** True when the column is compared against a placeholder (`?`, `#{}`) rather than a literal. */
  parameterized?: boolean;
  /** Source text of the right-hand operand, e.g. `'PAID'` or `?>`. Rewrites need it. */
  valueText?: string;
  /** Source text of the whole predicate, e.g. `o.status = 'PAID'`. */
  predicateText?: string;
}

export interface LimitClause {
  rowCount?: number;
  offset?: number;
  /** True when offset/rowCount were literals we could read; false for `?, #{}` forms (R4). */
  literal: boolean;
  raw: string;
}

/** Result of parsing one SQL statement. Never throws — failures degrade to `notes`. */
export interface ParsedQuery {
  sql: string;
  /** Normalised text with literals replaced by `?`. */
  fingerprint: string;
  kind: StatementKind;
  /** Driven table plus every JOINed table. */
  tables: TableRef[];
  columns: ColumnRef[];
  /** Projection list; `selectStar` is true for `SELECT *`. */
  selectColumns: string[];
  selectStar: boolean;
  /**
   * Aliases defined by the SELECT list (`SUM(amount) AS gmv`). ORDER BY may sort
   * by these, and they are not real columns — indexing one would be nonsense.
   */
  selectAliases: string[];
  orderBy: ColumnRef[];
  groupBy: ColumnRef[];
  limit?: LimitClause;
  /**
   * Verbatim clause text. Rewrites must reproduce the original conditions
   * exactly; rebuilding them from column buckets would silently drop anything we
   * could not classify (a function-wrapped predicate, an OR group, ...).
   */
  whereText?: string;
  orderByText?: string;
  /** Anything we deliberately did not understand. Reported as `info`, never a crash. */
  notes: string[];
}

export interface TableRef {
  name: string;
  alias?: string;
  /** "FROM", "JOIN", "UPDATE", "INSERT", "DELETE". */
  role: string;
}

/**
 * One query *pattern* after fingerprint aggregation. For slow logs this carries
 * the number of occurrences and the summed cost; for mappers it is one statement.
 */
export interface QueryRecord {
  fingerprint: string;
  /** A representative SQL text for the pattern (first occurrence, un-normalised). */
  sql: string;
  source?: SourceLocation;
  metrics?: QueryMetrics;
  occurrences?: number;
  totalQueryTime?: number;
  maxRowsExamined?: number;
  parsed: ParsedQuery;
  /** Provenance of the input, used by reports. */
  input: "slowlog" | "sql" | "mapper";
  /** Mapper `<select id="...">` (+ `#variant` when dynamic SQL expanded). */
  statementId?: string;
  /** Mapper namespace, when the input was a MyBatis XML file. */
  namespace?: string;
  /** True when the statement text contains `${}` interpolation. */
  rawInterpolation?: boolean;
}

/** One rule verdict. See docs/PLAN.md section 6. */
export interface Finding {
  rule: string;
  severity: Severity;
  sql: string;
  fingerprint: string;
  source?: SourceLocation;
  queryTime?: number;
  rowsExamined?: number;
  occurrences?: number;
  message: string;
  messageEn: string;
  /** Optional LLM-written commentary. Never feeds back into a rule decision. */
  llmNote?: string;
  suggestedDDL: string[];
  rewrite?: string;
  needsSchema: boolean;
  needsMetrics: boolean;
  /** Table the finding is about, when a single table applies. Used for DDL dedup. */
  table?: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  primary?: boolean;
  /** Prefix lengths in characters; null for full-length parts of the index. */
  subParts?: (number | null)[];
}

export interface SchemaColumn {
  name: string;
  /** e.g. "varchar", "bigint", "text" — lower-cased, no length. */
  type: string;
  /** Declared length for string types. */
  length?: number;
  nullable?: boolean;
  charset?: string;
}

export interface SchemaTable {
  name: string;
  engine?: string;
  charset?: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  rowCountEstimate?: number;
}

export interface Schema {
  /** Server major version the dump came from; 5.7 and 8.0 differ a lot (R7). */
  mysqlVersion?: string;
  tables: SchemaTable[];
}

/** Context handed to every rule. */
export interface RuleContext {
  record: QueryRecord;
  schema?: Schema;
  options: RuleOptions;
}

export interface RuleOptions {
  mysqlVersion: number;
  /** Byte budget for an index key before a prefix index is recommended. */
  prefixBytes: number;
  /** Offset above which LIMIT paging is considered deep (SIA006). */
  deepOffsetThreshold: number;
  minSeverity: Severity;
}

export const DEFAULT_RULE_OPTIONS: RuleOptions = {
  mysqlVersion: 8,
  prefixBytes: 3072,
  deepOffsetThreshold: 10000,
  minSeverity: "info",
};

export interface Rule {
  id: string;
  title: string;
  titleEn: string;
  needsSchema: boolean;
  needsMetrics: boolean;
  /** Return zero or more findings for one query record. Must not throw. */
  run(ctx: RuleContext): Finding[];
}

/** Report language. `auto` follows LANG / LC_ALL, falling back to English. */
export type ReportLang = "auto" | "zh" | "en";

export function resolveLang(requested: ReportLang = "auto"): "zh" | "en" {
  if (requested === "zh" || requested === "en") return requested;
  const env = `${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}${process.env.LC_CTYPE ?? ""}`;
  return /zh|chinese/i.test(env) ? "zh" : "en";
}
