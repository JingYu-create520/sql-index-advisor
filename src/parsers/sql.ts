/**
 * Lightweight MySQL statement analyser.
 *
 * Scope is a documented subset (docs/rules.md): single statements,
 * SELECT / INSERT / UPDATE / DELETE, one FROM block with ANSI and comma joins.
 * Anything outside the subset degrades into `ParsedQuery.notes`, so this module
 * must never throw, because a crash in a CI gate is worse than a missed hint.
 */

import type { ColumnRef, LimitClause, ParsedQuery, StatementKind, TableRef } from "../core/types.js";
import { evidence, fingerprint, stripComments } from "./fingerprint.js";
import {
  indexOfPunct,
  indexOfWord,
  isWord,
  splitOnAnd,
  splitOnComma,
  tokenize,
  tokensToString,
  type Token,
} from "./token.js";

const RESERVED = new Set([
  "and", "or", "not", "null", "is", "in", "like", "between", "select", "from",
  "where", "group", "order", "by", "limit", "offset", "having", "join", "on",
  "using", "as", "asc", "desc", "case", "when", "then", "else", "end", "exists",
  "interval", "true", "false", "distinct", "all", "union", "default",
]);

/** Functions whose argument is *not* a column reference on its own. */
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "group_concat"]);

export function parseSql(input: string): ParsedQuery {
  const notes: string[] = [];
  const empty: ParsedQuery = {
    sql: evidence(input),
    fingerprint: fingerprint(input),
    kind: "unknown",
    tables: [],
    columns: [],
    selectColumns: [],
    selectAliases: [],
    selectStar: false,
    orderBy: [],
    groupBy: [],
    notes: [],
  };

  try {
    const tokens = tokenize(stripComments(input));
    if (tokens.length === 0) {
      return { ...empty, notes: ["空语句，已跳过"] };
    }

    const kind = statementKind(tokens);
    const parsed = analyse(kind, tokens, notes);

    return {
      sql: evidence(input),
      fingerprint: fingerprint(input),
      kind,
      tables: parsed.tables,
      columns: parsed.columns,
      selectColumns: parsed.selectColumns,
      selectAliases: parsed.selectAliases,
      selectStar: parsed.selectStar,
      orderBy: parsed.orderBy,
      groupBy: parsed.groupBy,
      limit: parsed.limit,
      whereText: parsed.whereText,
      orderByText: parsed.orderByText,
      notes,
    };
  } catch (err) {
    return {
      ...empty,
      notes: [`解析失败，已跳过：${(err as Error).message}`],
    };
  }
}

function statementKind(tokens: Token[]): StatementKind {
  const first = tokens[0];
  if (!first || first.type !== "word") return "unknown";
  const v = first.value.toLowerCase();
  if (v === "select") return "select";
  if (v === "insert" || v === "replace") return "insert";
  if (v === "update") return "update";
  if (v === "delete") return "delete";
  if (v === "with") return "unknown";
  return "unknown";
}

interface Partial {
  tables: TableRef[];
  columns: ColumnRef[];
  selectColumns: string[];
  selectAliases: string[];
  selectStar: boolean;
  orderBy: ColumnRef[];
  groupBy: ColumnRef[];
  limit?: LimitClause;
  whereText?: string;
  orderByText?: string;
}

function blank(): Partial {
  return {
    tables: [],
    columns: [],
    selectColumns: [],
    selectAliases: [],
    selectStar: false,
    orderBy: [],
    groupBy: [],
  };
}

function analyse(kind: StatementKind, tokens: Token[], notes: string[]): Partial {
  const topUnion = indexOfWord(tokens, "union", 0, 0);
  if (topUnion !== -1) {
    notes.push("UNION 语句只分析第一个分支");
    tokens = tokens.slice(0, topUnion);
  }

  switch (kind) {
    case "select":
      return analyseSelect(tokens, notes);
    case "update":
      return analyseUpdate(tokens, notes);
    case "delete":
      return analyseDelete(tokens, notes);
    case "insert":
      return analyseInsert(tokens, notes);
    default:
      notes.push("不支持的语句类型，已跳过（支持 SELECT / INSERT / UPDATE / DELETE）");
      return blank();
  }
}

/** Find a two-word clause such as `GROUP BY` and return its index. */
function findTwoWord(tokens: Token[], first: string, second: string): number {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const t = tokens[i]!;
    if (t.depth === 0 && isWord(t, first) && isWord(tokens[i + 1], second)) return i;
  }
  return -1;
}

function clauseBoundary(tokens: Token[], from: number): number {
  const candidates = [
    indexOfWord(tokens, "where", from, 0),
    findTwoWord(tokens, "group", "by"),
    indexOfWord(tokens, "having", from, 0),
    findTwoWord(tokens, "order", "by"),
    indexOfWord(tokens, "limit", from, 0),
    indexOfWord(tokens, "union", from, 0),
    findTwoWord(tokens, "for", "update"),
  ].filter((i) => i > from);
  return candidates.length > 0 ? Math.min(...candidates) : tokens.length;
}

function analyseSelect(tokens: Token[], notes: string[]): Partial {
  const out = blank();
  const fromIdx = indexOfWord(tokens, "from", 0, 0);

  const selectEnd = fromIdx === -1 ? tokens.length : fromIdx;
  readSelectList(tokens.slice(1, selectEnd), out, notes);

  if (fromIdx === -1) {
    out.tables = [];
    return out;
  }

  const end = clauseBoundary(tokens, fromIdx);
  readFrom(tokens.slice(fromIdx + 1, end), out, notes);

  const whereStart = indexOfWord(tokens, "where", fromIdx, 0);
  if (whereStart !== -1 && whereStart >= end) {
    const whereEnd = findNextClause(tokens, whereStart, tokens.length);
    out.whereText = tokensToString(tokens.slice(whereStart + 1, whereEnd));
    readWhere(tokens.slice(whereStart + 1, whereEnd), out, notes);
  }

  const groupIdx = findTwoWord(tokens, "group", "by");
  if (groupIdx > fromIdx) {
    const groupEnd = findNextClause(tokens, groupIdx, tokens.length);
    readColumnList(tokens.slice(groupIdx + 2, groupEnd), out.groupBy, "group-by", notes, "GROUP BY");
  }

  const orderIdx = findTwoWord(tokens, "order", "by");
  if (orderIdx > fromIdx) {
    const orderEnd = findNextClause(tokens, orderIdx, tokens.length);
    out.orderByText = tokensToString(tokens.slice(orderIdx + 2, orderEnd));
    out.orderBy = readOrderList(tokens.slice(orderIdx + 2, orderEnd), notes);
  }

  const limitIdx = indexOfWord(tokens, "limit", fromIdx, 0);
  if (limitIdx !== -1) out.limit = readLimit(tokens.slice(limitIdx + 1));

  return out;
}

function findNextClause(tokens: Token[], from: number, fallback: number): number {
  const idxs = [
    indexOfWord(tokens, "where", from + 1, 0),
    findTwoWord(tokens, "group", "by"),
    indexOfWord(tokens, "having", from + 1, 0),
    findTwoWord(tokens, "order", "by"),
    indexOfWord(tokens, "limit", from + 1, 0),
  ]
    .filter((i) => i > from)
    .sort((a, b) => a - b);
  return idxs.length > 0 ? idxs[0]! : fallback;
}

function analyseUpdate(tokens: Token[], notes: string[]): Partial {
  const out = blank();
  const setIdx = indexOfWord(tokens, "set", 0, 0);
  if (setIdx === -1) {
    notes.push("UPDATE 语句缺少 SET，已跳过");
    return out;
  }
  readFrom(tokens.slice(1, setIdx), out, notes);

  const whereIdx = indexOfWord(tokens, "where", setIdx, 0);
  const setEnd = whereIdx === -1 ? clauseBoundary(tokens, setIdx) : whereIdx;
  for (const assign of splitOnComma(tokens.slice(setIdx + 1, setEnd))) {
    const eq = indexOfPunct(assign, "=", 0, 0);
    if (eq === -1) continue;
    const ref = columnFromTokens(assign.slice(0, eq), "set");
    if (ref) out.columns.push(ref);
  }

  if (whereIdx !== -1) {
    const whereEnd = findNextClause(tokens, whereIdx, tokens.length);
    out.whereText = tokensToString(tokens.slice(whereIdx + 1, whereEnd));
    readWhere(tokens.slice(whereIdx + 1, whereEnd), out, notes);
  }
  const orderIdx = findTwoWord(tokens, "order", "by");
  if (orderIdx !== -1) {
    out.orderByText = tokensToString(tokens.slice(orderIdx + 2));
    out.orderBy = readOrderList(tokens.slice(orderIdx + 2), notes);
  }
  const limitIdx = indexOfWord(tokens, "limit", 0, 0);
  if (limitIdx !== -1) out.limit = readLimit(tokens.slice(limitIdx + 1));
  return out;
}

function analyseDelete(tokens: Token[], notes: string[]): Partial {
  const out = blank();
  const fromIdx = indexOfWord(tokens, "from", 0, 0);
  if (fromIdx === -1) {
    notes.push("DELETE 语句缺少 FROM，已跳过");
    return out;
  }
  const end = clauseBoundary(tokens, fromIdx);
  readFrom(tokens.slice(fromIdx + 1, end), out, notes);

  const whereIdx = indexOfWord(tokens, "where", fromIdx, 0);
  if (whereIdx !== -1) {
    const whereEnd = findNextClause(tokens, whereIdx, tokens.length);
    out.whereText = tokensToString(tokens.slice(whereIdx + 1, whereEnd));
    readWhere(tokens.slice(whereIdx + 1, whereEnd), out, notes);
  }
  const orderIdx = findTwoWord(tokens, "order", "by");
  if (orderIdx !== -1) {
    out.orderByText = tokensToString(tokens.slice(orderIdx + 2));
    out.orderBy = readOrderList(tokens.slice(orderIdx + 2), notes);
  }
  const limitIdx = indexOfWord(tokens, "limit", 0, 0);
  if (limitIdx !== -1) out.limit = readLimit(tokens.slice(limitIdx + 1));
  return out;
}

function analyseInsert(tokens: Token[], notes: string[]): Partial {
  const out = blank();
  const intoIdx = indexOfWord(tokens, "into", 0, 0);
  const start = intoIdx === -1 ? 1 : intoIdx + 1;

  let end = start;
  while (end < tokens.length && tokens[end]!.depth === 0 && tokens[end]!.value !== "(") end += 1;
  const table = parseTableRef(tokens.slice(start, end), "INSERT");
  if (table) out.tables.push(table);

  if (end < tokens.length && tokens[end]!.value === "(") {
    const close = matchingClose(tokens, end);
    for (const col of splitOnComma(tokens.slice(end + 1, close))) {
      const ref = columnFromTokens(col, "select");
      if (ref) out.columns.push(ref);
    }
  }
  notes.push("INSERT 语句只做表识别，不产出索引建议");
  return out;
}

// --- FROM / JOIN -------------------------------------------------------------

const JOIN_PARTICLES = new Set([
  "left", "right", "inner", "cross", "full", "outer", "natural", "straight_join",
]);

/**
 * Walk a FROM segment: `a, b LEFT JOIN c ON ... , d`.
 *
 * Comma lists and join chains can nest in either order, so this is a single
 * forward scan rather than a split-then-classify pass.
 */
function readFrom(tokens: Token[], out: Partial, notes: string[]): void {
  let pos = 0;
  let role = "FROM";
  const particles: string[] = [];

  const stopsHere = (t: Token): boolean =>
    t.depth === 0 &&
    (t.type === "punct" ? t.value === "," : isWord(t, "join", "on", "using"));

  while (pos < tokens.length) {
    const start = pos;
    while (pos < tokens.length && !stopsHere(tokens[pos]!)) pos += 1;
    let tableTokens = tokens.slice(start, pos);

    // Trailing `LEFT` / `INNER` etc. belong to the *next* table.
    if (pos < tokens.length && isWord(tokens[pos]!, "join")) {
      while (
        tableTokens.length > 0 &&
        JOIN_PARTICLES.has(tableTokens[tableTokens.length - 1]!.value.toLowerCase())
      ) {
        particles.unshift(tableTokens.pop()!.value);
      }
      if (tableTokens.length > 0) pushTable(tableTokens, "FROM", out, notes);
      role = particles.length > 0 ? `${particles.join(" ").toUpperCase()} JOIN` : "JOIN";
      particles.length = 0;
      pos += 1;
      continue;
    }

    if (tableTokens.length > 0) pushTable(tableTokens, role, out, notes);
    role = "FROM";

    if (pos >= tokens.length) break;
    const marker = tokens[pos]!;

    if (marker.type === "punct" && marker.value === ",") {
      pos += 1;
      continue;
    }

    if (isWord(marker, "on")) {
      pos += 1;
      const condStart = pos;
      while (
        pos < tokens.length &&
        !(tokens[pos]!.depth === 0 && (tokens[pos]!.value === "," || isWord(tokens[pos]!, "join")))
      ) {
        pos += 1;
      }
      for (const pred of splitOnAnd(tokens.slice(condStart, pos))) {
        out.columns.push(...classifyPredicate(pred, "join-on", notes));
      }
      continue;
    }

    if (isWord(marker, "using")) {
      pos += 1;
      const open = pos;
      if (tokens[open]?.value === "(") {
        const close = matchingClose(tokens, open);
        for (const col of splitOnComma(tokens.slice(open + 1, close))) {
          const ref = columnFromTokens(col, "join-on");
          if (ref) out.columns.push(ref);
        }
        pos = close + 1;
      }
      continue;
    }

    pos += 1;
  }
}

function pushTable(tokens: Token[], role: string, out: Partial, notes: string[]): void {
  if (tokens[0]?.value === "(") {
    notes.push("FROM 子查询未展开，只分析外层条件");
    return;
  }
  const table = parseTableRef(tokens, role);
  if (table) out.tables.push(table);
}

function matchingClose(tokens: Token[], openIdx: number): number {
  const depth = tokens[openIdx]!.depth;
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.value === ")" && t.depth === depth) return i;
  }
  return tokens.length;
}

function parseTableRef(tokens: Token[], role: string): TableRef | undefined {
  const parts = tokens.filter((t) => !(t.depth === 0 && isWord(t, "as")));
  if (parts.length === 0) return undefined;
  if (parts[0]!.type !== "word") return undefined;

  // `schema.table` or `table`
  let nameIndex = 0;
  const dot = indexOfPunct(parts, ".", 0, 0);
  if (dot !== -1 && parts[dot + 1]?.type === "word") nameIndex = dot + 1;
  const name = parts[nameIndex]!.value;

  const aliasTok = parts[nameIndex + 1];
  const alias =
    aliasTok && aliasTok.type === "word" && !JOIN_PARTICLES.has(aliasTok.value.toLowerCase())
      ? aliasTok.value
      : undefined;

  return { name, alias, role };
}

// --- SELECT list -------------------------------------------------------------

function readSelectList(tokens: Token[], out: Partial, notes: string[]): void {
  const list = isWord(tokens[0], "distinct") ? tokens.slice(1) : tokens;
  for (const item of splitOnComma(list)) {
    const asIdx = indexOfWord(item, "as", 0, 0);
    const expr = asIdx === -1 ? stripTrailingAlias(item, out) : item.slice(0, asIdx);
    if (asIdx !== -1 && item[asIdx + 1]?.type === "word") {
      out.selectAliases.push(item[asIdx + 1]!.value.toLowerCase());
    }
    if (expr.length === 0) continue;

    if (expr.length === 1 && expr[0]!.value === "*") {
      out.selectStar = true;
      continue;
    }
    const dotStar = expr.findIndex((t, i) => t.value === "*" && i > 0 && expr[i - 1]?.value === ".");
    if (dotStar !== -1) {
      out.selectStar = true;
      continue;
    }
    if (expr.some((t) => t.value === "(")) {
      // Aggregate projections are normal, not a parsing limitation.
      const isAggregate = expr.some((t) => t.type === "word" && AGGREGATES.has(t.value.toLowerCase()));
      if (!isAggregate) {
        notes.push("SELECT 含函数表达式，覆盖索引判断按其余列处理");
      }
      continue;
    }
    const ref = columnFromTokens(expr, "select");
    if (ref) out.selectColumns.push(ref.column);
  }
}

/** `SELECT a b` means `a AS b`; drop the trailing bare alias, but remember it. */
function stripTrailingAlias(tokens: Token[], out: Partial): Token[] {
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]!;
    const prev = tokens[tokens.length - 2]!;
    // The thing before an alias can be a name, `*` or a closing paren: `cnt`,
    // `a b`, `COUNT(*) total` are all alias forms.
    const endsExpression = prev.type === "word" || prev.value === "*" || prev.value === ")";
    if (last.type === "word" && endsExpression && !RESERVED.has(last.value.toLowerCase())) {
      out.selectAliases.push(last.value.toLowerCase());
      return tokens.slice(0, -1);
    }
  }
  return tokens;
}

// --- WHERE -------------------------------------------------------------------

function readWhere(tokens: Token[], out: Partial, notes: string[]): void {
  if (tokens.length === 0) return;
  const orIdx = indexOfWord(tokens, "or", 0, 0);
  if (orIdx !== -1) {
    notes.push("WHERE 含顶层 OR，索引建议按最左前缀交集保守处理");
  }
  for (const pred of splitOnAnd(tokens)) {
    out.columns.push(...classifyPredicate(pred, "where", notes));
  }
}

function classifyPredicate(
  pred: Token[],
  scope: "where" | "join-on",
  notes: string[],
): ColumnRef[] {
  if (pred.length === 0) return [];

  // A parenthesised group: unwrap and retry so `(a = 1)` behaves like `a = 1`.
  if (pred[0]!.value === "(" && matchingClose(pred, 0) === pred.length - 1) {
    return classifyPredicate(pred.slice(1, -1), scope, notes);
  }

  const operator = detectOperator(pred);
  if (!operator) {
    if (!isWord(pred[0], "not", "exists")) {
      notes.push(`无法识别的谓词已跳过：${truncate(tokensToString(pred))}`);
    }
    return [];
  }

  const left = pred.slice(0, operator.index);
  const right = pred.slice(operator.index + 1);
  const baseScope: ColumnRef["scope"] =
    scope === "join-on" ? "join-on" : mapScope(operator.kind);

  const refs: ColumnRef[] = [];
  const leftRef = columnFromTokens(left, baseScope);
  if (!leftRef) return [];
  leftRef.op = operator.text;
  leftRef.parameterized = right.some((t) => t.type === "param");
  leftRef.valueText = truncate(tokensToString(right), 80);
  leftRef.predicateText = tokensToString(pred);
  refs.push(leftRef);

  switch (operator.kind) {
    case "eq": {
      // `a.col = b.col` constrains both sides, so both are index candidates.
      const rightRef = columnFromTokens(right, baseScope);
      if (rightRef && !isWord(right[0], "null")) {
        rightRef.op = operator.text;
        rightRef.predicateText = tokensToString(pred);
        rightRef.valueText = leftRef.raw;
        refs.push(rightRef);
      }
      break;
    }
    case "like": {
      const literal = right.find((t) => t.type === "string");
      leftRef.op = literal?.value.startsWith("'%") ? "like-middle" : "like-prefix";
      break;
    }
    case "in": {
      if (right.some((t) => isWord(t, "select"))) leftRef.op = "in-subquery";
      break;
    }
    default:
      break;
  }

  return refs;
}

type OperatorKind = "eq" | "range" | "in" | "like" | "is-null" | "between";

interface Operator {
  kind: OperatorKind;
  /** Token index of the operator. */
  index: number;
  /** Normalised operator text, e.g. `=`, `>=`, `in`, `like`. */
  text: string;
}

const RANGE_PUNCT = new Set([">", "<", ">=", "<=", "!=", "<>"]);

function detectOperator(pred: Token[]): Operator | undefined {
  for (let i = 0; i < pred.length; i += 1) {
    const t = pred[i]!;
    if (t.depth !== 0) continue;

    if (t.type === "punct") {
      if (t.value === "=") return { kind: "eq", index: i, text: "=" };
      if (RANGE_PUNCT.has(t.value)) return { kind: "range", index: i, text: t.value };
      continue;
    }
    if (t.type !== "word") continue;

    const v = t.value.toLowerCase();
    if (v === "in") return { kind: "in", index: i, text: "in" };
    if (v === "between") return { kind: "between", index: i, text: "between" };
    if (v === "like" || v === "regexp" || v === "rlike") {
      return { kind: "like", index: i, text: v };
    }
    if (v === "is") return { kind: "is-null", index: i, text: "is" };
  }
  return undefined;
}

function mapScope(kind: OperatorKind): ColumnRef["scope"] {
  switch (kind) {
    case "eq":
      return "where-eq";
    case "in":
      return "where-in";
    case "range":
      return "where-range";
    case "between":
      return "where-range";
    case "like":
      return "where-like-prefix";
    case "is-null":
      return "where-null";
  }
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- column extraction -------------------------------------------------------

/**
 * Turn `DATE(create_time)`, `o.status`, `col + 1` into a ColumnRef.
 * `wrapped` marks "an expression sits on top of the column", which is exactly
 * what invalidates an index (SIA004).
 */
function columnFromTokens(
  tokens: Token[],
  scope: ColumnRef["scope"],
): ColumnRef | undefined {
  const cleaned = tokens.filter((t) => !isWord(t, "not", "distinct"));
  if (cleaned.length === 0) return undefined;

  const raw = tokensToString(cleaned);
  const wrapped = cleaned.some((t) => t.value === "(") || cleaned.some((t) =>
    t.depth === 0 && t.type === "punct" && ["+", "-", "*", "/", "%", "^", "|"].includes(t.value),
  );

  if (wrapped) {
    const inner = innerColumnTokens(cleaned);
    if (!inner) return undefined;
    const ref = plainColumn(inner, scope);
    return ref ? { ...ref, raw, wrapped: true } : undefined;
  }

  const ref = plainColumn(cleaned, scope);
  return ref ? { ...ref, raw } : undefined;
}

/**
 * Pull the column out of an expression that sits on top of it:
 * `DATE(create_time)` -> `create_time`, `amount + 0` -> `amount`.
 */
function innerColumnTokens(tokens: Token[]): Token[] | undefined {
  const open = tokens.findIndex((t) => t.value === "(");
  if (open === -1) {
    const words = tokens.filter((t) => t.type === "word" && !RESERVED.has(t.value.toLowerCase()));
    return words.length > 0 ? words : undefined;
  }

  const fn = tokens[open - 1];
  if (fn && AGGREGATES.has(fn.value.toLowerCase())) return undefined;
  const close = matchingClose(tokens, open);
  const args = splitOnComma(tokens.slice(open + 1, close));
  const firstArg = args[0];
  if (!firstArg) return undefined;
  if (firstArg.every((t) => t.type === "number" || t.type === "string" || t.value === "*")) {
    return undefined;
  }
  return firstArg.filter((t) => t.value !== "*");
}

function plainColumn(tokens: Token[], scope: ColumnRef["scope"]): ColumnRef | undefined {
  const parts = tokens.filter((t) => t.type === "word");
  if (parts.length === 0) return undefined;
  if (parts.length === 1) {
    const name = parts[0]!;
    if (RESERVED.has(name.value.toLowerCase())) return undefined;
    return { raw: name.value, column: name.value.toLowerCase(), scope };
  }
  if (parts.length === 2 && tokens.some((t) => t.value === ".")) {
    return {
      raw: `${parts[0]!.value}.${parts[1]!.value}`,
      table: parts[0]!.value.toLowerCase(),
      column: parts[1]!.value.toLowerCase(),
      scope,
    };
  }
  if (parts.length === 3 && tokens.some((t) => t.value === ".")) {
    // db.table.column
    return {
      raw: parts.map((p) => p.value).join("."),
      table: parts[1]!.value.toLowerCase(),
      column: parts[2]!.value.toLowerCase(),
      scope,
    };
  }
  return undefined;
}

// --- ORDER BY / LIMIT --------------------------------------------------------

function readColumnList(tokens: Token[], target: ColumnRef[], scope: ColumnRef["scope"], notes: string[], label: string): void {
  if (tokens.length === 0) return;
  for (const item of splitOnComma(tokens)) {
    const ref = columnFromTokens(item, scope);
    if (ref) target.push(ref);
    else notes.push(`${label} 中的表达式无法静态分析：${truncate(tokensToString(item))}`);
  }
}

function readOrderList(tokens: Token[], notes: string[]): ColumnRef[] {
  const refs: ColumnRef[] = [];
  for (const item of splitOnComma(tokens)) {
    let desc = false;
    let body = item;
    const last = item[item.length - 1];
    if (last && isWord(last, "asc", "desc")) {
      desc = isWord(last, "desc");
      body = item.slice(0, -1);
    }
    const ref = columnFromTokens(body, "order-by");
    if (ref) refs.push({ ...ref, desc });
    else notes.push(`ORDER BY 中的表达式无法静态分析：${truncate(tokensToString(body))}`);
  }
  return refs;
}

function readLimit(tokens: Token[]): LimitClause | undefined {
  const meaningful = tokens.filter((t) => t.depth === 0);
  if (meaningful.length === 0) return undefined;
  const raw = tokensToString(meaningful);

  const num = (t: Token | undefined): number | undefined =>
    t && t.type === "number" ? Number(t.value) : undefined;

  const first = meaningful[0];
  const second = meaningful[1];
  const third = meaningful[2];

  if (first && isWord(first, "all")) return { raw, literal: false };

  if (second && second.type === "punct" && second.value === ",") {
    return {
      offset: num(first),
      rowCount: num(third),
      literal: num(first) !== undefined && num(third) !== undefined,
      raw,
    };
  }
  if (second && isWord(second, "offset")) {
    return {
      rowCount: num(first),
      offset: num(third),
      literal: num(first) !== undefined && num(third) !== undefined,
      raw,
    };
  }
  return { rowCount: num(first), literal: num(first) !== undefined, raw };
}

// --- helpers for rules -------------------------------------------------------

/** Resolve an alias qualifier to the real table name. */
export function resolveTable(ref: ColumnRef, parsed: ParsedQuery): string | undefined {
  if (!ref.table) return parsed.tables.length === 1 ? parsed.tables[0]!.name : undefined;
  const hit = parsed.tables.find((t) => t.alias?.toLowerCase() === ref.table || t.name.toLowerCase() === ref.table);
  return hit?.name;
}
