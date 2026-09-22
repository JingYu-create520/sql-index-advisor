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
function resolveLang(requested = "auto") {
  if (requested === "zh" || requested === "en") return requested;
  const env = `${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}${process.env.LC_CTYPE ?? ""}`;
  return /zh|chinese/i.test(env) ? "zh" : "en";
}

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
function splitOnWord(tokens, word, baseDepth = tokens[0]?.depth ?? 0) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    if (t.depth === baseDepth && isWord(t, word)) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  groups.push(current);
  return groups.filter((g) => g.length > 0);
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
  return parseSqlAll(input)[0];
}
function parseSqlAll(input) {
  let tokens;
  try {
    tokens = tokenize(stripComments(input));
  } catch (err) {
    return [bailOut(input, err)];
  }
  if (tokens.length === 0) return [{ ...blankQuery(input), notes: ["\u7A7A\u8BED\u53E5\uFF0C\u5DF2\u8DF3\u8FC7"] }];
  const merged = countMergedStatements(tokens);
  if (merged > 0) {
    return [
      {
        ...blankQuery(input),
        notes: [
          `\u8FD9\u6761\u8F93\u5165\u91CC\u6DF7\u4E86 ${merged + 1} \u4E2A\u8BED\u53E5\u4F46\u6CA1\u6709\u4EFB\u4F55\u5206\u53F7\u5206\u9694\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A\u628A\u5B83\u4EEC\u5F53\u6210\u4E00\u6761\u89E3\u6790\u4F1A\u7ED9\u51FA\u8DE8\u8868\u7684\u7D22\u5F15\u5EFA\u8BAE\u3002\u6BCF\u6761\u8BED\u53E5\u8BF7\u4EE5 ; \u7ED3\u5C3E\u3002`
        ]
      }
    ];
  }
  const out = [parseStatement(input, tokens, TOP)];
  for (const body of subSelectBodies(tokens)) {
    const text = tokensToString(body);
    out.push(parseStatement(text, body, SUB));
  }
  return out;
}
function subSelectBodies(tokens) {
  const bodies = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const open = tokens[i];
    if (open.type !== "punct" || open.value !== "(") continue;
    if (!isWord(tokens[i + 1], "select")) continue;
    const close = matchingClose(tokens, i);
    const base = open.depth;
    bodies.push(tokens.slice(i + 1, close).map((t) => ({ ...t, depth: t.depth - base - 1 })));
  }
  return bodies;
}
function blankQuery(input) {
  return {
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
}
function bailOut(input, err) {
  return { ...blankQuery(input), notes: [`\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${err.message}`] };
}
function parseStatement(input, tokens, ctx) {
  const notes = [];
  try {
    const kind = statementKind(tokens);
    const parsed = analyse(kind, tokens, notes, ctx);
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
      // Only set on a body lifted out of parentheses; the key must not exist for
      // a top-level statement, or every snapshot and JSON dump grows a null.
      ...ctx.subquery ? { subquery: true } : {},
      notes
    };
  } catch (err) {
    return { ...blankQuery(input), notes: [`\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${err.message}`] };
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
var TOP = { subquery: false };
var SUB = { subquery: true };
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
function analyse(kind, tokens, notes, ctx) {
  const topUnion = indexOfWord(tokens, "union", 0, 0);
  if (topUnion !== -1) {
    notes.push("UNION \u53EA\u5206\u6790\u7B2C\u4E00\u4E2A\u5206\u652F\uFF08\u5E26\u62EC\u53F7\u7684\u5206\u652F\u4F1A\u6309\u72EC\u7ACB\u8BED\u53E5\u5206\u6790\uFF09\uFF1B\u65E0\u62EC\u53F7\u7684\u540E\u7EED\u5206\u652F\u672A\u53C2\u4E0E\u5224\u5B9A");
    tokens = tokens.slice(0, topUnion);
  }
  switch (kind) {
    case "select":
      return analyseSelect(tokens, notes, ctx);
    case "update":
      return analyseUpdate(tokens, notes, ctx);
    case "delete":
      return analyseDelete(tokens, notes, ctx);
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
function analyseSelect(tokens, notes, ctx) {
  const out = blank();
  const fromIdx = indexOfWord(tokens, "from", 0, 0);
  const selectEnd = fromIdx === -1 ? tokens.length : fromIdx;
  readSelectList(tokens.slice(1, selectEnd), out, notes);
  if (fromIdx === -1) {
    out.tables = [];
    return out;
  }
  const end = clauseBoundary(tokens, fromIdx);
  readFrom(tokens.slice(fromIdx + 1, end), out, notes, ctx);
  const whereStart = indexOfWord(tokens, "where", fromIdx, 0);
  if (whereStart !== -1 && whereStart >= end) {
    const whereEnd = findNextClause(tokens, whereStart, tokens.length);
    out.whereText = tokensToString(tokens.slice(whereStart + 1, whereEnd));
    readWhere(tokens.slice(whereStart + 1, whereEnd), out, notes, ctx);
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
function analyseUpdate(tokens, notes, ctx) {
  const out = blank();
  const setIdx = indexOfWord(tokens, "set", 0, 0);
  if (setIdx === -1) {
    notes.push("UPDATE \u8BED\u53E5\u7F3A\u5C11 SET\uFF0C\u5DF2\u8DF3\u8FC7");
    return out;
  }
  readFrom(tokens.slice(1, setIdx), out, notes, ctx);
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
    readWhere(tokens.slice(whereIdx + 1, whereEnd), out, notes, ctx);
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
function analyseDelete(tokens, notes, ctx) {
  const out = blank();
  const fromIdx = indexOfWord(tokens, "from", 0, 0);
  if (fromIdx === -1) {
    notes.push("DELETE \u8BED\u53E5\u7F3A\u5C11 FROM\uFF0C\u5DF2\u8DF3\u8FC7");
    return out;
  }
  const end = clauseBoundary(tokens, fromIdx);
  readFrom(tokens.slice(fromIdx + 1, end), out, notes, ctx);
  const whereIdx = indexOfWord(tokens, "where", fromIdx, 0);
  if (whereIdx !== -1) {
    const whereEnd = findNextClause(tokens, whereIdx, tokens.length);
    out.whereText = tokensToString(tokens.slice(whereIdx + 1, whereEnd));
    readWhere(tokens.slice(whereIdx + 1, whereEnd), out, notes, ctx);
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
function readFrom(tokens, out, notes, ctx) {
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
        out.columns.push(...classifyPredicate(pred, "join-on", notes, ctx));
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
    notes.push("FROM \u5B50\u67E5\u8BE2\u5DF2\u6309\u72EC\u7ACB\u8BED\u53E5\u5206\u6790\uFF1B\u5916\u5C42\u9488\u5BF9\u6D3E\u751F\u8868\u522B\u540D\u7684\u8FC7\u6EE4\u6761\u4EF6\u65E0\u6CD5\u5BF9\u5E94\u5230\u7269\u7406\u8868\uFF0C\u672A\u53C2\u4E0E\u5224\u5B9A");
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
function readWhere(tokens, out, notes, ctx) {
  if (tokens.length === 0) return;
  const orIdx = indexOfWord(tokens, "or", 0, 0);
  if (orIdx !== -1) {
    notes.push("WHERE \u542B\u9876\u5C42 OR\uFF0C\u7D22\u5F15\u5EFA\u8BAE\u6309\u6700\u5DE6\u524D\u7F00\u4EA4\u96C6\u4FDD\u5B88\u5904\u7406");
  }
  for (const pred of splitOnAnd(tokens)) {
    out.columns.push(...classifyPredicate(pred, "where", notes, ctx));
  }
}
function unwrapConditionGroup(tokens) {
  if (tokens.length < 3 || tokens[0].value !== "(" || matchingClose(tokens, 0) !== tokens.length - 1) {
    return void 0;
  }
  const base = tokens[0].depth;
  return tokens.slice(1, -1).map((t) => ({ ...t, depth: t.depth - base - 1 }));
}
function classifyOr(branches, scope, notes, ctx) {
  const perBranch = branches.map((b) => classifyPredicate(b, scope, notes, ctx)).filter((g) => g.length > 0);
  if (perBranch.length === 0) return [];
  const oneColumnPerBranch = perBranch.every((g) => g.length === 1);
  const columns = perBranch.map((g) => g[0].column);
  const allEquality = perBranch.every((g) => (g[0].op ?? "=") === "=");
  if (oneColumnPerBranch && allEquality && new Set(columns).size === 1) {
    const first = perBranch[0][0];
    return [{ ...first, scope: "where-in", op: "in", raw: tokensToString(joinOrBranches(branches)) }];
  }
  return perBranch.flat().map((ref) => ({ ...ref, scope: "where-or" }));
}
function joinOrBranches(branches) {
  return branches.reduce((acc, b, i) => i === 0 ? [...b] : [...acc, { type: "word", value: "or" }, ...b], []);
}
function classifyPredicate(pred, scope, notes, ctx) {
  if (pred.length === 0) return [];
  const unwrapped = unwrapConditionGroup(pred);
  if (unwrapped) {
    const andGroups = splitOnAnd(unwrapped);
    if (andGroups.length > 1) {
      return andGroups.flatMap((group) => classifyPredicate(group, scope, notes, ctx));
    }
    return classifyPredicate(unwrapped, scope, notes, ctx);
  }
  const orBranches = splitOnWord(pred, "or");
  if (orBranches.length > 1) return classifyOr(orBranches, scope, notes, ctx);
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
      const outerColumn = ctx.subquery && !rightRef?.table;
      if (rightRef && !isWord(right[0], "null") && !outerColumn) {
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

// src/core/subqueries.ts
function withSubqueryRecords(records) {
  const out = [];
  const byFingerprint = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (!byFingerprint.has(record.fingerprint)) byFingerprint.set(record.fingerprint, record);
  }
  for (const record of records) {
    out.push(record);
    if (record.parsed.subquery) continue;
    for (const inner of parseSqlAll(record.sql).slice(1)) {
      const seen = byFingerprint.get(inner.fingerprint);
      if (seen) {
        foldInto(seen, record);
        continue;
      }
      const created = {
        fingerprint: inner.fingerprint,
        sql: inner.sql,
        source: record.source,
        parsed: inner,
        input: record.input,
        statementId: `${record.statementId ?? record.fingerprint.slice(0, 12)}#subquery`,
        namespace: record.namespace,
        rawInterpolation: record.rawInterpolation,
        occurrences: record.occurrences,
        totalQueryTime: record.totalQueryTime,
        maxRowsExamined: record.maxRowsExamined,
        metrics: record.metrics
      };
      byFingerprint.set(inner.fingerprint, created);
      out.push(created);
    }
  }
  return out;
}
function foldInto(existing, from) {
  if (existing === from) return;
  existing.occurrences = (existing.occurrences ?? 0) + (from.occurrences ?? 0);
  existing.totalQueryTime = (existing.totalQueryTime ?? 0) + (from.totalQueryTime ?? 0);
  existing.maxRowsExamined = Math.max(existing.maxRowsExamined ?? 0, from.maxRowsExamined ?? 0);
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
  const records = withSubqueryRecords(
    [...byFingerprint.values()].sort((a, b) => (b.totalQueryTime ?? 0) - (a.totalQueryTime ?? 0))
  );
  return { records, ignoredEvents, totalEvents };
}

// src/parsers/mapper.ts
import { readFileSync, readdirSync, statSync } from "fs";
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
  return readFileSync(path, "utf8").replace(/^﻿/, "");
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
          head = readFileSync(full, "utf8").slice(0, 4096);
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
  return withSubqueryRecords(records);
}

// src/core/input.ts
import { readFileSync as readFileSync2, existsSync, statSync as statSync2 } from "fs";
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
var REASON_PREFIX_EN = [
  ["\u65E0\u6CD5\u8BC6\u522B\u7684\u8C13\u8BCD\u5DF2\u8DF3\u8FC7", "unrecognised predicate skipped"],
  ["\uFF0C\u5DF2\u8DF3\u8FC7", ", skipped"],
  ["\u672A\u627E\u5230\u7247\u6BB5", "fragment not found"],
  ["\u52A8\u6001\u5206\u652F\u7EC4\u5408\u8D85\u8FC7", "dynamic branch combinations exceeded"],
  ["\u5DF2\u79FB\u9664\u672A\u652F\u6301\u7684\u6807\u7B7E", "unsupported tag removed"],
  ["\u672A\u627E\u5230\u7247\u6BB5\uFF0C\u5DF2\u8DF3\u8FC7", "fragment not found, skipped"],
  ["\u4E2D\u7684\u8868\u8FBE\u5F0F\u65E0\u6CD5\u9759\u6001\u5206\u6790", "expression cannot be analysed statically"],
  ["WHERE \u542B\u9876\u5C42 OR", "WHERE contains a top-level OR"],
  ["\u6761\u8BED\u53E5", "statement(s)"],
  ["include refid", "include refid"],
  ["UNION \u53EA\u5206\u6790\u7B2C\u4E00\u4E2A\u5206\u652F", "only the first UNION branch is analysed"],
  ["\uFF08\u5E26\u62EC\u53F7\u7684\u5206\u652F\u4F1A\u6309\u72EC\u7ACB\u8BED\u53E5\u5206\u6790\uFF09", " (a bracketed branch is analysed as a statement of its own)"],
  ["\u4E0D\u652F\u6301\u7684\u8BED\u53E5\u7C7B\u578B", "unsupported statement type"],
  ["\uFF08\u652F\u6301 ", " (supported: "],
  ["\u65E0\u62EC\u53F7\u7684\u540E\u7EED\u5206\u652F\u672A\u53C2\u4E0E\u5224\u5B9A", "later unbracketed branches took no rule"],
  // A derived table is analysed as its own statement now; what is left out is the
  // outer filter on its alias, so the translation has to carry that distinction.
  ["FROM \u5B50\u67E5\u8BE2\u5DF2\u6309\u72EC\u7ACB\u8BED\u53E5\u5206\u6790", "the FROM subquery is analysed as a statement of its own"],
  ["\uFF1B\u5916\u5C42\u9488\u5BF9\u6D3E\u751F\u8868\u522B\u540D\u7684\u8FC7\u6EE4\u6761\u4EF6", "; but an outer filter on the derived table's alias "],
  ["\u65E0\u6CD5\u5BF9\u5E94\u5230\u7269\u7406\u8868", "cannot be mapped to a physical table"],
  ["\u672A\u53C2\u4E0E\u5224\u5B9A", "and took no rule"],
  // Punctuation last: a note is easier to read in the English report when the
  // full-width colon and comma inside it are normalised too.
  ["\uFF1A", ": "],
  ["\uFF1B", "; "],
  ["\uFF0C", ", "],
  ["\uFF09", ")"]
];
function englishReason(reason) {
  let out = reason;
  let touched = false;
  for (const [zh, en] of REASON_PREFIX_EN) {
    if (out.includes(zh)) {
      out = out.split(zh).join(en);
      touched = true;
    }
  }
  return touched ? out : reason;
}
var parseNote = (text) => ({
  note: text,
  noteEn: englishReason(text)
});
function loadInput(source, options = {}) {
  const notes = [];
  const kind = options.kind ?? detectInputKind(source);
  if (options.inline || !options.kind && !existsSync(source)) {
    const outer = splitStatements(source).map((sql) => {
      const parsed = parseSql(sql);
      return { fingerprint: parsed.fingerprint, sql, parsed, input: "sql", occurrences: 1 };
    });
    const records = withSubqueryRecords(outer);
    for (const record of records) {
      if (record.parsed.notes.length > 0) notes.push(...record.parsed.notes.map(parseNote));
    }
    return { kind: "sql", notes, records };
  }
  if (kind === "mapper") {
    const files = discoverMapperFiles(source);
    if (files.length === 0) {
      notes.push({
        note: `\u5728 ${source} \u4E0B\u6CA1\u6709\u627E\u5230 <mapper> XML \u6587\u4EF6\uFF0C\u8FD9\u6B21\u6CA1\u6709\u5206\u6790\u4EFB\u4F55\u8BED\u53E5\u3002`,
        noteEn: `No <mapper> XML files under ${source}; nothing was analysed.`
      });
    }
    const statements = loadMapperFiles(files);
    const records = mapperStatementsToRecords(statements);
    const reasons = /* @__PURE__ */ new Map();
    for (const record of records) {
      for (const reason of new Set(record.parsed.notes)) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      notes.push({
        note: `${count} \u6761\u8BED\u53E5\uFF1A${reason}\u3002\u8FD9\u90E8\u5206\u6CA1\u6709\u53C2\u4E0E\u5224\u5B9A\uFF0C\u4E0D\u7B49\u4E8E\u901A\u8FC7\u3002`,
        noteEn: `${count} statement(s): ${englishReason(reason)}. This part took no rule, which is not a pass.`
      });
    }
    return { kind, notes, records };
  }
  if (kind === "schema") {
    return {
      kind,
      records: [],
      notes: [
        {
          note: `${source} \u662F schema \u6587\u4EF6\uFF0C\u8BF7\u7528 --schema \u4F20\u5165\uFF0C\u800C\u4E0D\u662F\u5F53\u6210\u67E5\u8BE2\u6765\u5206\u6790\u3002`,
          noteEn: `${source} is a schema file: pass it with --schema instead of analysing it as queries.`
        }
      ]
    };
  }
  const text = readFileSync2(source, "utf8");
  const result = kind === "sql" && !isDirectory(source) && source.toLowerCase().endsWith(".sql") ? { records: buildRecordsFromSqlText(text, source), ignoredEvents: 0, totalEvents: 0 } : (() => {
    const slow = parseSlowLog(text, source);
    return { records: slow.records, ignoredEvents: slow.ignoredEvents, totalEvents: slow.totalEvents };
  })();
  if (kind === "slowlog" && result.ignoredEvents > 0) {
    notes.push({
      note: `\u5FFD\u7565\u4E86 ${result.ignoredEvents} \u4E2A\u65E0\u6CD5\u8BC6\u522B\u7684\u4E8B\u4EF6\u5757`,
      noteEn: `${result.ignoredEvents} event block(s) were ignored as unrecognised`
    });
  }
  for (const reason of new Set(result.records.flatMap((r) => r.parsed.notes))) notes.push(parseNote(reason));
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
  return withSubqueryRecords(records);
}
function readTextFile(path) {
  if (!existsSync(path)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${path}`);
  if (statSync2(path).isDirectory()) throw new Error(`${path} \u662F\u76EE\u5F55\uFF0C\u4E0D\u662F\u6587\u4EF6`);
  return readFileSync2(path, "utf8");
}

// src/schema/loader.ts
import { z } from "zod";
import { readFileSync as readFileSync3 } from "fs";
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
  // `nullable()` because that is what MySQL 8.0 reports for a functional index
  // key part. Rejecting it used to fail the *whole* file, so one
  // `CREATE INDEX … ((DATE(create_time)))` anywhere in the database cost the user
  // every schema-gated rule — and SIA004 is the rule that tells them to write one.
  columns: z.array(z.string().nullable()).min(1),
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
      // A functional or multi-valued index key part has no column name at all
      // (`COLUMN_NAME` is NULL in information_schema), so `null` is kept rather
      // than dropped: dropping it would silently shorten the index and let a rule
      // read `(user_id)` out of `(cast(x as date), user_id)`.
      columns: i.columns.map((c) => c?.toLowerCase() ?? null),
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
function loadSchema(path) {
  let text;
  try {
    text = readFileSync3(path, "utf8");
  } catch (err) {
    return { errors: [`\u65E0\u6CD5\u8BFB\u53D6 schema \u6587\u4EF6 ${path}\uFF1A${err.message}`] };
  }
  try {
    return validateSchema(JSON.parse(text));
  } catch (err) {
    return { errors: [`${path} \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${err.message}`] };
  }
}
export {
  DEFAULT_RULE_OPTIONS,
  SEVERITY_ORDER,
  buildRecordsFromSqlText,
  detectInputKind,
  discoverMapperFiles,
  evidence,
  fingerprint,
  loadInput,
  loadMapperFiles,
  loadSchema,
  mapperStatementsToRecords,
  maskLiterals,
  parseMapperText,
  parseSlowLog,
  parseSql,
  readMapperFile,
  readTextFile,
  resolveLang,
  resolveTable,
  stripComments,
  validateSchema
};
//# sourceMappingURL=index.js.map