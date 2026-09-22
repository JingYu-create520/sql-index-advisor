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

const QUOTES = ["'", '"', "`"] as const;

/** Strip `/* ... *\/` and line comments, keeping string literals intact. */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i]!;

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

    if (QUOTES.includes(ch as (typeof QUOTES)[number])) {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    // block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }

    // Line comments: `-- ...` (needs the space) and `# ...`. A `#{` is not a
    // comment: it is a MyBatis bind parameter, which `tokenize` deliberately
    // keeps as an opaque param. Stripping from `#{` to end of line truncated
    // every inline `WHERE user_id = #{id} AND status = 'PAID'` down to its first
    // column, and the report then proposed an index that was too short.
    if ((ch === "-" && sql[i + 1] === "-" && (sql[i + 2] === " " || sql[i + 2] === "\t")) || (ch === "#" && sql[i + 1] !== "{")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Replace literals with `?`. Handles quoted strings (with `\` and `''` escapes)
 * and standalone numbers, including `0x`, `NULL`-adjacent decimals and exponents.
 */
export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i]!;
        if (c === "\\" && quote === "'") {
          i += 2;
          continue;
        }
        if (c === quote) {
          // doubled quote is an escaped quote, keep scanning
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

    if (
      (ch === "-" || ch === "+") &&
      UNARY_CONTEXT.includes(lastMeaningful(out)) &&
      isDigit(sql[i + 1] ?? "")
    ) {
      // A signed literal is one value: `-3` and `+7` must fingerprint like `3`,
      // otherwise one query pattern splits into several fingerprints.
      i = scanNumber(sql, i + 1);
      out += "?";
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1] ?? ""))) {
      // Only treat as a number when not glued to an identifier (`t1`, `tbl_2024`).
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

/** Collapse `IN (?, ?, ?)` to `IN (?)` so 3-value and 300-value lists match. */
function collapseInLists(sql: string): string {
  return sql.replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)");
}

/** Characters after which a minus sign can only be unary, so `-1` is one literal. */
const UNARY_CONTEXT = "=<>(),!+-*/";

function lastMeaningful(text: string): string {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
  }
  return "";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function scanNumber(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && (isDigit(sql[i]!) || sql[i] === ".")) i += 1;
  if (sql[i] === "e" || sql[i] === "E") {
    const sign = sql[i + 1];
    const afterSign = sign === "+" || sign === "-" ? sql[i + 2] : undefined;
    if (isDigit(sql[i + 1] ?? "") || (afterSign !== undefined && isDigit(afterSign))) {
      i += sign === "+" || sign === "-" ? 3 : 2;
      while (i < sql.length && isDigit(sql[i]!)) i += 1;
    }
  }
  return i;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Full fingerprint: strip comments, mask literals, collapse IN lists and
 * whitespace, lowercase, drop the trailing semicolon.
 */
export function fingerprint(sql: string): string {
  const masked = maskLiterals(stripComments(sql));
  return collapseInLists(masked)
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=<>!])\s*/g, "$1")
    .replace(/;+$/g, "")
    .trim()
    .toLowerCase();
}

/** Display text for reports: comments gone, one line, hard-truncated. */
export function evidence(sql: string, maxLen = 200): string {
  const oneLine = stripComments(sql).replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}
