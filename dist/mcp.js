#!/usr/bin/env node

// src/mcp/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z3 } from "zod";

// src/mcp/tools.ts
import { existsSync as existsSync2, readFileSync as readFileSync5 } from "fs";
import { z as z2 } from "zod";

// src/core/types.ts
var SEVERITY_ORDER = {
  error: 3,
  warn: 2,
  info: 1
};
var DEFAULT_RULE_OPTIONS = {
  mysqlVersion: 8,
  prefixBytes: 3072,
  deepOffsetThreshold: 1e4,
  minSeverity: "info"
};

// src/parsers/fingerprint.ts
var QUOTES = ["'", '"', "`"];
function stripComments(sql) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < sql.length) {
        out += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (QUOTES.includes(ch)) {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-" && (sql[i + 2] === " " || sql[i + 2] === "	") || ch === "#" && sql[i + 1] !== "{") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
function maskLiterals(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i];
        if (c === "\\" && quote === "'") {
          i += 2;
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += "?";
      continue;
    }
    if ((ch === "-" || ch === "+") && UNARY_CONTEXT.includes(lastMeaningful(out)) && isDigit(sql[i + 1] ?? "")) {
      i = scanNumber(sql, i + 1);
      out += "?";
      continue;
    }
    if (isDigit(ch) || ch === "." && isDigit(sql[i + 1] ?? "")) {
      const prev = out[out.length - 1];
      if (!prev || !isIdentChar(prev)) {
        i = scanNumber(sql, i);
        out += "?";
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}
function collapseInLists(sql) {
  return sql.replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)");
}
var UNARY_CONTEXT = "=<>(),!+-*/";
function lastMeaningful(text) {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch !== " " && ch !== "	" && ch !== "\n" && ch !== "\r") return ch;
  }
  return "";
}
function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}
function scanNumber(sql, start) {
  let i = start;
  while (i < sql.length && (isDigit(sql[i]) || sql[i] === ".")) i += 1;
  if (sql[i] === "e" || sql[i] === "E") {
    const sign = sql[i + 1];
    const afterSign = sign === "+" || sign === "-" ? sql[i + 2] : void 0;
    if (isDigit(sql[i + 1] ?? "") || afterSign !== void 0 && isDigit(afterSign)) {
      i += sign === "+" || sign === "-" ? 3 : 2;
      while (i < sql.length && isDigit(sql[i])) i += 1;
    }
  }
  return i;
}
function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}
function fingerprint(sql) {
  const masked = maskLiterals(stripComments(sql));
  return collapseInLists(masked).replace(/\s+/g, " ").replace(/\s*([(),;=<>!])\s*/g, "$1").replace(/;+$/g, "").trim().toLowerCase();
}
function evidence(sql, maxLen = 200) {
  const oneLine = stripComments(sql).replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}\u2026` : oneLine;
}

// src/parsers/token.ts
var WORD_START = /[A-Za-z_$一-龥]/;
var WORD_BODY = /[A-Za-z0-9_$一-龥]/;
var PUNCT_TWO = /* @__PURE__ */ new Set(["!=", "<>", ">=", "<=", "&&", "||"]);
var PUNCT_ONE = "(),;=<>!+-*/%&|^~.:[]{}?\\";
function tokenize(sql) {
  const tokens = [];
  let depth = 0;
  let i = 0;
  const push = (value, type, start, end, d) => {
    tokens.push({ value, type, start, end, depth: d });
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      push(sql.slice(start, i), "string", start, i, depth);
      continue;
    }
    if (ch === "`") {
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== "`") i += 1;
      i += 1;
      push(sql.slice(start + 1, i - 1), "word", start, i, depth);
      continue;
    }
    if (ch === "?" || ch === ":") {
      const start = i;
      i += 1;
      while (i < sql.length && WORD_BODY.test(sql[i])) i += 1;
      push(sql.slice(start, i), "param", start, i, depth);
      continue;
    }
    if (ch === "#" || ch === "$") {
      if (sql[i + 1] === "{") {
        const start = i;
        const close = sql.indexOf("}", i);
        i = close === -1 ? sql.length : close + 1;
        push(sql.slice(start, i), "param", start, i, depth);
        continue;
      }
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[0-9.]/.test(sql[i])) i += 1;
      if (sql[i] === "e" || sql[i] === "E") {
        const next = sql[i + 1];
        if (/[0-9]/.test(next ?? "")) {
          i += 2;
          while (i < sql.length && /[0-9]/.test(sql[i])) i += 1;
        } else if ((next === "+" || next === "-") && /[0-9]/.test(sql[i + 2] ?? "")) {
          i += 3;
          while (i < sql.length && /[0-9]/.test(sql[i])) i += 1;
        }
      }
      push(sql.slice(start, i), "number", start, i, depth);
      continue;
    }
    if (WORD_START.test(ch)) {
      const start = i;
      while (i < sql.length && WORD_BODY.test(sql[i])) i += 1;
      push(sql.slice(start, i), "word", start, i, depth);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (PUNCT_TWO.has(two)) {
      push(two, "punct", i, i + 2, depth);
      i += 2;
      continue;
    }
    if (ch === "(") {
      push("(", "punct", i, i + 1, depth);
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      push(")", "punct", i, i + 1, depth);
      i += 1;
      continue;
    }
    if (PUNCT_ONE.includes(ch)) {
      push(ch, "punct", i, i + 1, depth);
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}
function isWord(token, ...words) {
  if (!token || token.type !== "word") return false;
  const v = token.value.toLowerCase();
  return words.includes(v);
}
function indexOfWord(tokens, word, from = 0, depth = 0) {
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.depth === depth && isWord(t, word)) return i;
  }
  return -1;
}
function indexOfPunct(tokens, punct, from = 0, depth = 0) {
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.depth === depth && t.type === "punct" && t.value === punct) return i;
  }
  return -1;
}
function splitOnAnd(tokens) {
  const groups = [];
  let current = [];
  let pendingBetween = false;
  for (const t of tokens) {
    if (t.depth === 0 && isWord(t, "between")) pendingBetween = true;
    if (t.depth === 0 && isWord(t, "and") && pendingBetween) {
      pendingBetween = false;
      current.push(t);
      continue;
    }
    if (t.depth === 0 && isWord(t, "and")) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  groups.push(current);
  return groups.filter((g) => g.length > 0);
}
function splitOnComma(tokens) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    if (t.depth === 0 && t.type === "punct" && t.value === ",") {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  groups.push(current);
  return groups.filter((g) => g.length > 0);
}
var SQL_KEYWORDS = /* @__PURE__ */ new Set(["in", "not", "and", "or", "is", "like", "between", "using", "values"]);
function tokensToString(tokens) {
  const spaced = tokens.map((t) => t.value).join(" ");
  return spaced.replace(/\s*\.\s*/g, ".").replace(/\s*,\s*/g, ", ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(
    /([A-Za-z_]\w*)\s+\(/g,
    (match, word) => SQL_KEYWORDS.has(word.toLowerCase()) ? match : `${word}(`
  ).replace(/\s+/g, " ").trim();
}

// src/parsers/sql.ts
var RESERVED = /* @__PURE__ */ new Set([
  "and",
  "or",
  "not",
  "null",
  "is",
  "in",
  "like",
  "between",
  "select",
  "from",
  "where",
  "group",
  "order",
  "by",
  "limit",
  "offset",
  "having",
  "join",
  "on",
  "using",
  "as",
  "asc",
  "desc",
  "case",
  "when",
  "then",
  "else",
  "end",
  "exists",
  "interval",
  "true",
  "false",
  "distinct",
  "all",
  "union",
  "default"
]);
var AGGREGATES = /* @__PURE__ */ new Set(["count", "sum", "avg", "min", "max", "group_concat"]);
var STATEMENT_STARTERS = /* @__PURE__ */ new Set(["select", "insert", "update", "delete", "replace", "with"]);
var SET_OPERATORS = /* @__PURE__ */ new Set(["union", "intersect", "except"]);
function countMergedStatements(tokens) {
  let seenFrom = false;
  let merged = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.depth !== 0 || t.type !== "word") continue;
    const word = t.value.toLowerCase();
    if (word === "from") {
      seenFrom = true;
      continue;
    }
    if (!seenFrom || !STATEMENT_STARTERS.has(word)) continue;
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    if (prev && SET_OPERATORS.has(prev.value.toLowerCase())) continue;
    if (prev && isWord(prev, "all") && prev2 && SET_OPERATORS.has(prev2.value.toLowerCase())) continue;
    merged += 1;
  }
  return merged;
}
function splitStatements(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-" && (text[i + 2] === " " || text[i + 2] === "	") || ch === "#" && text[i + 1] !== "{") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}
function parseSql(input) {
  const notes = [];
  const empty = {
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
    notes: []
  };
  try {
    const tokens = tokenize(stripComments(input));
    if (tokens.length === 0) {
      return { ...empty, notes: ["\u7A7A\u8BED\u53E5\uFF0C\u5DF2\u8DF3\u8FC7"] };
    }
    const merged = countMergedStatements(tokens);
    if (merged > 0) {
      return {
        ...empty,
        notes: [
          `\u8FD9\u6761\u8F93\u5165\u91CC\u6DF7\u4E86 ${merged + 1} \u4E2A\u8BED\u53E5\u4F46\u6CA1\u6709\u4EFB\u4F55\u5206\u53F7\u5206\u9694\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A\u628A\u5B83\u4EEC\u5F53\u6210\u4E00\u6761\u89E3\u6790\u4F1A\u7ED9\u51FA\u8DE8\u8868\u7684\u7D22\u5F15\u5EFA\u8BAE\u3002\u6BCF\u6761\u8BED\u53E5\u8BF7\u4EE5 ; \u7ED3\u5C3E\u3002`
        ]
      };
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
      notes
    };
  } catch (err) {
    return {
      ...empty,
      notes: [`\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${err.message}`]
    };
  }
}
function statementKind(tokens) {
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
function blank() {
  return {
    tables: [],
    columns: [],
    selectColumns: [],
    selectAliases: [],
    selectStar: false,
    orderBy: [],
    groupBy: []
  };
}
function analyse(kind, tokens, notes) {
  const topUnion = indexOfWord(tokens, "union", 0, 0);
  if (topUnion !== -1) {
    notes.push("UNION \u8BED\u53E5\u53EA\u5206\u6790\u7B2C\u4E00\u4E2A\u5206\u652F");
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
      notes.push("\u4E0D\u652F\u6301\u7684\u8BED\u53E5\u7C7B\u578B\uFF0C\u5DF2\u8DF3\u8FC7\uFF08\u652F\u6301 SELECT / INSERT / UPDATE / DELETE\uFF09");
      return blank();
  }
}
function findTwoWord(tokens, first, second) {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const t = tokens[i];
    if (t.depth === 0 && isWord(t, first) && isWord(tokens[i + 1], second)) return i;
  }
  return -1;
}
function clauseBoundary(tokens, from) {
  const candidates = [
    indexOfWord(tokens, "where", from, 0),
    findTwoWord(tokens, "group", "by"),
    indexOfWord(tokens, "having", from, 0),
    findTwoWord(tokens, "order", "by"),
    indexOfWord(tokens, "limit", from, 0),
    indexOfWord(tokens, "union", from, 0),
    findTwoWord(tokens, "for", "update")
  ].filter((i) => i > from);
  return candidates.length > 0 ? Math.min(...candidates) : tokens.length;
}
function analyseSelect(tokens, notes) {
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
function findNextClause(tokens, from, fallback) {
  const idxs = [
    indexOfWord(tokens, "where", from + 1, 0),
    findTwoWord(tokens, "group", "by"),
    indexOfWord(tokens, "having", from + 1, 0),
    findTwoWord(tokens, "order", "by"),
    indexOfWord(tokens, "limit", from + 1, 0)
  ].filter((i) => i > from).sort((a, b) => a - b);
  return idxs.length > 0 ? idxs[0] : fallback;
}
function analyseUpdate(tokens, notes) {
  const out = blank();
  const setIdx = indexOfWord(tokens, "set", 0, 0);
  if (setIdx === -1) {
    notes.push("UPDATE \u8BED\u53E5\u7F3A\u5C11 SET\uFF0C\u5DF2\u8DF3\u8FC7");
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
function analyseDelete(tokens, notes) {
  const out = blank();
  const fromIdx = indexOfWord(tokens, "from", 0, 0);
  if (fromIdx === -1) {
    notes.push("DELETE \u8BED\u53E5\u7F3A\u5C11 FROM\uFF0C\u5DF2\u8DF3\u8FC7");
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
function analyseInsert(tokens, notes) {
  const out = blank();
  const intoIdx = indexOfWord(tokens, "into", 0, 0);
  const start = intoIdx === -1 ? 1 : intoIdx + 1;
  let end = start;
  while (end < tokens.length && tokens[end].depth === 0 && tokens[end].value !== "(") end += 1;
  const table = parseTableRef(tokens.slice(start, end), "INSERT");
  if (table) out.tables.push(table);
  if (end < tokens.length && tokens[end].value === "(") {
    const close = matchingClose(tokens, end);
    for (const col of splitOnComma(tokens.slice(end + 1, close))) {
      const ref = columnFromTokens(col, "select");
      if (ref) out.columns.push(ref);
    }
  }
  notes.push("INSERT \u8BED\u53E5\u53EA\u505A\u8868\u8BC6\u522B\uFF0C\u4E0D\u4EA7\u51FA\u7D22\u5F15\u5EFA\u8BAE");
  return out;
}
var JOIN_PARTICLES = /* @__PURE__ */ new Set([
  "left",
  "right",
  "inner",
  "cross",
  "full",
  "outer",
  "natural",
  "straight_join"
]);
function readFrom(tokens, out, notes) {
  let pos = 0;
  let role = "FROM";
  const particles = [];
  const stopsHere = (t) => t.depth === 0 && (t.type === "punct" ? t.value === "," : isWord(t, "join", "on", "using"));
  while (pos < tokens.length) {
    const start = pos;
    while (pos < tokens.length && !stopsHere(tokens[pos])) pos += 1;
    let tableTokens = tokens.slice(start, pos);
    if (pos < tokens.length && isWord(tokens[pos], "join")) {
      while (tableTokens.length > 0 && JOIN_PARTICLES.has(tableTokens[tableTokens.length - 1].value.toLowerCase())) {
        particles.unshift(tableTokens.pop().value);
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
    const marker = tokens[pos];
    if (marker.type === "punct" && marker.value === ",") {
      pos += 1;
      continue;
    }
    if (isWord(marker, "on")) {
      pos += 1;
      const condStart = pos;
      while (pos < tokens.length && !(tokens[pos].depth === 0 && (tokens[pos].value === "," || isWord(tokens[pos], "join")))) {
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
function pushTable(tokens, role, out, notes) {
  if (tokens[0]?.value === "(") {
    notes.push("FROM \u5B50\u67E5\u8BE2\u672A\u5C55\u5F00\uFF0C\u53EA\u5206\u6790\u5916\u5C42\u6761\u4EF6");
    return;
  }
  const table = parseTableRef(tokens, role);
  if (table) out.tables.push(table);
}
function matchingClose(tokens, openIdx) {
  const depth = tokens[openIdx].depth;
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.value === ")" && t.depth === depth) return i;
  }
  return tokens.length;
}
function parseTableRef(tokens, role) {
  const parts = tokens.filter((t) => !(t.depth === 0 && isWord(t, "as")));
  if (parts.length === 0) return void 0;
  if (parts[0].type !== "word") return void 0;
  let nameIndex = 0;
  const dot = indexOfPunct(parts, ".", 0, 0);
  if (dot !== -1 && parts[dot + 1]?.type === "word") nameIndex = dot + 1;
  const name = parts[nameIndex].value;
  const aliasTok = parts[nameIndex + 1];
  const alias = aliasTok && aliasTok.type === "word" && !JOIN_PARTICLES.has(aliasTok.value.toLowerCase()) ? aliasTok.value : void 0;
  return { name, alias, role };
}
function readSelectList(tokens, out, notes) {
  const list = isWord(tokens[0], "distinct") ? tokens.slice(1) : tokens;
  for (const item of splitOnComma(list)) {
    const asIdx = indexOfWord(item, "as", 0, 0);
    const expr = asIdx === -1 ? stripTrailingAlias(item, out) : item.slice(0, asIdx);
    if (asIdx !== -1 && item[asIdx + 1]?.type === "word") {
      out.selectAliases.push(item[asIdx + 1].value.toLowerCase());
    }
    if (expr.length === 0) continue;
    if (expr.length === 1 && expr[0].value === "*") {
      out.selectStar = true;
      continue;
    }
    const dotStar = expr.findIndex((t, i) => t.value === "*" && i > 0 && expr[i - 1]?.value === ".");
    if (dotStar !== -1) {
      out.selectStar = true;
      continue;
    }
    if (expr.some((t) => t.value === "(")) {
      const isAggregate = expr.some((t) => t.type === "word" && AGGREGATES.has(t.value.toLowerCase()));
      if (!isAggregate) {
        notes.push("SELECT \u542B\u51FD\u6570\u8868\u8FBE\u5F0F\uFF0C\u8986\u76D6\u7D22\u5F15\u5224\u65AD\u6309\u5176\u4F59\u5217\u5904\u7406");
      }
      continue;
    }
    const ref = columnFromTokens(expr, "select");
    if (ref) out.selectColumns.push(ref.column);
  }
}
function stripTrailingAlias(tokens, out) {
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    const endsExpression = prev.type === "word" || prev.value === "*" || prev.value === ")";
    if (last.type === "word" && endsExpression && !RESERVED.has(last.value.toLowerCase())) {
      out.selectAliases.push(last.value.toLowerCase());
      return tokens.slice(0, -1);
    }
  }
  return tokens;
}
function readWhere(tokens, out, notes) {
  if (tokens.length === 0) return;
  const orIdx = indexOfWord(tokens, "or", 0, 0);
  if (orIdx !== -1) {
    notes.push("WHERE \u542B\u9876\u5C42 OR\uFF0C\u7D22\u5F15\u5EFA\u8BAE\u6309\u6700\u5DE6\u524D\u7F00\u4EA4\u96C6\u4FDD\u5B88\u5904\u7406");
  }
  for (const pred of splitOnAnd(tokens)) {
    out.columns.push(...classifyPredicate(pred, "where", notes));
  }
}
function classifyPredicate(pred, scope, notes) {
  if (pred.length === 0) return [];
  if (pred[0].value === "(" && matchingClose(pred, 0) === pred.length - 1) {
    return classifyPredicate(pred.slice(1, -1), scope, notes);
  }
  const operator = detectOperator(pred);
  if (!operator) {
    if (!isWord(pred[0], "not", "exists")) {
      notes.push(`\u65E0\u6CD5\u8BC6\u522B\u7684\u8C13\u8BCD\u5DF2\u8DF3\u8FC7\uFF1A${truncate(tokensToString(pred))}`);
    }
    return [];
  }
  const left = pred.slice(0, operator.index);
  const right = pred.slice(operator.index + 1);
  const baseScope = scope === "join-on" ? "join-on" : mapScope(operator.kind);
  const refs = [];
  const leftRef = columnFromTokens(left, baseScope);
  if (!leftRef) return [];
  leftRef.op = operator.text;
  leftRef.parameterized = right.some((t) => t.type === "param");
  leftRef.valueText = truncate(tokensToString(right), 80);
  leftRef.predicateText = tokensToString(pred);
  refs.push(leftRef);
  switch (operator.kind) {
    case "eq": {
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
var RANGE_PUNCT = /* @__PURE__ */ new Set([">", "<", ">=", "<=", "!=", "<>"]);
function detectOperator(pred) {
  for (let i = 0; i < pred.length; i += 1) {
    const t = pred[i];
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
  return void 0;
}
function mapScope(kind) {
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
function truncate(text, max = 60) {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
function columnFromTokens(tokens, scope) {
  const cleaned = tokens.filter((t) => !isWord(t, "not", "distinct"));
  if (cleaned.length === 0) return void 0;
  const raw = tokensToString(cleaned);
  const wrapped = cleaned.some((t) => t.value === "(") || cleaned.some(
    (t) => t.depth === 0 && t.type === "punct" && ["+", "-", "*", "/", "%", "^", "|"].includes(t.value)
  );
  if (wrapped) {
    const inner = innerColumnTokens(cleaned);
    if (!inner) return void 0;
    const ref2 = plainColumn(inner, scope);
    return ref2 ? { ...ref2, raw, wrapped: true } : void 0;
  }
  const ref = plainColumn(cleaned, scope);
  return ref ? { ...ref, raw } : void 0;
}
function innerColumnTokens(tokens) {
  const open = tokens.findIndex((t) => t.value === "(");
  if (open === -1) {
    const words = tokens.filter((t) => t.type === "word" && !RESERVED.has(t.value.toLowerCase()));
    return words.length > 0 ? words : void 0;
  }
  const fn = tokens[open - 1];
  if (fn && AGGREGATES.has(fn.value.toLowerCase())) return void 0;
  const close = matchingClose(tokens, open);
  const args = splitOnComma(tokens.slice(open + 1, close));
  const firstArg = args[0];
  if (!firstArg) return void 0;
  if (firstArg.every((t) => t.type === "number" || t.type === "string" || t.value === "*")) {
    return void 0;
  }
  return firstArg.filter((t) => t.value !== "*");
}
function plainColumn(tokens, scope) {
  const parts = tokens.filter((t) => t.type === "word");
  if (parts.length === 0) return void 0;
  if (parts.length === 1) {
    const name = parts[0];
    if (RESERVED.has(name.value.toLowerCase())) return void 0;
    return { raw: name.value, column: name.value.toLowerCase(), scope };
  }
  if (parts.length === 2 && tokens.some((t) => t.value === ".")) {
    return {
      raw: `${parts[0].value}.${parts[1].value}`,
      table: parts[0].value.toLowerCase(),
      column: parts[1].value.toLowerCase(),
      scope
    };
  }
  if (parts.length === 3 && tokens.some((t) => t.value === ".")) {
    return {
      raw: parts.map((p) => p.value).join("."),
      table: parts[1].value.toLowerCase(),
      column: parts[2].value.toLowerCase(),
      scope
    };
  }
  return void 0;
}
function readColumnList(tokens, target, scope, notes, label) {
  if (tokens.length === 0) return;
  for (const item of splitOnComma(tokens)) {
    const ref = columnFromTokens(item, scope);
    if (ref) target.push(ref);
    else notes.push(`${label} \u4E2D\u7684\u8868\u8FBE\u5F0F\u65E0\u6CD5\u9759\u6001\u5206\u6790\uFF1A${truncate(tokensToString(item))}`);
  }
}
function readOrderList(tokens, notes) {
  const refs = [];
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
    else notes.push(`ORDER BY \u4E2D\u7684\u8868\u8FBE\u5F0F\u65E0\u6CD5\u9759\u6001\u5206\u6790\uFF1A${truncate(tokensToString(body))}`);
  }
  return refs;
}
function readLimit(tokens) {
  const meaningful = tokens.filter((t) => t.depth === 0);
  if (meaningful.length === 0) return void 0;
  const raw = tokensToString(meaningful);
  const num = (t) => t && t.type === "number" ? Number(t.value) : void 0;
  const first = meaningful[0];
  const second = meaningful[1];
  const third = meaningful[2];
  if (first && isWord(first, "all")) return { raw, literal: false };
  if (second && second.type === "punct" && second.value === ",") {
    return {
      offset: num(first),
      rowCount: num(third),
      literal: num(first) !== void 0 && num(third) !== void 0,
      raw
    };
  }
  if (second && isWord(second, "offset")) {
    return {
      rowCount: num(first),
      offset: num(third),
      literal: num(first) !== void 0 && num(third) !== void 0,
      raw
    };
  }
  return { rowCount: num(first), literal: num(first) !== void 0, raw };
}
function resolveTable(ref, parsed) {
  if (!ref.table) return parsed.tables.length === 1 ? parsed.tables[0].name : void 0;
  const hit = parsed.tables.find((t) => t.alias?.toLowerCase() === ref.table || t.name.toLowerCase() === ref.table);
  return hit?.name;
}

// src/schema/loader.ts
import { z } from "zod";
import { readFileSync } from "fs";
var optionalText = z.string().nullish();
var optionalNumber = z.number().nullish();
var columnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  length: optionalNumber,
  nullable: z.boolean().optional(),
  charset: optionalText
});
var indexSchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string()).min(1),
  unique: z.boolean().optional(),
  primary: z.boolean().optional(),
  subParts: z.array(z.number().nullable()).optional()
});
var tableSchema = z.object({
  name: z.string().min(1),
  engine: optionalText,
  charset: optionalText,
  columns: z.array(columnSchema).min(1),
  indexes: z.array(indexSchema).default([]),
  rowCountEstimate: optionalNumber
});
var schemaFileSchema = z.object({
  mysqlVersion: optionalText,
  tables: z.array(tableSchema).min(1)
});
function validateSchema(input) {
  const parsed = schemaFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      )
    };
  }
  const tables = parsed.data.tables.map((t) => ({
    name: t.name.toLowerCase(),
    engine: t.engine ?? void 0,
    charset: t.charset ?? void 0,
    rowCountEstimate: t.rowCountEstimate ?? void 0,
    columns: t.columns.map((c) => ({
      name: c.name.toLowerCase(),
      type: c.type.toLowerCase(),
      length: c.length ?? void 0,
      nullable: c.nullable,
      charset: c.charset ?? void 0
    })),
    indexes: t.indexes.map((i) => ({
      name: i.name,
      columns: i.columns.map((c) => c.toLowerCase()),
      unique: i.unique,
      primary: i.primary,
      subParts: i.subParts
    }))
  }));
  return {
    schema: { mysqlVersion: parsed.data.mysqlVersion ?? void 0, tables },
    errors: []
  };
}
function findTable(schema, name) {
  if (!schema) return void 0;
  const lower = name.toLowerCase();
  return schema.tables.find((t) => t.name === lower);
}
function findColumn(table, column) {
  return table?.columns.find((c) => c.name === column.toLowerCase());
}
function columnKeyBytes(column, charset = "utf8mb4") {
  const bytesPerChar2 = charsetBytes(charset);
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
      return (column.length ?? 1) * bytesPerChar2;
    case "varchar":
      return (column.length ?? 255) * bytesPerChar2;
    case "text":
    case "mediumtext":
    case "longtext":
      return Infinity;
    default:
      return 8;
  }
}
function charsetBytes(charset) {
  if (charset.startsWith("utf8mb4")) return 4;
  if (charset.startsWith("utf8")) return 3;
  if (charset.startsWith("latin1") || charset.startsWith("ascii")) return 1;
  return 4;
}

// src/rules/helpers.ts
var EQ_OPS = /* @__PURE__ */ new Set(["=", "in", "in-subquery", "like-prefix"]);
var PREDICATE_SCOPES = /* @__PURE__ */ new Set([
  "where-eq",
  "where-in",
  "where-range",
  "where-like-prefix",
  "where-null",
  "join-on"
]);
var RANGE_OPS = /* @__PURE__ */ new Set([">", "<", ">=", "<=", "!=", "<>", "between", "like-middle"]);
function bucketByTable(parsed, schema) {
  if (parsed.tables.length === 0) return [];
  const buckets = /* @__PURE__ */ new Map();
  const ensure = (name, alias, isDriving = false) => {
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
        schemaTable: findTable(schema, name)
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
    if (parsed.selectAliases.includes(ref.column) && !parsed.selectColumns.includes(ref.column)) {
      continue;
    }
    const table = resolveTable(ref, parsed);
    if (!table) continue;
    const bucket = ensure(table);
    bucket.all.push(ref);
    if (ref.wrapped) {
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
  for (const bucket of buckets.values()) {
    bucket.equality.sort((a, b) => rank(a) - rank(b));
  }
  return [...buckets.values()];
}
function rank(ref) {
  if (ref.scope === "where-eq") return 0;
  if (ref.scope === "where-null") return 1;
  return 2;
}
function dedupeColumns(refs) {
  const seen = /* @__PURE__ */ new Map();
  for (const ref of refs) {
    if (!seen.has(ref.column)) seen.set(ref.column, ref);
  }
  return [...seen.values()];
}
function indexName(table, columns) {
  const base = `idx_${table}_${columns.join("_")}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return base.length > 64 ? base.slice(0, 64).replace(/_+$/, "") : base;
}
function quoteIdent(name) {
  return `\`${name}\``;
}
function addIndexDdl(table, columns, unique = false) {
  const names = columns.map((c) => quoteIdent(c)).join(", ");
  return `ALTER TABLE ${quoteIdent(table)} ADD ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(
    indexName(table, columns)
  )} (${names});`;
}
function oversizedColumns(table, columns, options) {
  if (!table) return [];
  const charset = table.charset ?? "utf8mb4";
  return columns.map((c) => table.columns.find((col) => col.name === c.toLowerCase())).filter((c) => !!c).filter((c) => columnKeyBytes(c, charset) > options.prefixBytes / 2);
}
function isStringType(type) {
  return ["varchar", "char", "text", "tinytext", "mediumtext", "longtext", "enum"].includes(type);
}
function bytesPerChar(table) {
  return charsetBytes(table?.charset ?? "utf8mb4");
}
var PRACTICAL_MAX_PREFIX_CHARS = 128;
function isDynamicTable(name) {
  return /[?${}]/.test(name) || /_$/.test(name);
}
function suggestPrefixChars(column, table, options) {
  const perChar = bytesPerChar(table);
  const budget = options.mysqlVersion >= 8 ? 3072 : 767;
  const byBytes = Math.floor(Math.min(budget, options.prefixBytes) / perChar);
  const declared = column.length ?? 64;
  return Math.max(8, Math.min(declared, byBytes, PRACTICAL_MAX_PREFIX_CHARS));
}
function truncateSql(sql, max = 200) {
  return sql.length > max ? `${sql.slice(0, max - 1)}\u2026` : sql;
}
function replacePredicate(sql, from, to) {
  const tokens = tokenize(from);
  if (tokens.length === 0) return void 0;
  const pattern = tokens.map((t) => escapeRegExp(t.value)).join("\\s*");
  const re = new RegExp(`(?<![\\w.])${pattern}`, "i");
  if (!re.test(sql)) return void 0;
  return sql.replace(re, () => to);
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDateLiteral(text) {
  const cleaned = text.replace(/'/g, "").trim();
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(cleaned);
  if (!match) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date;
}
function formatDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
function numericLiteral(text) {
  if (!text) return void 0;
  const trimmed = text.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : void 0;
}

// src/rules/sia001.ts
var RULE_ID = "SIA001";
var sia001 = {
  id: RULE_ID,
  title: "\u7F3A\u5931\u7D22\u5F15\u5019\u9009",
  titleEn: "Missing index candidate",
  needsSchema: false,
  needsMetrics: false,
  run(ctx) {
    const { record, schema, options } = ctx;
    if (!["select", "update", "delete"].includes(record.parsed.kind)) return [];
    const buckets = bucketByTable(record.parsed, schema);
    const findings = [];
    for (const bucket of buckets) {
      const table = findTable(schema, bucket.table);
      if (isDynamicTable(bucket.table)) {
        findings.push(dynamicTableFinding(record, bucket));
        continue;
      }
      const candidate = candidateColumns(bucket, table);
      if (candidate.length === 0) continue;
      const dropped = unindexableColumns(table, candidate, options);
      const usable = candidate.filter((c) => !dropped.includes(c));
      if (usable.length === 0) continue;
      if (alreadyCovered(table, usable)) continue;
      if (isPrimaryKeyLookup(table, usable, bucket)) continue;
      if (!table && looksLikePrimaryKeyOnly(usable)) continue;
      if (resolvesByUniqueLookup(table, bucket)) continue;
      if (resolvesByPrimaryKeyIn(table, bucket)) continue;
      if (equalityAlreadyIndexed(table, bucket)) continue;
      const ddl = addIndexDdl(bucket.table, usable);
      const prefixHit = table?.indexes.find((i) => i.columns[0] === usable[0]);
      const lowCardinalityRisk = isFlagColumn(usable, table);
      const severity = lowCardinalityRisk ? "info" : table ? prefixHit ? "warn" : "error" : "info";
      findings.push({
        rule: RULE_ID,
        severity,
        sql: truncateSql(record.parsed.sql),
        fingerprint: record.fingerprint,
        source: record.source,
        queryTime: record.metrics?.queryTime,
        rowsExamined: record.metrics?.rowsExamined ?? record.maxRowsExamined,
        occurrences: record.occurrences,
        needsSchema: false,
        needsMetrics: false,
        table: bucket.table,
        indexColumns: usable,
        lowCardinalityRisk,
        suggestedDDL: [ddl],
        message: [
          buildMessage(bucket, usable, dropped, table ? prefixHit : void 0, !!table, !!schema),
          ...lowCardinalityRisk ? [FLAG_CAUTION] : []
        ].join(" "),
        messageEn: [
          buildMessageEn(bucket, usable, dropped, table ? prefixHit : void 0, !!table, !!schema),
          ...lowCardinalityRisk ? [
            "Every column here is a boolean or flag-shaped one, so even the combination may separate almost nothing: check COUNT(DISTINCT ...) / COUNT(*) before creating it."
          ] : []
        ].join(" ")
      });
    }
    return findings;
  }
};
function candidateColumns(bucket, table) {
  const equality = dedupeColumns(bucket.equality.filter((r) => !isJoinOutputKey(r, table)));
  const ordering = dedupeColumns([...bucket.grouping, ...bucket.ordering]);
  const inList = dedupeColumns(bucket.inList).filter((c) => !equality.some((e) => e.column === c.column));
  const range = dedupeColumns(bucket.range).filter(
    (c) => ![...equality, ...ordering, ...inList].some((o) => o.column === c.column)
  );
  const ordered = [];
  const orderingUsable = range.length === 0 || ordering.length > 0;
  ordered.push(...equality);
  if (orderingUsable) ordered.push(...ordering);
  ordered.push(...inList.slice(0, 1));
  if (orderingUsable) ordered.push(...range.slice(0, 1));
  const names = [];
  for (const ref of ordered) {
    if (!names.includes(ref.column)) names.push(ref.column);
    if (names.length >= 4) break;
  }
  return names;
}
function singlePrimaryKey(table) {
  const pk = table?.indexes.find((i) => i.primary);
  return pk && pk.columns.length === 1 ? pk.columns[0] : void 0;
}
function isJoinOutputKey(ref, table) {
  if (ref.scope !== "join-on") return false;
  const pk = singlePrimaryKey(table);
  if (!pk || ref.column !== pk) return false;
  return true;
}
function unindexableColumns(table, columns, options) {
  if (!table) return [];
  return oversizedColumns(table, columns, options).map((c) => c.name);
}
function alreadyCovered(table, columns) {
  if (!table) return false;
  return table.indexes.some(
    (index) => columns.every((column, position) => index.columns[position] === column)
  );
}
function isPrimaryKeyLookup(table, columns, bucket) {
  if (!bucket.isDriving || columns.length !== 1) return false;
  const pk = table?.indexes.find((i) => i.primary);
  return !!pk && pk.columns.length === 1 && pk.columns[0] === columns[0];
}
function looksLikePrimaryKeyOnly(columns) {
  return columns.length === 1 && columns[0] === "id";
}
function resolvesByUniqueLookup(table, bucket) {
  if (!table) return false;
  const equality = whereEqualityColumns(bucket);
  if (equality.length === 0) return false;
  return table.indexes.some(
    (index) => (index.primary || index.unique) && index.columns.length === 1 && equality.includes(index.columns[0])
  );
}
function resolvesByPrimaryKeyIn(table, bucket) {
  if (!table) return false;
  const pk = table.indexes.find((i) => i.primary);
  if (!pk || pk.columns.length !== 1) return false;
  const pkColumn = pk.columns[0];
  return bucket.inList.some((ref) => ref.column === pkColumn && (ref.op ?? "in") === "in");
}
function whereEqualityColumns(bucket) {
  return dedupeColumns(bucket.equality.filter((r) => r.scope !== "join-on")).map((c) => c.column);
}
function equalityAlreadyIndexed(table, bucket) {
  if (!table) return false;
  const equality = whereEqualityColumns(bucket);
  if (equality.length === 0) return false;
  return table.indexes.some(
    (index) => equality.every((column, position) => index.columns[position] === column)
  );
}
var FLAG_NAMES = /^(is_|has_|can_|enabled?|disabled|deleted?|synced?|verified|activated?|expired?|valid|invalid|active|inactive|state|status|type|kind|flag)$/;
var FLAG_CAUTION = "\u6CE8\u610F\uFF1A\u8FD9\u91CC\u7684\u5217\u5168\u662F\u5E03\u5C14/\u6807\u5FD7\u4F4D\u7C7B\u578B\uFF0C\u7EC4\u5408\u8D77\u6765\u7684\u533A\u5206\u5EA6\u4E5F\u53EF\u80FD\u6781\u4F4E\uFF0C\u4F18\u5316\u5668\u672A\u5FC5\u4F1A\u9009\u5B83\u3002\u5148\u8DD1 SELECT COUNT(DISTINCT \u52171, \u52172)/COUNT(*) FROM \u8868; \u786E\u8BA4\u6BD4\u503C\u8DB3\u591F\u5C0F\u518D\u5EFA\u3002";
function isFlagColumn(usable, table) {
  if (usable.length === 0) return false;
  const flagLike = usable.every((name) => {
    const column = table?.columns.find((c) => c.name === name);
    if (column && ["tinyint", "bit", "boolean", "bool"].includes(column.type)) return true;
    return FLAG_NAMES.test(name);
  });
  return flagLike;
}
function dynamicTableFinding(record, bucket) {
  return {
    rule: RULE_ID,
    severity: "info",
    sql: truncateSql(record.parsed.sql),
    fingerprint: record.fingerprint,
    source: record.source,
    needsSchema: false,
    needsMetrics: false,
    table: bucket.table,
    suggestedDDL: [],
    message: `\u8868\u540D \`${bucket.table}\` \u662F\u8FD0\u884C\u65F6\u62FC\u51FA\u6765\u7684\uFF08MyBatis \u7684\u52A8\u6001\u8868\u540D\u6216\u5206\u8868\u540E\u7F00\uFF09\uFF0C\u65E0\u6CD5\u4E3A\u5B83\u6307\u5B9A\u67D0\u4E00\u5F20\u771F\u5B9E\u8868\uFF0C\u4E5F\u5C31\u7ED9\u4E0D\u51FA\u53EF\u6267\u884C\u7684 DDL\u3002\u8981\u4F53\u68C0\u8FD9\u7C7B\u8868\uFF0C\u8BF7\u628A\u5B9E\u9645\u8868\u540D\u4F20\u8FDB\u6765\uFF08\`sia query "..."\`\uFF09\u6216\u8005\u6309\u7269\u7406\u8868\u5206\u522B\u5206\u6790\u3002`,
    messageEn: `The table name \`${bucket.table}\` is built at runtime (a MyBatis dynamic table name or a sharding suffix), so no single physical table can be named and no runnable DDL exists for it. Analyse the concrete table names instead, e.g. with \`sia query "..."\`.`
  };
}
function buildMessage(bucket, usable, dropped, prefixHit, hasTable, schemaSupplied) {
  const parts = [
    `${bucket.table} \u4E0A\u6309\u5F53\u524D\u6761\u4EF6\u8BBF\u95EE\u7F3A\u5C11\u53EF\u7528\u7D22\u5F15\uFF0C\u5EFA\u8BAE\u6309\u300C\u7B49\u503C -> \u6392\u5E8F -> \u8303\u56F4\u300D\u987A\u5E8F\u5EFA (${usable.join(", ")})\u3002`,
    `\u6700\u5DE6\u524D\u7F00\uFF1A\u53EA\u6709\u4ECE\u7B2C\u4E00\u5217\u5F00\u59CB\u8FDE\u7EED\u4F7F\u7528\u624D\u80FD\u547D\u4E2D\u8BE5\u7D22\u5F15\u3002`
  ];
  if (prefixHit) {
    parts.push(
      `\u5DF2\u6709\u7D22\u5F15 ${prefixHit.name}(${prefixHit.columns.join(", ")}) \u53EA\u8986\u76D6\u524D\u7F00\uFF0C\u65B0\u7D22\u5F15\u53EF\u7528\u540E\u53EF\u8BC4\u4F30\u662F\u5426\u4E0B\u7EBF\u65E7\u7D22\u5F15\u4EE5\u51CF\u5C11\u5199\u653E\u5927\u3002`
    );
  }
  if (dropped.length > 0) {
    parts.push(`\u5217 ${dropped.join(", ")} \u5355\u5217\u8FC7\u957F\uFF0C\u672A\u7EB3\u5165\u672C\u6B21\u5EFA\u8BAE\uFF0C\u8BF7\u89C1 SIA002 \u524D\u7F00\u7D22\u5F15\u65B9\u6848\u3002`);
  }
  if (!hasTable) {
    parts.push(
      schemaSupplied ? `\u6CE8\u610F\uFF1A\`${bucket.table}\` \u4E0D\u5728\u4F60\u7ED9\u7684 schema.json \u7684\u8868\u6E05\u5355\u91CC\uFF0C\u6240\u4EE5\u73B0\u6709\u7D22\u5F15\u65E0\u4ECE\u5224\u65AD\uFF0C\u8FD9\u6761\u53EA\u662F\u5019\u9009\uFF1B\u8BF7\u786E\u8BA4\u5E93\u540D\u4E0E\u5BFC\u51FA\u662F\u5426\u5BF9\u5F97\u4E0A\u3002` : `\u672A\u63D0\u4F9B --schema\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u5DF2\u6709\u7D22\u5F15\u8986\u76D6\uFF0C\u8BF7\u8865 \`--schema\` \u518D\u770B\u3002`
    );
  }
  return parts.join(" ");
}
function buildMessageEn(bucket, usable, dropped, prefixHit, hasSchema, schemaSupplied) {
  const parts = [
    `Candidate index for ${bucket.table} (${usable.join(", ")}), ordered equality -> group/order -> range; only a contiguous run from the first column can be used.`
  ];
  if (!hasSchema) {
    parts.push(
      schemaSupplied ? `\`${bucket.table}\` is not among the tables in the schema.json you passed, so its existing indexes cannot be checked; confirm the database and the export match.` : "Pass --schema to confirm that nothing already covers this access path."
    );
  } else if (prefixHit) {
    parts.push(
      `Existing index ${prefixHit.name}(${prefixHit.columns.join(", ")}) covers only a left prefix of the proposed one; evaluate dropping it once the new index is live, since keeping both doubles the write cost.`
    );
  } else {
    parts.push("No existing index serves this access path.");
  }
  if (dropped.length > 0) {
    parts.push(
      `Column(s) ${dropped.join(", ")} are too long to index whole and were left out; see SIA002 for a prefix-index option.`
    );
  }
  return parts.join(" ");
}

// src/rules/sia002.ts
var RULE_ID2 = "SIA002";
var sia002 = {
  id: RULE_ID2,
  title: "\u524D\u7F00\u7D22\u5F15",
  titleEn: "Prefix index",
  needsSchema: true,
  needsMetrics: false,
  run(ctx) {
    const { record, schema, options } = ctx;
    const findings = [];
    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;
      const predicateColumns = dedupeColumns([...bucket.equality, ...bucket.inList, ...bucket.range]);
      for (const ref of predicateColumns) {
        const column = findColumn(table, ref.column);
        if (!column || !isStringType(column.type)) continue;
        const bytes = columnKeyBytes(column, table.charset);
        const isBlobLike = column.type.endsWith("text") || column.type === "blob";
        if (!isBlobLike && bytes <= options.prefixBytes / 2) continue;
        const existing = table.indexes.find((i) => i.columns[0] === column.name && i.subParts?.[0]);
        if (existing) continue;
        const prefix = suggestPrefixChars(column, table, options);
        const name = indexName(table.name, [column.name]);
        findings.push({
          rule: RULE_ID2,
          severity: isBlobLike ? "error" : "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          indexColumns: [column.name],
          suggestedDDL: [
            `ALTER TABLE ${quoteIdent(table.name)} ADD INDEX ${quoteIdent(name)} (${quoteIdent(
              column.name
            )}(${prefix}));`
          ],
          message: [
            `${table.name}.${column.name} \u662F ${column.type}${column.length ? `(${column.length})` : ""}\uFF0C`,
            `${isBlobLike ? "\u8BE5\u7C7B\u5217\u5FC5\u987B\u6307\u5B9A\u524D\u7F00\u957F\u5EA6\u624D\u80FD\u5EFA\u7D22\u5F15" : `\u6574\u5217\u952E\u957F\u7EA6 ${bytes} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${options.prefixBytes} \u5B57\u8282\u4E0A\u9650\u7684 1/2`}\u3002`,
            `\u5148\u7528\u8FD9\u6761 SQL \u9A8C\u8BC1\u524D\u7F00\u533A\u5206\u5EA6\uFF0C\u518D\u51B3\u5B9A N\uFF1A`,
            `SELECT COUNT(DISTINCT LEFT(${column.name}, ${prefix})) / COUNT(DISTINCT ${column.name}) AS ratio FROM ${table.name};`,
            `ratio \u63A5\u8FD1 1 \u8BF4\u660E\u524D\u7F00\u8DB3\u591F\uFF1B\u5426\u5219\u8C03\u5927 N \u6216\u6539\u67E5\u8BE2\u6761\u4EF6\u3002`
          ].join(" "),
          messageEn: `${table.name}.${column.name} is too long for a full index key; index a verified prefix instead.`
        });
      }
    }
    return findings;
  }
};

// src/rules/sia003.ts
var RULE_ID3 = "SIA003";
var sia003 = {
  id: RULE_ID3,
  title: "\u6700\u5DE6\u524D\u7F00\u8FDD\u53CD",
  titleEn: "Leftmost-prefix violation",
  needsSchema: true,
  needsMetrics: false,
  run(ctx) {
    const { record, schema } = ctx;
    const findings = [];
    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;
      const used = new Set(
        [...bucket.equality, ...bucket.inList, ...bucket.range, ...bucket.ordering].map((c) => c.column)
      );
      if (used.size === 0) continue;
      for (const index of table.indexes) {
        if (index.columns.length < 2) continue;
        let run = 0;
        while (run < index.columns.length && used.has(index.columns[run])) run += 1;
        if (run === 0) continue;
        const gapIndex = index.columns.findIndex((c, position) => position > run && used.has(c));
        if (gapIndex === -1) continue;
        const skipped = index.columns.slice(run, gapIndex);
        const reached = index.columns.slice(0, run);
        const wanted = [...index.columns.slice(0, run), index.columns[gapIndex]];
        findings.push({
          rule: RULE_ID3,
          severity: "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          indexColumns: wanted,
          suggestedDDL: [addIndexDdl(table.name, wanted)],
          message: [
            `\u7D22\u5F15 ${index.name}(${index.columns.join(", ")}) \u53EA\u80FD\u7528\u5230\u524D ${run} \u5217\uFF08${reached.join(", ")}\uFF09\uFF0C`,
            `\u6761\u4EF6\u8DF3\u8FC7\u4E86 ${skipped.join(", ")} \u5374\u76F4\u63A5\u7528\u4E86 ${index.columns[gapIndex]}\uFF0C`,
            `MySQL \u65E0\u6CD5\u7528 ${index.columns[gapIndex]} \u7F29\u5C0F\u8303\u56F4\uFF0C\u53EA\u80FD\u626B\u63CF ${index.name} \u7684\u6BCF\u4E2A ${reached[reached.length - 1]} \u533A\u95F4\uFF08EXPLAIN \u7684 key \u4ECD\u663E\u793A\u8BE5\u7D22\u5F15\uFF0C\u8981\u770B key_len \u624D\u53D1\u73B0\uFF09\u3002`,
            `\u4E24\u6761\u51FA\u8DEF\uFF1A\u2460 \u5728 WHERE \u4E2D\u8865\u4E0A ${skipped.join(" / ")} \u7684\u6761\u4EF6\u4EE5\u547D\u4E2D\u73B0\u6709\u7D22\u5F15\uFF1B\u2461 \u65E0\u6CD5\u8865\u65F6\u65B0\u5EFA\u7D22\u5F15 (${wanted.join(", ")})\u3002`,
            `\u9009 \u2461 \u65F6\u6CE8\u610F\u65B0\u7D22\u5F15\u4E0E ${index.name} \u5B58\u5728\u5199\u653E\u5927\u91CD\u53E0\uFF0C\u4E0A\u7EBF\u540E\u9700\u8BC4\u4F30\u662F\u5426\u4E0B\u7EBF\u65E7\u7D22\u5F15\u3002`
          ].join(""),
          messageEn: `Query uses ${index.name} but skips ${skipped.join(", ")}; only ${run} column(s) are usable as a range prefix.`
        });
        break;
      }
    }
    return findings;
  }
};

// src/rules/sia004.ts
var RULE_ID4 = "SIA004";
var sia004 = {
  id: RULE_ID4,
  title: "\u7D22\u5F15\u5217\u4E0A\u4F7F\u7528\u51FD\u6570\u6216\u8FD0\u7B97",
  titleEn: "Function or expression on an indexed column",
  needsSchema: false,
  needsMetrics: false,
  run(ctx) {
    const { record, schema, options } = ctx;
    const findings = [];
    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      for (const ref of dedupe(bucket.wrapped)) {
        const rewrite = buildRewrite(ref);
        const functionalDdl = options.mysqlVersion >= 8 && table ? [
          `ALTER TABLE ${quoteIdent(table.name)} ADD INDEX ${quoteIdent(
            indexName(table.name, [ref.column])
          )} ((${ref.raw}));`
        ] : [];
        findings.push({
          rule: RULE_ID4,
          severity: rewrite ? "error" : "warn",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: false,
          needsMetrics: false,
          table: bucket.table,
          suggestedDDL: functionalDdl,
          rewrite: rewrite?.predicate,
          message: [
            `\u6761\u4EF6 ${ref.predicateText ?? ref.raw} \u5728\u5217 ${ref.column} \u4E0A\u5957\u4E86\u51FD\u6570\u6216\u8FD0\u7B97\uFF0C\u7D22\u5F15\u91CC\u5B58\u7684\u662F\u539F\u503C\uFF0C\u56E0\u6B64\u8BE5\u5217\u4E0A\u7684\u7D22\u5F15\u5B8C\u5168\u7528\u4E0D\u4E0A\u3002`,
            rewrite ? `\u6539\u5199\u65B9\u6848\uFF1A${rewrite.predicate}\uFF08${rewrite.why}\uFF09` : "\u8BE5\u8868\u8FBE\u5F0F\u6CA1\u6709\u7B49\u4EF7\u6539\u5199\u5F62\u5F0F\uFF0C\u53EF\u8003\u8651\u51FD\u6570\u7D22\u5F15\u3002",
            ...options.mysqlVersion >= 8 ? [`MySQL 8.0 \u53EF\u7528\u51FD\u6570\u7D22\u5F15 ((${ref.raw})) \u76F4\u63A5\u7D22\u5F15\u8868\u8FBE\u5F0F\u7ED3\u679C\uFF0C\u4F46\u67E5\u8BE2\u5FC5\u987B\u5199\u6210\u5B8C\u5168\u76F8\u540C\u7684\u8868\u8FBE\u5F0F\u624D\u80FD\u547D\u4E2D\uFF1B5.7 \u4E0D\u652F\u6301\u3002`] : [`MySQL 5.7 \u4E0D\u652F\u6301\u51FD\u6570\u7D22\u5F15\uFF0C\u53EA\u80FD\u6539\u5199\u67E5\u8BE2\u3002`],
            functionalDdl.length === 0 && !rewrite ? "\u5F53\u524D\u8F93\u5165\u672A\u63D0\u4F9B --schema \u6216\u7248\u672C\u4F4E\u4E8E 8.0\uFF0C\u672A\u751F\u6210 DDL\u3002" : ""
          ].filter(Boolean).join(" "),
          messageEn: [
            `Expression \`${ref.raw}\` on ${bucket.table}.${ref.column} prevents index use: the index holds the raw value, so no index on that column can serve this predicate.`,
            rewrite ? `Rewrite it as: ${rewrite.predicate} (${rewrite.whyEn}).` : `No equivalent rewrite is provable for this shape, so a functional index is the only way out.`,
            options.mysqlVersion >= 8 ? `MySQL 8.0 can index the expression itself with ((${ref.raw})), but only a query written with exactly that expression will match it; 5.7 cannot.` : `MySQL 5.7 has no functional index, so rewriting the query is the only option.`,
            functionalDdl.length === 0 && !rewrite ? `No DDL was generated: this input has no --schema, or the target version is below 8.0.` : ""
          ].filter(Boolean).join(" ")
        });
      }
      for (const ref of dedupe(bucket.range.filter((r) => r.op === "like-middle"))) {
        const shown = ref.predicateText ?? `${ref.raw} LIKE ...`;
        findings.push({
          rule: RULE_ID4,
          severity: "info",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: false,
          needsMetrics: false,
          table: bucket.table,
          suggestedDDL: [],
          message: `\u6761\u4EF6 ${shown} \u7684 LIKE \u6A21\u5F0F\u4EE5 % \u5F00\u5934\uFF0CB+ \u6811\u7D22\u5F15\u5BF9\u5B83\u65E0\u80FD\u4E3A\u529B\uFF1A\u65E2\u4E0D\u80FD\u5B9A\u4F4D\u4E5F\u4E0D\u80FD\u7F29\u5C0F\u8303\u56F4\uFF0C\u53EA\u80FD\u5728\u522B\u7684\u6761\u4EF6\u628A\u884C\u7B5B\u51FA\u6765\u4E4B\u540E\u9010\u884C\u6BD4\u5BF9\u3002\u6240\u4EE5\u672C\u6761\u4E0D\u7ED9 DDL\u3002\u51FA\u8DEF\u53EA\u6709\u4E09\u6761\uFF1A\u6539\u6210\u53F3\u951A\u5B9A LIKE\uFF08'abc%' \u53EF\u4EE5\u547D\u4E2D\u7D22\u5F15\uFF09\u3001\u7ED9\u8BE5\u5217\u5EFA\u5168\u6587\u7D22\u5F15\u7528 MATCH AGAINST\u3001\u6216\u8005\u7531\u8C03\u7528\u65B9\u5F3A\u5236\u8981\u6C42\u524D\u7F00\u957F\u5EA6\u3002`,
          messageEn: `Predicate ${shown} uses a LIKE pattern that starts with %, which no B-tree index can use to seek or narrow: the rows have to arrive for some other reason before the pattern is checked. Hence no DDL here. The three ways out are a right-anchored LIKE ('abc%', indexable), a fulltext index with MATCH AGAINST, or requiring a leading prefix from the caller.`
        });
      }
    }
    return findings;
  }
};
function dedupe(refs) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const ref of refs) {
    const key = ref.predicateText ?? ref.raw;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
function buildRewrite(ref) {
  const raw = ref.raw ?? "";
  const value = (ref.valueText ?? "?").trim();
  const dateCall = /^DATE\(\s*([\w.`]+)\s*\)$/i.exec(raw);
  const day = dateCall && value !== "?" ? parseDateLiteral(value) : null;
  if (dateCall && ref.op === "=") {
    const target = dateCall[1];
    if (day) {
      const next = new Date(day.getTime() + 24 * 3600 * 1e3);
      return {
        predicate: `${target} >= '${formatDate(day)}' AND ${target} < '${formatDate(next)}'`,
        why: "\u6309\u5929\u7B49\u503C\u7B49\u4EF7\u4E8E\u5DE6\u95ED\u53F3\u5F00\u533A\u95F4\uFF0C\u53EF\u547D\u4E2D\u8BE5\u5217\u7D22\u5F15",
        whyEn: "equality on one day is the same set as a half-open range over it, which the column index can serve"
      };
    }
    return {
      predicate: `${target} >= ? AND ${target} < DATE_ADD(?, INTERVAL 1 DAY)`,
      why: "\u7ED1\u5B9A\u53C2\u6570\u4E3A\u65E5\u671F\u65F6\u540C\u6837\u53EF\u6539\u5199\u4E3A\u533A\u95F4\uFF1B\u6CE8\u610F\u4E24\u4E2A ? \u4F20\u540C\u4E00\u4E2A\u503C",
      whyEn: "a bound date parameter rewrites the same way; both ? must carry the same value"
    };
  }
  const yearCall = /^YEAR\(\s*([\w.`]+)\s*\)$/i.exec(raw);
  if (yearCall && ref.op === "=") {
    const target = yearCall[1];
    const yearValue = /^\d{4}$/.test(value.replace(/'/g, "")) ? Number(value.replace(/'/g, "")) : null;
    if (yearValue) {
      return {
        predicate: `${target} >= '${yearValue}-01-01 00:00:00' AND ${target} < '${yearValue + 1}-01-01 00:00:00'`,
        why: "\u6309\u5E74\u7B49\u503C\u7B49\u4EF7\u4E8E\u8BE5\u5E74\u5DE6\u95ED\u53F3\u5F00\u533A\u95F4",
        whyEn: "equality on a year is the same set as that year as a half-open range"
      };
    }
    return {
      predicate: `${target} >= MAKEDATE(YEAR(?), 1) AND ${target} < MAKEDATE(YEAR(?) + 1, 1)`,
      why: "\u53C2\u6570\u5316\u573A\u666F\u6539\u5199\u4E3A\u533A\u95F4",
      whyEn: "range form for the parameterised case"
    };
  }
  const leftCall = /^LEFT\(\s*([\w.`]+)\s*,\s*(\d+)\s*\)$/i.exec(raw);
  if (leftCall && ref.op === "=") {
    const target = leftCall[1];
    if (value !== "?") {
      const escaped = value.slice(1, -1).replace(/[%_]/g, (c) => `\\${c}`);
      return {
        predicate: `${target} LIKE '${escaped}%'`,
        why: "\u53D6\u524D\u7F00\u540E\u7B49\u503C\u7B49\u4EF7\u4E8E\u524D\u7F00 LIKE\uFF0C\u53F3\u524D\u7F00 LIKE \u53EF\u7528\u7D22\u5F15",
        whyEn: "comparing a fixed prefix is the same predicate as a LIKE that ends in %, and a leading-anchor LIKE is sargable"
      };
    }
    return { predicate: `${target} LIKE CONCAT(?, '%')`, why: "\u524D\u7F00\u5339\u914D\u6539\u5199", whyEn: "prefix match rewritten as a LIKE" };
  }
  const arithmetic = /^([\w.`]+)\s*([+\-])\s*(\d+(?:\.\d+)?)$/i.exec(raw);
  if (arithmetic && ref.op && ["=", ">", "<", ">=", "<=", "!=", "<>"].includes(ref.op)) {
    const [, colPart, sign, numPart] = arithmetic;
    const rhs = numericToOtherSide(sign === "+" ? "-" : "+", numPart, value);
    if (rhs) {
      return {
        predicate: `${colPart} ${ref.op} ${rhs}`,
        why: "\u628A\u8FD0\u7B97\u79FB\u5230\u53F3\u8FB9\uFF0C\u5DE6\u8FB9\u4FDD\u6301\u88F8\u5217",
        whyEn: "the arithmetic moves to the right side so the left side stays a bare column"
      };
    }
  }
  return void 0;
}
function numericToOtherSide(sign, offset, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value === "?" ? `? ${sign} ${offset}` : void 0;
  }
  return String(sign === "-" ? numeric - Number(offset) : numeric + Number(offset));
}

// src/rules/sia005.ts
var RULE_ID5 = "SIA005";
var sia005 = {
  id: RULE_ID5,
  title: "\u9690\u5F0F\u7C7B\u578B\u8F6C\u6362\u5BFC\u81F4\u7D22\u5F15\u5931\u6548",
  titleEn: "Implicit type conversion invalidates the index",
  needsSchema: true,
  needsMetrics: false,
  run(ctx) {
    const { record, schema } = ctx;
    const findings = [];
    for (const bucket of bucketByTable(record.parsed, schema)) {
      const table = findTable(schema, bucket.table);
      if (!table) continue;
      for (const ref of [...bucket.equality, ...bucket.inList]) {
        const column = findColumn(table, ref.column);
        if (!column || !isStringType(column.type)) continue;
        const offenders = numericOperands(ref);
        if (offenders.length === 0) continue;
        const newPredicate = rewritePredicate(ref, offenders);
        if (!newPredicate || !ref.predicateText) continue;
        const substituted = replacePredicate(record.parsed.sql, ref.predicateText, newPredicate);
        findings.push({
          rule: RULE_ID5,
          severity: "error",
          sql: truncateSql(record.parsed.sql),
          fingerprint: record.fingerprint,
          source: record.source,
          queryTime: record.metrics?.queryTime,
          rowsExamined: record.metrics?.rowsExamined,
          occurrences: record.occurrences,
          needsSchema: true,
          needsMetrics: false,
          table: table.name,
          suggestedDDL: [],
          rewrite: substituted ?? newPredicate,
          message: [
            `${table.name}.${column.name} \u662F\u5B57\u7B26\u4E32\u7C7B\u578B\uFF08${column.type}\uFF09\uFF0C\u4F46\u6761\u4EF6 ${ref.predicateText} \u62FF\u6570\u5B57\u53BB\u6BD4\uFF0C`,
            `MySQL \u7684\u89C4\u5219\u662F\u628A\u5217\u4FA7\u8F6C\u6210\u6570\u5B57\u518D\u6BD4\u8F83\uFF0C\u7B49\u4E8E\u5BF9\u6574\u5217\u5957\u51FD\u6570\uFF0C${quoteIdent(column.name)} \u4E0A\u7684\u7D22\u5F15\u76F4\u63A5\u5931\u6548\uFF08EXPLAIN \u4F1A\u663E\u793A type=ALL\uFF09\u3002`,
            `\u6539\u6CD5\uFF1A\u5B57\u9762\u91CF\u52A0\u5F15\u53F7\uFF0C\u6216\u5728 Java \u4FA7\u628A\u53C2\u6570\u7C7B\u578B\u6539\u6210 String\u3002`,
            `\u6CE8\u610F ${table.name}.${column.name} \u82E5\u662F\u624B\u673A\u53F7/\u8BA2\u5355\u53F7\uFF0C\u8FD8\u8981\u786E\u8BA4\u4E1A\u52A1\u4E0A\u6CA1\u6709\u524D\u5BFC\u96F6\u4E22\u5931\u95EE\u9898\u3002`,
            substituted ? "" : "\uFF08\u53EA\u7ED9\u51FA\u6539\u5199\u540E\u7684\u8C13\u8BCD\uFF1A\u539F\u8BED\u53E5\u7ED3\u6784\u4E0E\u89E3\u6790\u7ED3\u679C\u4E0D\u4E00\u81F4\uFF0C\u65E0\u6CD5\u5B89\u5168\u6574\u53E5\u66FF\u6362\u3002\uFF09"
          ].filter(Boolean).join(" "),
          messageEn: `String column ${table.name}.${column.name} compared to a number forces a per-row cast and skips the index.`
        });
      }
    }
    return findings;
  }
};
function numericOperands(ref) {
  if (ref.parameterized) return [];
  const text = ref.valueText ?? "";
  if (ref.op === "in") {
    return text.replace(/^\(\s*|\s*\)$/g, "").split(",").map((part) => part.trim()).filter((part) => numericLiteral(part) !== void 0);
  }
  return numericLiteral(text) ? [text.trim()] : [];
}
function rewritePredicate(ref, offenders) {
  if (!ref.predicateText) return void 0;
  let out = ref.predicateText;
  for (const offender of offenders) {
    out = out.replace(new RegExp(`(?<![\\w.])${escapeRegExp2(offender)}(?![\\w.])`), `'${offender}'`);
  }
  return out === ref.predicateText ? void 0 : out;
}
function escapeRegExp2(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/rules/sia006.ts
var RULE_ID6 = "SIA006";
var sia006 = {
  id: RULE_ID6,
  title: "\u6DF1\u5206\u9875",
  titleEn: "Deep pagination",
  needsSchema: false,
  needsMetrics: false,
  run(ctx) {
    const { record, schema, options } = ctx;
    const limit = record.parsed.limit;
    if (!limit?.literal || limit.offset === void 0) return [];
    if (limit.offset < options.deepOffsetThreshold) return [];
    if (record.parsed.kind !== "select") return [];
    if (record.parsed.tables.length !== 1) return [];
    const table = record.parsed.tables[0];
    const alias = table.alias ?? "";
    const aliasInUse = alias.length > 0;
    const schemaTable = findTable(schema, table.name);
    const pk = schemaTable?.indexes.find((i) => i.primary)?.columns[0] ?? "id";
    const rawWhere = record.parsed.whereText ?? "";
    const rawOrder = record.parsed.orderByText ?? "";
    const order = rawOrder ? ` ORDER BY ${rawOrder}` : "";
    const projection = aliasInUse ? `${alias}.*` : "*";
    const qualified = (column) => aliasInUse ? `${alias}.${quoteIdent(column)}` : quoteIdent(column);
    const innerWhere = rawWhere ? ` WHERE ${unqualify(rawWhere, alias)}` : "";
    const innerOrder = rawOrder ? ` ORDER BY ${unqualify(rawOrder, alias)}` : "";
    const deferredJoin = `SELECT ${projection} FROM (SELECT ${quoteIdent(pk)} FROM ${quoteIdent(table.name)}${innerWhere}${innerOrder} LIMIT ${limit.offset}, ${limit.rowCount ?? 20}) AS page JOIN ${quoteIdent(table.name)}${aliasInUse ? ` ${alias}` : ""} ON ${aliasInUse ? `${alias}.` : ""}${quoteIdent(pk)} = page.${quoteIdent(pk)}${order};`;
    const correlated = /\(\s*select\b/i.test(rawWhere) && aliasInUse;
    const ordering = record.parsed.orderBy[0];
    const cmp = ordering?.desc ? "<" : ">";
    const seek = ordering ? `SELECT ${projection} FROM ${quoteIdent(table.name)}${aliasInUse ? ` ${alias}` : ""} WHERE (${qualified(ordering.column)} ${cmp} ? OR (${qualified(ordering.column)} = ? AND ${qualified(pk)} ${cmp} ?))${order} LIMIT ${limit.rowCount ?? 20};` : void 0;
    const finding = {
      rule: RULE_ID6,
      severity: correlated ? "info" : "warn",
      sql: truncateSql(record.parsed.sql),
      fingerprint: record.fingerprint,
      source: record.source,
      queryTime: record.metrics?.queryTime,
      rowsExamined: record.metrics?.rowsExamined,
      occurrences: record.occurrences,
      needsSchema: false,
      needsMetrics: false,
      table: table.name,
      suggestedDDL: [],
      rewrite: correlated ? void 0 : deferredJoin,
      message: [
        `LIMIT ${limit.offset}, ${limit.rowCount ?? "?"}\uFF1AMySQL \u4ECD\u8981\u626B\u63CF\u5E76\u4E22\u5F03\u524D ${limit.offset} \u884C\uFF0C\u9875\u7801\u8D8A\u6DF1\u4EE3\u4EF7\u8D8A\u9AD8\uFF0CPages_read \u5168\u90E8\u767D\u4ED8\u3002`,
        correlated ? `\u8BE5\u8BED\u53E5\u7684 WHERE \u542B\u5B50\u67E5\u8BE2\uFF0C\u9759\u6001\u6539\u5199\u5EF6\u8FDF\u5173\u8054\u5BB9\u6613\u51FA\u9519\uFF0C\u8FD9\u91CC\u53EA\u7ED9\u6A21\u677F\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u5B50\u67E5\u8BE2\u5728\u6D3E\u751F\u8868\u4E2D\u7684\u53EF\u89C1\u6027\uFF1A${deferredJoin}` : `\u65B9\u6848\u4E00\uFF08\u5EF6\u8FDF\u5173\u8054\uFF0C\u6539\u52A8\u6700\u5C0F\uFF09\uFF1A\u5148\u5728\u7D22\u5F15\u91CC\u7FFB\u4E3B\u952E\uFF0C\u518D\u56DE\u8868\u53D6\u6574\u884C\uFF1A${deferredJoin}`,
        ...seek ? [`\u65B9\u6848\u4E8C\uFF08\u6E38\u6807/seek \u5206\u9875\uFF0C\u9002\u5408\u65E0\u9650\u4E0B\u62C9\uFF09\uFF1A\u7528\u4E0A\u4E00\u9875\u6700\u540E\u4E00\u884C\u7684\u6392\u5E8F\u952E\u66FF\u4EE3\u504F\u79FB\u91CF\uFF1A${seek}`] : [`\u65B9\u6848\u4E8C\uFF08\u6E38\u6807\u5206\u9875\uFF09\uFF1A\u5F53\u524D\u67E5\u8BE2\u6CA1\u6709 ORDER BY\uFF0C\u65E0\u6CD5\u751F\u6210 seek \u6761\u4EF6\uFF1B\u6DF1\u5206\u9875\u5FC5\u987B\u5148\u6709\u7A33\u5B9A\u6392\u5E8F\u952E\u3002`],
        ...schemaTable ? [] : [`\u672A\u63D0\u4F9B --schema\uFF0C\u6539\u5199\u8BED\u53E5\u6309\u4E3B\u952E\u5217\u540D id \u751F\u6210\uFF0C\u6267\u884C\u524D\u8BF7\u786E\u8BA4\u4E3B\u952E\u786E\u5B9E\u662F id\u3002`],
        `\u6CE8\u610F\uFF1A\u6D3E\u751F\u8868\u53EA\u51B3\u5B9A\u53D6\u54EA\u51E0\u884C\uFF0C\u6700\u7EC8\u987A\u5E8F\u4ECD\u7531\u5916\u5C42 ORDER BY \u51B3\u5B9A\uFF0C\u5916\u5C42\u6392\u5E8F\u4E0D\u80FD\u7701\u3002`
      ].join(" "),
      messageEn: `OFFSET ${limit.offset} scans and discards rows before returning ${limit.rowCount ?? "?"}; use a deferred join or keyset pagination.`
    };
    return [finding];
  }
};
function unqualify(text, alias) {
  if (!alias) return text;
  return text.replace(new RegExp(`\`?${escapeRegExp3(alias)}\`?\\s*\\.\\s*`, "gi"), "");
}
function escapeRegExp3(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/rules/sia007.ts
var RULE_ID7 = "SIA007";
var ROW_PRESSURE = 1e4;
var sia007 = {
  id: RULE_ID7,
  title: "\u8986\u76D6\u7D22\u5F15\u673A\u4F1A",
  titleEn: "Covering index opportunity",
  needsSchema: true,
  needsMetrics: true,
  run(ctx) {
    const { record, schema } = ctx;
    const rows = record.metrics?.rowsExamined ?? 0;
    if (rows < ROW_PRESSURE) return [];
    if (record.parsed.kind !== "select") return [];
    if (record.parsed.selectStar || record.parsed.selectColumns.length === 0) return [];
    if (record.parsed.tables.length !== 1) return [];
    const bucket = bucketByTable(record.parsed, schema)[0];
    const table = findTable(schema, bucket?.table ?? record.parsed.tables[0].name);
    if (!bucket || !table) return [];
    const predicate = dedupeColumns([...bucket.equality, ...bucket.inList, ...bucket.range]);
    if (predicate.length === 0) return [];
    const predicateName = predicate.map((c) => c.column);
    const covering = table.indexes.find(
      (index) => predicateName.every((column, position) => index.columns[position] === column)
    );
    if (!covering) return [];
    const missing = record.parsed.selectColumns.filter((c) => !covering.columns.includes(c));
    const ordering = dedupeColumns(bucket.ordering).map((c) => c.column);
    const additions = [.../* @__PURE__ */ new Set([...ordering, ...missing])].filter((c) => !covering.columns.includes(c));
    if (additions.length === 0) return [];
    const combined = [...covering.columns, ...additions];
    if (combined.length > 5) return [];
    let bytes = 0;
    for (const name of combined) {
      const column = findColumn(table, name);
      if (!column) return [];
      const size = columnKeyBytes(column, table.charset);
      if (!Number.isFinite(size)) return [];
      bytes += size;
    }
    if (bytes > ctx.options.prefixBytes) return [];
    const ddl = addIndexDdl(table.name, combined);
    return [
      {
        rule: RULE_ID7,
        severity: rows >= 1e6 ? "error" : "warn",
        sql: truncateSql(record.parsed.sql),
        fingerprint: record.fingerprint,
        source: record.source,
        queryTime: record.metrics?.queryTime,
        rowsExamined: rows,
        occurrences: record.occurrences,
        needsSchema: true,
        needsMetrics: true,
        table: table.name,
        indexColumns: combined,
        suggestedDDL: [ddl],
        message: [
          `\u8BE5\u67E5\u8BE2\u626B\u63CF ${rows.toLocaleString("en-US")} \u884C\uFF0C\u4F46\u53EA\u9700\u8981 ${combined.length} \u4E2A\u4E0D\u540C\u5217\uFF08${combined.join(", ")}\uFF09\u3002`,
          `\u73B0\u6709\u7D22\u5F15 ${covering.name}(${covering.columns.join(", ")}) \u80FD\u5B9A\u4F4D\u4F46\u53D6\u4E0D\u5168\u5217\uFF0C\u6BCF\u4E00\u884C\u90FD\u8981\u56DE\u8868\u8BFB\u805A\u7C07\u7D22\u5F15\u3002`,
          `\u628A\u5B83\u6269\u5C55\u6210\u8986\u76D6\u7D22\u5F15\u540E\uFF0CEXPLAIN \u7684 Extra \u5E94\u51FA\u73B0 Using index\uFF0C\u56DE\u8868\u5E26\u6765\u7684\u968F\u673A IO \u76F4\u63A5\u6D88\u5931\u3002`,
          `\u4EE3\u4EF7\uFF1A\u7D22\u5F15\u53D8\u5BBD\u540E\u5199\u653E\u5927\u4E0E\u7A7A\u95F4\u4E0A\u5347\uFF0C\u4E14 ${additions.join(", ")} \u4E0A\u7684\u66F4\u65B0\u4F1A\u989D\u5916\u7EF4\u62A4\u8BE5\u7D22\u5F15\uFF0C\u8BF7\u4EBA\u5DE5\u8BC4\u4F30\u5199\u5165\u9891\u7387\u3002`
        ].join(" "),
        messageEn: `Extending ${covering.name} to cover (${combined.join(", ")}) removes the \u56DE\u8868 for ${rows} examined rows.`
      }
    ];
  }
};

// src/rules/registry.ts
var ALL_RULES = [sia001, sia002, sia003, sia004, sia005, sia006, sia007];
function ruleById(id) {
  return ALL_RULES.find((rule) => rule.id.toLowerCase() === id.toLowerCase());
}
function ruleCatalogue() {
  return ALL_RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    titleEn: rule.titleEn,
    needsSchema: rule.needsSchema,
    needsMetrics: rule.needsMetrics
  }));
}

// src/rules/engine.ts
function analyze(records, options = {}) {
  const opts = { ...DEFAULT_RULE_OPTIONS, ...stripUndefined(options) };
  const rules = options.rules ?? ALL_RULES;
  const schema = options.schema;
  const findings = [];
  const errors = [];
  const skipCounts = /* @__PURE__ */ new Map();
  for (const record of records) {
    for (const rule of rules) {
      const missing = missingDependency(rule, record, schema);
      if (missing) {
        const entry = skipCounts.get(rule.id) ?? { ...missing, count: 0 };
        entry.count += 1;
        skipCounts.set(rule.id, entry);
        continue;
      }
      let produced;
      try {
        produced = rule.run({ record, schema, options: opts });
      } catch (err) {
        const message = `${rule.id} \u5728 ${describeRecord(record)} \u4E0A\u6267\u884C\u5931\u8D25\uFF1A${err.message}`;
        if (!errors.includes(message)) errors.push(message);
        continue;
      }
      for (const finding of produced) {
        if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[opts.minSeverity]) continue;
        findings.push(finding);
      }
    }
  }
  return {
    findings: dropRedundantPrefixes(sortFindings(dedup(findings), records)),
    records: records.length,
    analysed: records.length,
    skipped: [...skipCounts.entries()].map(([id, v]) => ({ id, reason: v.reason, reasonEn: v.reasonEn, count: v.count })).sort((a, b) => b.count - a.count),
    errors,
    options: opts
  };
}
function stripUndefined(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== void 0) out[key] = value;
  }
  return out;
}
function missingDependency(rule, record, schema) {
  if (rule.needsSchema && !schema) {
    return { reason: "\u7F3A\u5C11 --schema\uFF0C\u73B0\u6709\u7D22\u5F15\u672A\u77E5", reasonEn: "needs --schema to know existing indexes" };
  }
  if (rule.needsMetrics && record.metrics?.rowsExamined === void 0) {
    return {
      reason: "\u8BE5\u8F93\u5165\u6CA1\u6709 Rows_examined\uFF08\u4EC5\u6162\u65E5\u5FD7\u63D0\u4F9B\uFF09",
      reasonEn: "no Rows_examined in this input (slow log only)"
    };
  }
  if (record.parsed.notes.some((n) => n.includes("\u89E3\u6790\u5931\u8D25"))) {
    return { reason: "SQL \u89E3\u6790\u5931\u8D25", reasonEn: "statement failed to parse" };
  }
  if (record.parsed.notes.some((n) => n.includes("\u5206\u53F7"))) {
    return {
      reason: "\u591A\u6761\u8BED\u53E5\u6DF7\u5728\u4E00\u8D77\u4E14\u7F3A\u5C11\u5206\u53F7\uFF0C\u672A\u5206\u6790",
      reasonEn: "several statements arrived merged (no ';' between them); not analysed"
    };
  }
  if (record.parsed.tables.length === 0) {
    return { reason: "\u6CA1\u6709\u8BC6\u522B\u5230\u8868\u540D", reasonEn: "no table could be identified" };
  }
  return void 0;
}
function describeRecord(record) {
  return record.statementId ?? record.source?.line?.toString() ?? record.fingerprint.slice(0, 40);
}
function benefitOf(finding, record) {
  const time = finding.queryTime ?? record?.metrics?.queryTime ?? 0;
  const rows = finding.rowsExamined ?? record?.maxRowsExamined ?? 0;
  const occurrences = finding.occurrences ?? record?.occurrences ?? 1;
  return time * rows * occurrences + rows / 1e6 + occurrences;
}
function sortFindings(findings, records) {
  const byFingerprint = new Map(records.map((r) => [r.fingerprint, r]));
  return [...findings].sort((a, b) => {
    const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severity !== 0) return severity;
    const gain = benefitOf(b, byFingerprint.get(b.fingerprint)) - benefitOf(a, byFingerprint.get(a.fingerprint));
    if (Math.abs(gain) > 1e-9) return gain > 0 ? 1 : -1;
    return a.rule.localeCompare(b.rule);
  });
}
function dropRedundantPrefixes(findings) {
  const candidates = findings.filter((f) => (f.indexColumns?.length ?? 0) > 0);
  const drop = /* @__PURE__ */ new Set();
  const byColumnSet = /* @__PURE__ */ new Map();
  for (const finding of candidates) {
    if (finding.suggestedDDL.some((ddl) => /\(\s*\w+\s*\(\s*\d+\s*\)\s*\)/.test(ddl))) continue;
    const key = [finding.table ?? "", [...finding.indexColumns].sort().join(",")].join("::");
    const kept = byColumnSet.get(key);
    if (!kept) {
      byColumnSet.set(key, finding);
      continue;
    }
    drop.add(finding);
    kept.coveredFingerprints = [...kept.coveredFingerprints ?? [], finding.fingerprint];
  }
  for (const narrow of candidates) {
    for (const wide of candidates) {
      if (narrow === wide || narrow.table !== wide.table) continue;
      const a = narrow.indexColumns;
      const b = wide.indexColumns;
      if (a.length >= b.length) continue;
      if (!wide.rule.startsWith("SIA00") || !narrow.rule.startsWith("SIA00")) continue;
      if (b.slice(0, a.length).join(",") !== a.join(",")) continue;
      drop.add(narrow);
      wide.coveredFingerprints = [
        ...wide.coveredFingerprints ?? [],
        narrow.fingerprint
      ];
      break;
    }
  }
  if (drop.size === 0) return findings;
  return findings.filter((f) => !drop.has(f)).map(
    (f) => f.coveredFingerprints?.length ? {
      ...f,
      message: `${f.message} \u8BE5\u7D22\u5F15\u540C\u65F6\u8986\u76D6\u53E6\u5916 ${f.coveredFingerprints.length} \u6761\u67E5\u8BE2\u7684\u6761\u4EF6\uFF0C\u65E0\u9700\u91CD\u590D\u5EFA\u3002`,
      messageEn: `${f.messageEn} It also serves ${f.coveredFingerprints.length} other queried access path(s) on this table.`
    } : f
  );
}
function dedup(findings) {
  const seen = /* @__PURE__ */ new Map();
  for (const finding of findings) {
    const key = [
      finding.rule,
      finding.table ?? "",
      finding.fingerprint,
      [...finding.suggestedDDL].sort().join("|"),
      finding.rewrite ?? ""
    ].join("::");
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, finding);
      continue;
    }
    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

// src/report/json.ts
var REPORT_VERSION = 1;
function buildJsonReport(result, source, toolVersion = "0.1.0") {
  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const finding of result.findings) bySeverity[finding.severity] += 1;
  return {
    reportVersion: REPORT_VERSION,
    toolVersion,
    source,
    summary: {
      records: result.records,
      findings: result.findings.length,
      bySeverity
    },
    options: result.options,
    rules: ruleCatalogue(),
    skipped: result.skipped,
    errors: result.errors,
    findings: result.findings
  };
}

// src/report/migration.ts
var TEXT = {
  zh: {
    header: "-- \u672C\u6587\u4EF6\u53EA\u505A\u4E24\u4EF6\u4E8B\uFF1A\u52A0\u7D22\u5F15\u3002\u4E0D\u4F1A DROP\u3001\u4E0D\u4F1A\u6539\u6570\u636E\u3001\u4E0D\u4F1A\u81EA\u52A8\u6267\u884C\u3002",
    hint: "-- \u5EFA\u8BAE\u6309\u8868\u9010\u4E2A\u6267\u884C\uFF0C\u5E76\u5728\u4E1A\u52A1\u4F4E\u5CF0\u671F\u7528 ALGORITHM=INPLACE, LOCK=NONE \u9A8C\u8BC1\u5728\u7EBF DDL \u53EF\u884C\u6027\u3002",
    rewrites: "-- \u2500\u2500 \u9700\u8981\u6539\u5199 SQL \u7684\u5EFA\u8BAE\uFF08\u65E0 DDL\uFF09",
    footer: "-- \u6267\u884C\u540E\u8BF7\u590D\u6838\u672A\u88AB\u91C7\u7EB3\u7684\u7D22\u5F15\uFF1A\u91CD\u590D\u6216\u6781\u7A84\u7684\u7D22\u5F15\u4F1A\u6301\u7EED\u653E\u5927\u5199\u5165\u6210\u672C\u3002",
    hits: (n) => `\u547D\u4E2D ${n} \u6B21`,
    scanned: (n) => `\u626B\u63CF ${n.toLocaleString("en-US")} \u884C`,
    review: "-- Generated by sql-index-advisor (SIA)\uFF0C\u6267\u884C\u524D\u8BF7\u4EBA\u5DE5\u8BC4\u5BA1\u3002"
  },
  en: {
    header: "-- This file adds indexes. Nothing here drops, alters or deletes data.",
    hint: "-- Apply one table at a time, off peak, and confirm ALGORITHM=INPLACE, LOCK=NONE is accepted.",
    rewrites: "-- \u2500\u2500 Advice that needs a SQL rewrite (no DDL)",
    footer: "-- Re-check indexes left unused afterwards: duplicates and narrow ones keep costing writes.",
    hits: (n) => `${n} occurrences`,
    scanned: (n) => `${n.toLocaleString("en-US")} rows scanned`,
    review: "-- Generated by sql-index-advisor (SIA); review before running."
  }
};
function renderMigration(result, source, options = {}) {
  const lang = options.lang ?? "zh";
  const t = TEXT[lang];
  const withDdl = result.findings.filter((f) => f.suggestedDDL.length > 0);
  const rewrites = result.findings.filter((f) => !f.suggestedDDL.length && f.rewrite);
  const seen = /* @__PURE__ */ new Map();
  for (const finding of withDdl) {
    for (const ddl of finding.suggestedDDL) {
      const existing = seen.get(ddl);
      if (!existing || rank2(finding.severity) > rank2(existing.severity)) seen.set(ddl, finding);
    }
  }
  const grouped = /* @__PURE__ */ new Map();
  for (const [ddl, finding] of seen) {
    const table = finding.table ?? "(unknown)";
    const list = grouped.get(table) ?? [];
    list.push({ ddl, finding });
    grouped.set(table, list);
  }
  const out = [
    t.review,
    `-- Source : ${source}`,
    `-- Findings: ${result.findings.length} \xB7 DDL statements: ${seen.size} \xB7 Tables touched: ${grouped.size}`,
    "--",
    t.header,
    t.hint,
    ""
  ];
  for (const [table, entries] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`-- \u2500\u2500 ${table} ${"\u2500".repeat(Math.max(2, 60 - table.length))}`);
    for (const { ddl, finding } of entries.sort((a, b) => a.ddl.localeCompare(b.ddl))) {
      const rule = ruleById(finding.rule);
      const title = lang === "en" ? rule?.titleEn ?? finding.rule : rule?.title ?? "";
      out.push(`-- ${finding.rule} ${title} \xB7 ${severityNote(finding, lang)}`);
      out.push(`--   ${lang === "en" ? "evidence" : "\u8BC1\u636E"}: ${evidence(finding.sql, 150)}`);
      out.push(ddl);
    }
    out.push("");
  }
  if (rewrites.length > 0) {
    out.push(`${t.rewrites}${"\u2500".repeat(24)}`);
    for (const finding of rewrites) {
      out.push(`-- ${finding.rule} \xB7 ${evidence(finding.sql, 120)}`);
      out.push(`--   ${finding.rewrite}`);
    }
    out.push("");
  }
  out.push(t.footer);
  return `${out.join("\n")}
`;
}
function rank2(severity) {
  return severity === "error" ? 3 : severity === "warn" ? 2 : 1;
}
function severityNote(finding, lang) {
  const t = TEXT[lang];
  const bits = [finding.severity];
  if (finding.occurrences && finding.occurrences > 1) bits.push(t.hits(finding.occurrences));
  if (finding.rowsExamined !== void 0) bits.push(t.scanned(finding.rowsExamined));
  return bits.join(" \xB7 ");
}

// src/parsers/slowlog.ts
var RE_TIME = /^#\s*Time:\s*(.+)$/;
var RE_USER_HOST = /^#\s*User@Host:\s*(.+)$/;
var RE_QUERY_TIME = /#\s*Query_time:\s*([0-9.]+)/;
var RE_LOCK_TIME = /Lock_time:\s*([0-9.]+)/;
var RE_ROWS_SENT = /Rows_sent:\s*([0-9]+)/;
var RE_ROWS_EXAMINED = /Rows_examined:\s*([0-9]+)/;
var RE_SCHEMA = /^#\s*Schema:\s*(.*)$/;
function isNoise(line) {
  const l = line.trim();
  if (l === "") return true;
  if (/^SET\s+timestamp\s*=/i.test(l)) return true;
  if (/^(SET\s+@@|USE\s)/i.test(l)) return true;
  if (/^\/\S*mysqld\b/i.test(l)) return true;
  if (/^Tcp port:/i.test(l)) return true;
  if (/^Time\s+Id\s+Command/i.test(l)) return true;
  if (/^# administrator command/i.test(l)) return true;
  if (/^# (Thread_id|Errcode|Errno|Bytes_sent|QC_efficiency|Table_locks_waited|Select_|Sort_)\b/i.test(l)) {
    return true;
  }
  return false;
}
function newEvent(line) {
  return { line, metrics: {}, sqlLines: [], terminated: false };
}
function parseSlowLog(content, file = "slow.log") {
  const lines = content.split(/\r?\n/);
  const events = [];
  let current = newEvent(1);
  let hasCurrent = false;
  let ignoredEvents = 0;
  const flush = () => {
    if (hasCurrent && current.sqlLines.length > 0) events.push(current);
    else if (hasCurrent) ignoredEvents += 1;
    current = newEvent(1);
    hasCurrent = false;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    const timeMatch = RE_TIME.exec(line);
    if (timeMatch) {
      flush();
      current = newEvent(i + 1);
      hasCurrent = true;
      continue;
    }
    if (RE_USER_HOST.test(line)) {
      if (!hasCurrent) {
        current = newEvent(i + 1);
        hasCurrent = true;
      }
      continue;
    }
    const schemaMatch = RE_SCHEMA.exec(line);
    if (schemaMatch) continue;
    if (line.startsWith("#")) {
      const qt = RE_QUERY_TIME.exec(line);
      if (qt) {
        if (!hasCurrent) {
          current = newEvent(i + 1);
          hasCurrent = true;
        }
        current.metrics.queryTime = Number(qt[1]);
        const lt = RE_LOCK_TIME.exec(line);
        if (lt) current.metrics.lockTime = Number(lt[1]);
        const rs = RE_ROWS_SENT.exec(line);
        if (rs) current.metrics.rowsSent = Number(rs[1]);
        const rx = RE_ROWS_EXAMINED.exec(line);
        if (rx) current.metrics.rowsExamined = Number(rx[1]);
        continue;
      }
      continue;
    }
    if (isNoise(line)) continue;
    if (!hasCurrent) {
      current = newEvent(i + 1);
      hasCurrent = true;
    }
    if (current.sqlLines.length === 0) current.line = i + 1;
    current.sqlLines.push(raw);
    if (line.endsWith(";")) {
      current.terminated = true;
      flush();
      hasCurrent = false;
    }
  }
  flush();
  return aggregate(events, file, ignoredEvents);
}
function aggregate(events, file, ignoredEvents) {
  const byFingerprint = /* @__PURE__ */ new Map();
  let totalEvents = 0;
  for (const event of events) {
    const sql = event.sqlLines.join("\n").replace(/;\s*$/, "").trim();
    if (sql.length === 0) {
      ignoredEvents += 1;
      continue;
    }
    totalEvents += 1;
    const fp = fingerprint(sql);
    const existing = byFingerprint.get(fp);
    const qt = event.metrics.queryTime ?? 0;
    const rx = event.metrics.rowsExamined ?? 0;
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 1) + 1;
      existing.totalQueryTime = (existing.totalQueryTime ?? 0) + qt;
      existing.maxRowsExamined = Math.max(existing.maxRowsExamined ?? 0, rx);
      if (qt > (existing.metrics?.queryTime ?? 0)) {
        existing.metrics = { ...existing.metrics, ...event.metrics };
      }
      continue;
    }
    byFingerprint.set(fp, {
      fingerprint: fp,
      sql,
      source: { file, line: event.line },
      metrics: { ...event.metrics },
      occurrences: 1,
      totalQueryTime: qt,
      maxRowsExamined: rx,
      parsed: parseSql(sql),
      input: "slowlog"
    });
  }
  const records = [...byFingerprint.values()].sort(
    (a, b) => (b.totalQueryTime ?? 0) - (a.totalQueryTime ?? 0)
  );
  return { records, ignoredEvents, totalEvents };
}

// src/parsers/mapper.ts
import { readFileSync as readFileSync2, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
var MAX_VARIANTS = 10;
var STATEMENT_TAGS = ["select", "insert", "update", "delete"];
var ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " "
};
function decodeEntities(text) {
  return text.replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}
function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, " ");
}
function unwrapCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, " $1 ");
}
function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`);
  const m = re.exec(tag);
  if (!m) return void 0;
  return m[1] ?? m[2];
}
function findClose(text, name, from) {
  const re = new RegExp(`<${name}\\b[^>]*>?|</${name}\\s*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m;
  while (m = re.exec(text)) {
    const full = m[0];
    if (full.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return m.index;
      continue;
    }
    if (!full.endsWith("/>")) depth += 1;
  }
  return -1;
}
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}
function parseMapperText(text, file) {
  const out = [];
  const clean = stripXmlComments(text);
  const nsMatch = /<mapper\b[^>]*namespace\s*=\s*["']([^"']+)["']/i.exec(clean);
  const namespace = nsMatch?.[1] ?? "";
  if (!/<mapper\b/i.test(clean)) return out;
  const fragments = /* @__PURE__ */ new Map();
  const sqlTagRe = /<sql\b([^>]*)>/gi;
  let m;
  while (m = sqlTagRe.exec(clean)) {
    const openEnd = m.index + m[0].length;
    const close = findClose(clean, "sql", openEnd);
    if (close === -1) continue;
    const id = attr(m[1] ?? "", "id");
    if (id) fragments.set(id, clean.slice(openEnd, close));
    sqlTagRe.lastIndex = close;
  }
  for (const tag of STATEMENT_TAGS) {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
    let hit;
    while (hit = re.exec(clean)) {
      const openIndex = hit.index;
      const bodyStart = openIndex + hit[0].length;
      const closeIndex = findClose(clean, tag, bodyStart);
      if (closeIndex === -1) continue;
      re.lastIndex = closeIndex;
      const attributes = hit[1] ?? "";
      const id = attr(attributes, "id") ?? "unknown";
      const statement = {
        id,
        namespace,
        kind: tag,
        file,
        line: lineOf(clean, openIndex),
        parameterType: attr(attributes, "parameterType"),
        databaseId: attr(attributes, "databaseId"),
        variants: [],
        rawInterpolation: /\$\{/.test(clean.slice(bodyStart, closeIndex)),
        notes: []
      };
      const body = clean.slice(bodyStart, closeIndex);
      statement.variants = expand(body, fragments, statement.notes);
      out.push(statement);
    }
  }
  return out;
}
function expand(body, fragments, notes) {
  const chooseStart = /<choose\b/i.exec(body);
  if (!chooseStart || chooseStart.index === void 0) {
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }
  const index = chooseStart.index;
  const innerStart = index + chooseStart[0].length;
  const innerEnd = findClose(body, "choose", innerStart);
  if (innerEnd === -1) {
    notes.push("<choose> \u672A\u95ED\u5408\uFF0C\u5DF2\u6309\u539F\u6837\u5C55\u5F00");
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }
  const prefix = body.slice(0, index);
  const suffix = body.slice(innerEnd + "</choose>".length);
  const inner = body.slice(innerStart, innerEnd);
  const left = expand(prefix, fragments, notes);
  const right = expand(suffix, fragments, notes);
  const branches = [];
  const whenRe = /<when\b([^>]*)>/gi;
  let w;
  let n = 0;
  while (w = whenRe.exec(inner)) {
    const start = w.index + w[0].length;
    const close = findClose(inner, "when", start);
    if (close === -1) continue;
    whenRe.lastIndex = close;
    n += 1;
    branches.push({ sql: inner.slice(start, close), label: `when[${n}]` });
  }
  const other = /<otherwise\b[^>]*>/i.exec(inner);
  if (other && other.index !== void 0) {
    const start = other.index + other[0].length;
    const close = findClose(inner, "otherwise", start);
    if (close !== -1) branches.push({ sql: inner.slice(start, close), label: "otherwise" });
  }
  if (branches.length === 0) {
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }
  const variants = [];
  for (const branch of branches) {
    for (const mid of expand(branch.sql, fragments, notes)) {
      for (const l of left) {
        for (const r of right) {
          if (variants.length >= MAX_VARIANTS) {
            notes.push(`\u52A8\u6001\u5206\u652F\u7EC4\u5408\u8D85\u8FC7 ${MAX_VARIANTS} \u4E2A\uFF0C\u5DF2\u622A\u65AD`);
            return variants;
          }
          const label = [l.label, `${branch.label}${mid.label ? `.${mid.label}` : ""}`, r.label].filter(Boolean).join("/");
          variants.push({
            sql: finalise(`${l.sql} ${mid.sql} ${r.sql}`, fragments, notes),
            label
          });
        }
      }
    }
  }
  return variants;
}
function finalise(body, fragments, notes) {
  let text = body;
  text = text.replace(/<selectKey\b[\s\S]*?<\/selectKey>/gi, " ");
  text = text.replace(/<bind\b[^>]*\/?>/gi, " ");
  text = text.replace(/<include\b([^>]*?)\/?>/gi, (_all, a) => {
    const refid = attr(a, "refid");
    if (!refid) return " ";
    const short = refid.includes(".") ? refid.slice(refid.lastIndexOf(".") + 1) : refid;
    const frag = fragments.get(refid) ?? fragments.get(short);
    if (!frag) {
      notes.push(`<include refid="${refid}"> \u672A\u627E\u5230\u7247\u6BB5\uFF0C\u5DF2\u8DF3\u8FC7`);
      return " ";
    }
    return frag;
  });
  text = text.replace(/<foreach\b([^>]*)>([\s\S]*?)<\/foreach>/gi, (_all, a) => {
    const open = attr(a, "open") ?? "";
    const close = attr(a, "close") ?? "";
    return open === "(" && close === ")" ? "( ? )" : " ? ";
  });
  text = text.replace(/<trim\b([^>]*)>([\s\S]*?)<\/trim>/gi, (_all, a, inner) => {
    const prefix = attr(a, "prefix") ?? "";
    const suffix = attr(a, "suffix") ?? "";
    const overrides = (attr(a, "prefixOverrides") ?? "").split("|").map((o) => o.trim()).filter(Boolean);
    let bodyText = inner.trim();
    for (const o of overrides) {
      bodyText = bodyText.replace(new RegExp(`^${escapeRe(o)}\\s+`, "i"), "");
    }
    return ` ${prefix} ${bodyText} ${suffix} `;
  });
  text = text.replace(/<where\b[^>]*>/gi, " WHERE ");
  text = text.replace(/<\/where\s*>/gi, " ");
  text = text.replace(/<set\b[^>]*>/gi, " SET ");
  text = text.replace(/<\/set\s*>/gi, " ");
  text = text.replace(/<values?\b[^>]*>([\s\S]*?)<\/values?>/gi, " VALUES ");
  text = text.replace(/<(?:if|when|otherwise|choose|where|set|trim|foreach)\b[^>]*>/gi, " ");
  text = text.replace(/<\/(?:if|when|otherwise|choose|where|set|trim|foreach)\s*>/gi, " ");
  text = text.replace(/<\/?[a-zA-Z_][\w.:-]*\b[^>]*>/g, (matched) => {
    notes.push(`\u5DF2\u79FB\u9664\u672A\u652F\u6301\u7684\u6807\u7B7E ${matched.slice(0, 30)}`);
    return " ";
  });
  text = unwrapCdata(text);
  text = decodeEntities(text);
  text = text.replace(/#\{[^}]*\}/g, "?");
  text = text.replace(/\$\{[^}]*\}/g, "?");
  text = cleanupSql(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
function cleanupSql(text) {
  return text.replace(/\bWHERE\s+(AND|OR)\s+/gi, "WHERE ").replace(/,\s+(?=(WHERE|SET|ORDER|GROUP|HAVING|LIMIT|VALUES)\b)/gi, " ").replace(/,\s*$/gi, "").replace(/\bWHERE\s*(?=(ORDER|GROUP|LIMIT|HAVING)\b)/gi, " ").replace(/\bWHERE\s*$/gi, "");
}
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function readMapperFile(path) {
  return readFileSync2(path, "utf8").replace(/^﻿/, "");
}
function discoverMapperFiles(input) {
  const abs = resolve(input);
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target") continue;
        walk(full);
      } else if (entry.name.toLowerCase().endsWith(".xml")) {
        let head = "";
        try {
          head = readFileSync2(full, "utf8").slice(0, 4096);
        } catch {
          continue;
        }
        if (/<mapper\b/i.test(head)) found.push(full);
      }
    }
  };
  walk(abs);
  return found.sort();
}
function loadMapperFiles(paths) {
  const statements = [];
  for (const path of paths) {
    try {
      statements.push(...parseMapperText(readMapperFile(path), path));
    } catch (err) {
      statements.push({
        id: "<parse-error>",
        namespace: "",
        kind: "unknown",
        file: path,
        line: 1,
        variants: [],
        rawInterpolation: false,
        notes: [`XML \u8BFB\u53D6\u5931\u8D25\uFF1A${err.message}`]
      });
    }
  }
  return statements;
}
function mapperStatementsToRecords(statements) {
  const records = [];
  for (const stmt of statements) {
    for (const variant of stmt.variants) {
      if (variant.sql.length === 0) continue;
      const parsed = parseSql(variant.sql);
      records.push({
        fingerprint: parsed.fingerprint,
        sql: variant.sql,
        source: { file: stmt.file, line: stmt.line },
        parsed,
        input: "mapper",
        statementId: `${stmt.id}${variant.label ? `#${variant.label}` : ""}`,
        namespace: stmt.namespace || void 0,
        rawInterpolation: stmt.rawInterpolation,
        occurrences: 1
      });
    }
    if (stmt.variants.length === 0 && stmt.notes.length > 0) {
      records.push({
        fingerprint: `error:${stmt.file}:${stmt.line}`,
        sql: "",
        source: { file: stmt.file, line: stmt.line },
        parsed: parseSql(""),
        input: "mapper",
        statementId: stmt.id,
        occurrences: 1
      });
    }
  }
  return records;
}

// src/core/input.ts
import { readFileSync as readFileSync3, existsSync, statSync as statSync2 } from "fs";
import { basename } from "path";
function detectInputKind(pathOrText) {
  const name = basename(pathOrText).toLowerCase();
  if (name.endsWith(".xml")) return "mapper";
  if (name.endsWith(".json")) return "schema";
  if (name.endsWith(".log") || name.endsWith(".slow") || /query[-_]?time/.test(pathOrText)) return "slowlog";
  if (name.endsWith(".sql")) return "sql";
  if (existsSync(pathOrText) && isDirectory(pathOrText)) return "mapper";
  return "sql";
}
function isDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function loadInput(source, options = {}) {
  const notes = [];
  const kind = options.kind ?? detectInputKind(source);
  if (options.inline || !options.kind && !existsSync(source)) {
    const records = splitStatements(source).map((sql) => {
      const parsed = parseSql(sql);
      if (parsed.notes.length > 0) notes.push(...parsed.notes);
      return { fingerprint: parsed.fingerprint, sql, parsed, input: "sql", occurrences: 1 };
    });
    return { kind: "sql", notes, records };
  }
  if (kind === "mapper") {
    const files = discoverMapperFiles(source);
    if (files.length === 0) notes.push(`\u5728 ${source} \u4E0B\u6CA1\u6709\u627E\u5230 <mapper> XML \u6587\u4EF6`);
    const statements = loadMapperFiles(files);
    return { kind, notes, records: mapperStatementsToRecords(statements) };
  }
  if (kind === "schema") {
    return { kind, records: [], notes: [`${source} \u662F schema \u6587\u4EF6\uFF0C\u8BF7\u7528 --schema \u4F20\u5165`] };
  }
  const text = readFileSync3(source, "utf8");
  const result = kind === "sql" && !isDirectory(source) && source.toLowerCase().endsWith(".sql") ? { records: buildRecordsFromSqlText(text, source), ignoredEvents: 0, totalEvents: 0 } : (() => {
    const slow = parseSlowLog(text, source);
    return { records: slow.records, ignoredEvents: slow.ignoredEvents, totalEvents: slow.totalEvents };
  })();
  if (kind === "slowlog" && result.ignoredEvents > 0) {
    notes.push(`\u5FFD\u7565\u4E86 ${result.ignoredEvents} \u4E2A\u65E0\u6CD5\u8BC6\u522B\u7684\u4E8B\u4EF6\u5757`);
  }
  for (const reason of new Set(result.records.flatMap((r) => r.parsed.notes))) notes.push(reason);
  return { kind: kind === "sql" ? "sql" : "slowlog", records: result.records, notes };
}
function buildRecordsFromSqlText(text, file) {
  const records = [];
  let buffer = "";
  let line = 1;
  let bufferLine = 1;
  const flush = () => {
    const sql = buffer.trim().replace(/;\s*$/, "");
    buffer = "";
    if (sql.length === 0) return;
    const parsed = parseSql(sql);
    records.push({
      fingerprint: parsed.fingerprint,
      sql,
      source: file ? { file, line: bufferLine } : void 0,
      parsed,
      input: "sql",
      occurrences: 1
    });
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (buffer.length === 0) bufferLine = line;
    const trimmed = rawLine.trim();
    if (buffer.length === 0 && (trimmed.startsWith("--") || trimmed.startsWith("#"))) {
      line += 1;
      continue;
    }
    buffer += `${rawLine}
`;
    if (trimmed.endsWith(";")) flush();
    line += 1;
  }
  flush();
  return records;
}

// src/version.ts
import { readFileSync as readFileSync4 } from "fs";
import { fileURLToPath } from "url";
function readVersion() {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync4(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
      if (pkg.name === "sql-index-advisor" && typeof pkg.version === "string") return pkg.version;
    } catch {
    }
  }
  return "0.0.0-unknown";
}
var VERSION = readVersion();

// src/mcp/tools.ts
var INSTRUCTIONS = [
  "sql-index-advisor\uFF1AMySQL / MyBatis \u79BB\u7EBF\u7D22\u5F15\u987E\u95EE\u3002",
  "\u5206\u6790\u7ED3\u679C\u7531\u786E\u5B9A\u6027\u89C4\u5219\u4EA7\u751F\uFF0C\u53EF\u590D\u73B0\u3001\u53EF\u5355\u6D4B\uFF1B\u4E0D\u8FDE\u63A5\u6570\u636E\u5E93\u3001\u4E0D\u6267\u884C\u4EFB\u4F55 DDL\u3002",
  "\u8FD4\u56DE\u7684\u6BCF\u6761 finding \u90FD\u5E26 rule / \u8BC1\u636E SQL / suggestedDDL\uFF0C\u9700\u8981\u89E3\u91CA\u65F6\u8C03\u7528 explain_rules\u3002",
  "\u63D0\u4F9B schema.json \u4F1A\u663E\u8457\u63D0\u9AD8\u7CBE\u5EA6\uFF08SIA002/003/005/007 \u4F9D\u8D56\u5B83\uFF09\uFF1B\u62FF\u4E0D\u5230\u65F6\u5148\u7528\u65E0 schema \u6A21\u5F0F\uFF0C\u5E76\u5411\u7528\u6237\u8BF4\u660E\u7CBE\u5EA6\u53D7\u9650\u3002"
].join("\n");
var schemaInput = z2.string().optional().describe("schema.json \u7684\u5185\u5BB9\uFF08JSON \u5B57\u7B26\u4E32\uFF09\uFF0C\u6216\u672C\u673A\u4E0A\u7684\u8DEF\u5F84");
var severitySchema = z2.enum(["error", "warn", "info"]).optional();
var emitSqlSchema = z2.boolean().optional().describe("\u4E3A true \u65F6\u9644\u5E26\u53BB\u91CD\u540E\u7684\u8FC1\u79FB SQL");
function safeRead(path) {
  try {
    return readFileSync5(path, "utf8");
  } catch {
    return void 0;
  }
}
function loadSchemaInput(input) {
  if (!input) return {};
  const text = existsSync2(input) ? safeRead(input) : input;
  if (!text) return { error: `\u65E0\u6CD5\u8BFB\u53D6 schema\uFF1A${input}` };
  try {
    const parsed = validateSchema(JSON.parse(text));
    if (parsed.errors.length > 0) return { error: `schema \u6821\u9A8C\u5931\u8D25\uFF1A${parsed.errors.join("; ")}` };
    return { schema: parsed.schema };
  } catch (err) {
    return { error: `schema \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${err.message}` };
  }
}
function ruleOptions(input) {
  return {
    minSeverity: input.minSeverity ?? "info",
    mysqlVersion: Number.parseFloat(input.mysqlVersion ?? "8"),
    prefixBytes: input.prefixBytes ?? DEFAULT_RULE_OPTIONS.prefixBytes,
    deepOffsetThreshold: input.deepOffset ?? DEFAULT_RULE_OPTIONS.deepOffsetThreshold
  };
}
function toolResult(source, result, options = {}) {
  const capped = options.top && options.top > 0 ? options.top : 50;
  const report = {
    ...buildJsonReport({ ...result, findings: result.findings.slice(0, capped) }, source, VERSION),
    truncated: Math.max(0, result.findings.length - capped)
  };
  const headline = result.findings.length === 0 ? "\u6CA1\u6709\u53D1\u73B0\u53EF\u62A5\u544A\u7684\u7D22\u5F15\u95EE\u9898\u3002" : `\u53D1\u73B0 ${result.findings.length} \u6761\u5EFA\u8BAE\uFF1A${result.findings.slice(0, 8).map((f) => `${f.rule}(${f.severity})`).join(", ")}${result.findings.length > 8 ? " \u2026" : ""}`;
  const skipped = result.skipped.length > 0 ? `\u672A\u53C2\u4E0E\u5224\u5B9A\u7684\u89C4\u5219\uFF1A${result.skipped.map((s) => `${s.id}(${s.reason})`).join("; ")}` : "";
  const text = [
    headline,
    `${result.records} \u4E2A\u67E5\u8BE2\u6307\u7EB9`,
    ...skipped ? [skipped] : [],
    ...result.errors.map((e) => `\u89C4\u5219\u5F02\u5E38\uFF1A${e}`) ?? [],
    ...options.emitSql ? ["", "\u2500\u2500 migration SQL \u2500\u2500", renderMigration(result, source, { lang: "en" })] : [],
    "",
    "\u2500\u2500 \u7ED3\u6784\u5316\u7ED3\u679C \u2500\u2500",
    JSON.stringify(report, null, 2)
  ].join("\n");
  return { content: [{ type: "text", text }], structuredContent: report };
}
function failure(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function analysableRecords(records) {
  return records.filter((record) => record.parsed.kind !== "unknown");
}
var NOTHING_ANALYSABLE = "\u6CA1\u6709\u89E3\u6790\u51FA\u4EFB\u4F55\u53EF\u5206\u6790\u7684\u8BED\u53E5\uFF08\u652F\u6301 SELECT / INSERT / UPDATE / DELETE\uFF09\u3002";
function analyzeSqlTool(args) {
  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);
  const records = loadInput(args.sql, { inline: true }).records;
  const usable = analysableRecords(records);
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  return toolResult("inline-sql", analyze(usable, { schema, ...ruleOptions(args) }), {
    emitSql: args.emitSql
  });
}
function analyzeSlowLogTool(args) {
  if (!args.path && !args.content) return failure("\u9700\u8981 path \u6216 content \u4E4B\u4E00\u3002");
  const text = args.content ?? safeRead(args.path);
  if (!text) return failure(`\u8BFB\u4E0D\u5230\u6162\u65E5\u5FD7\u6587\u4EF6\uFF1A${args.path}`);
  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);
  const source = args.path ?? "inline-slowlog";
  const parsed = parseSlowLog(text, source);
  const usable = analysableRecords(parsed.records);
  if (parsed.records.length === 0) {
    return failure(`\u6CA1\u6709\u4ECE\u6162\u65E5\u5FD7\u4E2D\u89E3\u6790\u51FA\u8BED\u53E5\uFF08\u5FFD\u7565\u4E86 ${parsed.ignoredEvents} \u4E2A\u4E8B\u4EF6\u5757\uFF09\u3002`);
  }
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  return toolResult(source, analyze(usable, { schema, ...ruleOptions(args) }), {
    emitSql: args.emitSql,
    top: args.top
  });
}
function analyzeMapperTool(args) {
  if (!args.path && !args.xml) return failure("\u9700\u8981 path \u6216 xml \u4E4B\u4E00\u3002");
  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);
  let records;
  let source;
  if (args.xml) {
    records = mapperStatementsToRecords(parseMapperText(args.xml, "inline-mapper.xml"));
    source = "inline-mapper.xml";
  } else {
    const loaded = loadInput(args.path, { kind: "mapper" });
    records = loaded.records;
    source = args.path;
  }
  if (records.length === 0) return failure("\u6CA1\u6709\u89E3\u6790\u51FA\u4EFB\u4F55 mapper \u8BED\u53E5\u3002");
  const usable = analysableRecords(records);
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  return toolResult(source, analyze(usable, { schema, ...ruleOptions(args) }), {
    emitSql: args.emitSql,
    top: args.top
  });
}
function explainRulesTool(args) {
  const wanted = args.ruleId ? ALL_RULES.filter((rule) => rule.id.toLowerCase() === args.ruleId.toLowerCase()) : ALL_RULES;
  if (wanted.length === 0) {
    return failure(`\u672A\u77E5\u89C4\u5219 ${args.ruleId}\uFF1B\u53EF\u9009\uFF1A${ruleCatalogue().map((c) => c.id).join(", ")}`);
  }
  const text = wanted.map((rule) => {
    const deps = [
      rule.needsSchema ? "\u9700\u8981 schema.json" : null,
      rule.needsMetrics ? "\u9700\u8981\u6162\u65E5\u5FD7\u6307\u6807" : null
    ].filter(Boolean);
    return [
      `${rule.id} ${rule.title}`,
      `  \u8F93\u5165\u4F9D\u8D56\uFF1A${deps.length ? deps.join(" + ") : "\u65E0\uFF0C\u4EFB\u4F55\u8F93\u5165\u5F62\u6001\u90FD\u53EF\u5224\u5B9A"}`
    ].join("\n");
  }).join("\n\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      reportVersion: REPORT_VERSION,
      rules: ruleCatalogue()
    }
  };
}

// src/mcp/index.ts
function createServer() {
  const server = new McpServer(
    { name: "sql-index-advisor", version: VERSION },
    { instructions: INSTRUCTIONS }
  );
  server.registerTool(
    "analyze_sql",
    {
      title: "\u5206\u6790\u5355\u6761 SQL",
      description: "\u5BF9\u4E00\u6761\uFF08\u6216\u591A\u6761\u4EE5 ; \u5206\u9694\u7684\uFF09SQL \u505A\u7D22\u5F15\u4F53\u68C0\uFF0C\u8FD4\u56DE\u5E26\u89C4\u5219 ID\u3001\u8BC1\u636E SQL\u3001\u5EFA\u8BAE DDL \u4E0E\u6539\u5199\u8BED\u53E5\u7684\u7ED3\u6784\u5316\u7ED3\u679C\u3002",
      inputSchema: {
        sql: z3.string().min(1).describe("MySQL \u8BED\u53E5\uFF0C\u53EF\u7528 ; \u5206\u9694\u591A\u6761"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z3.enum(["5.7", "8.0"]).optional(),
        prefixBytes: z3.number().int().positive().optional(),
        emitSql: emitSqlSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => analyzeSqlTool(args)
  );
  server.registerTool(
    "analyze_slow_log",
    {
      title: "\u5206\u6790\u6162\u67E5\u8BE2\u65E5\u5FD7",
      description: "\u89E3\u6790 MySQL \u6162\u65E5\u5FD7\uFF0C\u6309 SQL \u6307\u7EB9\u805A\u5408\uFF08\u6B21\u6570 / \u603B\u8017\u65F6 / \u6700\u5927\u626B\u63CF\u884C\u6570\uFF09\u540E\u6309\u6536\u76CA\u964D\u5E8F\u7ED9\u51FA\u7D22\u5F15\u5EFA\u8BAE\u3002path \u4E0E content \u4E8C\u9009\u4E00\u3002",
      inputSchema: {
        path: z3.string().optional().describe("\u672C\u673A\u6162\u65E5\u5FD7\u6587\u4EF6\u8DEF\u5F84"),
        content: z3.string().optional().describe("\u6162\u65E5\u5FD7\u6587\u672C\u5185\u5BB9"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z3.enum(["5.7", "8.0"]).optional(),
        top: z3.number().int().positive().optional().describe("\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u6761\uFF0C\u9ED8\u8BA4 50"),
        emitSql: emitSqlSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => analyzeSlowLogTool(args)
  );
  server.registerTool(
    "analyze_mapper",
    {
      title: "\u5206\u6790 MyBatis Mapper",
      description: "\u89E3\u6790 mapper XML\uFF08\u542B <if>/<where>/<choose>/<foreach>/${}\uFF09\uFF0C\u52A8\u6001\u5206\u652F\u5C55\u5F00\u4E3A\u591A\u53D8\u4F53\u540E\u9010\u6761\u4F53\u68C0\uFF1B\u7ED3\u679C\u5E26\u6587\u4EF6\u4E0E\u884C\u53F7\uFF0C\u53EF\u76F4\u63A5\u7528\u4E8E PR \u884C\u7EA7\u8BC4\u8BBA\u3002path \u4E0E xml \u4E8C\u9009\u4E00\u3002",
      inputSchema: {
        path: z3.string().optional().describe("mapper XML \u6587\u4EF6\u6216\u76EE\u5F55"),
        xml: z3.string().optional().describe("<mapper> \u6587\u6863\u5185\u5BB9"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z3.enum(["5.7", "8.0"]).optional(),
        top: z3.number().int().positive().optional(),
        emitSql: emitSqlSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => analyzeMapperTool(args)
  );
  server.registerTool(
    "explain_rules",
    {
      title: "\u67E5\u8BE2\u89C4\u5219\u8BF4\u660E",
      description: "\u8FD4\u56DE 7 \u6761\u89C4\u5219\u7684\u6E05\u5355\u4E0E\u8F93\u5165\u4F9D\u8D56\u3002\u7ED9\u51FA\u5EFA\u8BAE\u524D\u5148\u5F15\u7528\u8FD9\u91CC\u7684\u8BF4\u660E\u3002",
      inputSchema: {
        ruleId: z3.string().optional().describe("\u4F8B\u5982 SIA001\uFF0C\u7701\u7565\u5219\u8FD4\u56DE\u5168\u90E8")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (args) => explainRulesTool(args)
  );
  return server;
}
async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("sql-index-advisor MCP server ready (stdio)\n");
}

// src/mcp/bin.ts
main().catch((err) => {
  process.stderr.write(`MCP server failed: ${err.message}
`);
  process.exit(2);
});
//# sourceMappingURL=mcp.js.map