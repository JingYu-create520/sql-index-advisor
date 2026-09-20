/**
 * A tiny SQL token stream.
 *
 * The parser works on tokens rather than regexes so that nested functions,
 * subqueries and quoted identifiers cannot confuse clause splitting. This is
 * the whole reason we can get away with not shipping an SQL parser dependency.
 */

export type TokenType = "word" | "string" | "number" | "param" | "punct";

export interface Token {
  value: string;
  type: TokenType;
  /** Paren depth at this token; depth 0 means top level of the statement. */
  depth: number;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_$一-龥]/;
const WORD_BODY = /[A-Za-z0-9_$一-龥]/;
const PUNCT_TWO = new Set(["!=", "<>", ">=", "<=", "&&", "||"]);
const PUNCT_ONE = "(),;=<>!+-*/%&|^~.:[]{}?\\";

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;

  const push = (value: string, type: TokenType, start: number, end: number, d: number) => {
    tokens.push({ value, type, start, end, depth: d });
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
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
      while (i < sql.length && WORD_BODY.test(sql[i]!)) i += 1;
      push(sql.slice(start, i), "param", start, i, depth);
      continue;
    }

    if (ch === "#" || ch === "$") {
      // MyBatis placeholders survive tokenisation as opaque params.
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
      while (i < sql.length && /[0-9.]/.test(sql[i]!)) i += 1;
      // Scientific notation, with or without a sign: 1e3, 1E10, 1.5e-3. Without
      // the unsigned case `1e999` split into `1` + the word `e999`, and the parser
      // then read `e999` as a column name.
      if (sql[i] === "e" || sql[i] === "E") {
        const next = sql[i + 1];
        if (/[0-9]/.test(next ?? "")) {
          i += 2;
          while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
        } else if ((next === "+" || next === "-") && /[0-9]/.test(sql[i + 2] ?? "")) {
          i += 3;
          while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
        }
      }
      push(sql.slice(start, i), "number", start, i, depth);
      continue;
    }

    if (WORD_START.test(ch)) {
      const start = i;
      while (i < sql.length && WORD_BODY.test(sql[i]!)) i += 1;
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

    // Anything else (odd bytes, stray characters) is skipped, never fatal.
    i += 1;
  }

  return tokens;
}

export function isWord(token: Token | undefined, ...words: string[]): boolean {
  if (!token || token.type !== "word") return false;
  const v = token.value.toLowerCase();
  return words.includes(v);
}

/** Index of the next depth-`depth` keyword, or -1. */
export function indexOfWord(tokens: Token[], word: string, from = 0, depth = 0): number {
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.depth === depth && isWord(t, word)) return i;
  }
  return -1;
}

export function indexOfPunct(tokens: Token[], punct: string, from = 0, depth = 0): number {
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.depth === depth && t.type === "punct" && t.value === punct) return i;
  }
  return -1;
}

/**
 * Split on top-level `AND`, skipping the AND that belongs to `BETWEEN x AND y`.
 */
export function splitOnAnd(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
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

/** Split on top-level commas. */
export function splitOnComma(tokens: Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
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

const SQL_KEYWORDS = new Set(["in", "not", "and", "or", "is", "like", "between", "using", "values"]);

/**
 * Render tokens back to SQL-ish text.
 *
 * The goal is round-tripping: `predicateText` must be findable inside the
 * statement again, otherwise rewrite rules could not substitute into it. Hence
 * the function-call glue, but *not* gluing after a keyword (`IN (` stays).
 */
export function tokensToString(tokens: Token[]): string {
  const spaced = tokens.map((t) => t.value).join(" ");
  return (
    spaced
      .replace(/\s*\.\s*/g, ".")
      .replace(/\s*,\s*/g, ", ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .replace(/([A-Za-z_]\w*)\s+\(/g, (match, word: string) =>
        SQL_KEYWORDS.has(word.toLowerCase()) ? match : `${word}(`,
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Reconstruct source text covering [startIdx, endIdx) so positions stay readable. */
export function sourceOf(tokens: Token[], from: number, to: number): string {
  const slice = tokens.slice(from, to);
  if (slice.length === 0) return "";
  return slice.map((t) => t.value).join(" ");
}
