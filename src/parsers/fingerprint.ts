/**
 * SQL fingerprinting (docs/PLAN.md R2).
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

    // line comments: `-- ...` (needs the space) and `# ...`
    if ((ch === "-" && sql[i + 1] === "-" && (sql[i + 2] === " " || sql[i + 2] === "\t")) || ch === "#") {
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

    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1] ?? ""))) {
      // Only treat as a number when not glued to an identifier (`t1`, `0e1` inside a name).
      const prev = out[out.length - 1];
      if (!prev || !isIdentChar(prev)) {
        while (i < sql.length && (isDigit(sql[i]!) || sql[i] === ".")) i += 1;
        // scientific notation: 1e10, 1E+10, 1.5e-3
        if (sql[i] === "e" || sql[i] === "E") {
          const sign = sql[i + 1];
          const afterSign = sign === "+" || sign === "-" ? sql[i + 2] : undefined;
          if (isDigit(sql[i + 1] ?? "") || (afterSign !== undefined && isDigit(afterSign))) {
            i += sign === "+" || sign === "-" ? 3 : 2;
            while (i < sql.length && isDigit(sql[i]!)) i += 1;
          }
        }
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

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
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
