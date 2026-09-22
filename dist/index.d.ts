/**
 * Core data model shared by parsers, rules, reports and the MCP layer.
 *
 * Everything downstream of the parsers speaks these types, so the parsers never
 * have to know anything about rules and rules never have to know anything about
 * input formats.
 */
type Severity = "error" | "warn" | "info";
declare const SEVERITY_ORDER: Record<Severity, number>;
type StatementKind = "select" | "insert" | "update" | "delete" | "unknown";
/** Where a query came from. Line numbers power the GitHub Action's line comments. */
interface SourceLocation {
    file: string;
    line: number;
    /** 1-based, may be absent when the input is a bare SQL string. */
    endLine?: number;
}
/** Metrics available only from the slow query log; several rules need them. */
interface QueryMetrics {
    queryTime?: number;
    lockTime?: number;
    rowsSent?: number;
    rowsExamined?: number;
}
type ColumnRefScope = "where-eq" | "where-in" | "where-range" | "where-like-prefix"
/** Equality branches of a top-level OR over different columns. */
 | "where-or" | "where-null" | "join-on" | "group-by" | "order-by" | "select" | "set";
/** A column reference with the role it plays in the statement. */
interface ColumnRef {
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
interface LimitClause {
    rowCount?: number;
    offset?: number;
    /** True when offset/rowCount were literals we could read; false for `?, #{}` forms (R4). */
    literal: boolean;
    raw: string;
}
/** Result of parsing one SQL statement. Never throws; failures degrade to `notes`. */
interface ParsedQuery {
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
     * by these, and they are not real columns, so indexing one would be nonsense.
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
interface TableRef {
    name: string;
    alias?: string;
    /** "FROM", "JOIN", "UPDATE", "INSERT", "DELETE". */
    role: string;
}
/**
 * One query *pattern* after fingerprint aggregation. For slow logs this carries
 * the number of occurrences and the summed cost; for mappers it is one statement.
 */
interface QueryRecord {
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
/** One rule verdict. See docs/rules.md. */
interface Finding {
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
    /**
     * Columns of the index this finding proposes, in order. Lets the engine drop a
     * suggestion that is a left prefix of a wider suggestion on the same table:
     * `(sku_id)` is noise once `(sku_id, warehouse_id)` is on the table.
     */
    indexColumns?: string[];
    /** True when the suggestion is only useful after a selectivity check. */
    lowCardinalityRisk?: boolean;
    /** Narrower suggestions on the same table that this wider index already serves. */
    coveredFingerprints?: string[];
}
/**
 * A caveat about the input itself, carried in both languages: the report is
 * bilingual and an English reader deserves the same warning, not a silent gap.
 * Produced by the loader, rendered by every report format.
 */
interface InputNote {
    note: string;
    noteEn: string;
}
interface SchemaIndex {
    name: string;
    columns: string[];
    unique?: boolean;
    primary?: boolean;
    /** Prefix lengths in characters; null for full-length parts of the index. */
    subParts?: (number | null)[];
}
interface SchemaColumn {
    name: string;
    /** e.g. "varchar", "bigint", "text"; lower-cased, no length. */
    type: string;
    /** Declared length for string types. */
    length?: number;
    nullable?: boolean;
    charset?: string;
}
interface SchemaTable {
    name: string;
    engine?: string;
    charset?: string;
    columns: SchemaColumn[];
    indexes: SchemaIndex[];
    rowCountEstimate?: number;
}
interface Schema {
    /** Server major version the dump came from; 5.7 and 8.0 differ a lot (R7). */
    mysqlVersion?: string;
    tables: SchemaTable[];
}
/** Context handed to every rule. */
interface RuleContext {
    record: QueryRecord;
    schema?: Schema;
    options: RuleOptions;
}
interface RuleOptions {
    mysqlVersion: number;
    /** Byte budget for an index key before a prefix index is recommended. */
    prefixBytes: number;
    /** Offset above which LIMIT paging is considered deep (SIA006). */
    deepOffsetThreshold: number;
    minSeverity: Severity;
}
declare const DEFAULT_RULE_OPTIONS: RuleOptions;
interface Rule {
    id: string;
    title: string;
    titleEn: string;
    needsSchema: boolean;
    needsMetrics: boolean;
    /** Return zero or more findings for one query record. Must not throw. */
    run(ctx: RuleContext): Finding[];
}
/** Report language. `auto` follows LANG / LC_ALL, falling back to English. */
type ReportLang = "auto" | "zh" | "en";
declare function resolveLang(requested?: ReportLang): "zh" | "en";

/**
 * SQL fingerprinting (docs/DESIGN-NOTES.md D2).
 *
 * A slow query log repeats the same query pattern thousands of times with
 * different literals. Folding literals into `?` gives us a stable key we can
 * aggregate on, and gives every `Finding` a dedup key for emitted DDL.
 *
 * Deliberately conservative: when we hit something we cannot normalise safely
 * we return the whitespace-collapsed text rather than guessing.
 */
/** Strip `/* ... *\/` and line comments, keeping string literals intact. */
declare function stripComments(sql: string): string;
/**
 * Replace literals with `?`. Handles quoted strings (with `\` and `''` escapes)
 * and standalone numbers, including `0x`, `NULL`-adjacent decimals and exponents.
 */
declare function maskLiterals(sql: string): string;
/**
 * Full fingerprint: strip comments, mask literals, collapse IN lists and
 * whitespace, lowercase, drop the trailing semicolon.
 */
declare function fingerprint(sql: string): string;
/** Display text for reports: comments gone, one line, hard-truncated. */
declare function evidence(sql: string, maxLen?: number): string;

/**
 * Lightweight MySQL statement analyser.
 *
 * Scope is a documented subset (docs/rules.md): single statements,
 * SELECT / INSERT / UPDATE / DELETE, one FROM block with ANSI and comma joins.
 * Anything outside the subset degrades into `ParsedQuery.notes`, so this module
 * must never throw, because a crash in a CI gate is worse than a missed hint.
 */

declare function parseSql(input: string): ParsedQuery;
/** Resolve an alias qualifier to the real table name. */
declare function resolveTable(ref: ColumnRef, parsed: ParsedQuery): string | undefined;

/**
 * MySQL slow query log reader.
 *
 * Two jobs: split the file into events, then aggregate events by SQL fingerprint
 * (docs/DESIGN-NOTES.md D2). A real log repeats one pattern hundreds of times, so ranking
 * raw events produces a report nobody can act on.
 */

interface SlowLogResult {
    records: QueryRecord[];
    /** Events we could not turn into a statement (admin commands, empty blocks). */
    ignoredEvents: number;
    totalEvents: number;
}
declare function parseSlowLog(content: string, file?: string): SlowLogResult;

/**
 * MyBatis mapper XML reader.
 *
 * The hard part is not the XML, it is MyBatis' dynamic SQL. Policy (docs/DESIGN-NOTES.md D4):
 *
 *  - `<if>`      the branch is taken. Extra predicates only widen the set of
 *                index candidates, so keeping them is the safe direction.
 *  - `<choose>`  mutually exclusive, so each `<when>` / `<otherwise>` becomes its
 *                own variant (capped) instead of being merged into nonsense SQL.
 *  - `<foreach>` element list collapses to a single `?`.
 *  - `${}`       raw interpolation: flagged, never trusted for structure.
 *
 * Line numbers of the statement tag are preserved so the GitHub Action can post
 * line-level PR comments (R8).
 */

interface MapperVariant {
    sql: string;
    /** e.g. `when[1]`, `otherwise`, or "" for the straight-line case. */
    label: string;
}
interface MapperStatement {
    id: string;
    namespace: string;
    kind: StatementKind;
    file: string;
    line: number;
    parameterType?: string;
    databaseId?: string;
    variants: MapperVariant[];
    rawInterpolation: boolean;
    notes: string[];
}
declare function parseMapperText(text: string, file: string): MapperStatement[];
declare function readMapperFile(path: string): string;
/** Accepts a file or a directory; recurses and keeps only `<mapper>` files. */
declare function discoverMapperFiles(input: string): string[];
declare function loadMapperFiles(paths: string[]): MapperStatement[];
/** One QueryRecord per variant; `source.line` points at the `<select>` tag. */
declare function mapperStatementsToRecords(statements: MapperStatement[]): QueryRecord[];

/**
 * Input plumbing shared by the CLI and the MCP server: figure out what we were
 * handed, and turn loose SQL text into query records.
 */

type InputKind = "slowlog" | "mapper" | "schema" | "sql";
declare function detectInputKind(pathOrText: string): InputKind;
/**
 * `InputNote` is declared in core/types.ts so the rule engine and the reports can
 * name it without importing the loader.
 */
interface LoadedInput {
    records: QueryRecord[];
    kind: InputKind;
    notes: InputNote[];
}
/** Read a file (or accept inline text) and produce query records. */
declare function loadInput(source: string, options?: {
    inline?: boolean;
    kind?: InputKind;
}): LoadedInput;
/** A .sql file with one statement per `;`, or a raw statement string. */
declare function buildRecordsFromSqlText(text: string, file?: string): QueryRecord[];
declare function readTextFile(path: string): string;

interface SchemaLoadResult {
    schema?: Schema;
    errors: string[];
}
/** Validate and normalise a parsed schema.json object. */
declare function validateSchema(input: unknown): SchemaLoadResult;
declare function loadSchema(path: string): SchemaLoadResult;

export { type ColumnRef, type ColumnRefScope, DEFAULT_RULE_OPTIONS, type Finding, type InputNote, type LimitClause, type MapperStatement, type MapperVariant, type ParsedQuery, type QueryMetrics, type QueryRecord, type ReportLang, type Rule, type RuleContext, type RuleOptions, SEVERITY_ORDER, type Schema, type SchemaColumn, type SchemaIndex, type SchemaTable, type Severity, type SlowLogResult, type SourceLocation, type StatementKind, type TableRef, buildRecordsFromSqlText, detectInputKind, discoverMapperFiles, evidence, fingerprint, loadInput, loadMapperFiles, loadSchema, mapperStatementsToRecords, maskLiterals, parseMapperText, parseSlowLog, parseSql, readMapperFile, readTextFile, resolveLang, resolveTable, stripComments, validateSchema };
