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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { QueryRecord, StatementKind } from "../core/types.js";
import { parseSql } from "./sql.js";

export interface MapperVariant {
  sql: string;
  /** e.g. `when[1]`, `otherwise`, or "" for the straight-line case. */
  label: string;
}

export interface MapperStatement {
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

const MAX_VARIANTS = 10;
const STATEMENT_TAGS = ["select", "insert", "update", "delete"] as const;

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ");
}

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, " $1 ");
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`);
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/** Index of the matching `</name>` for an opening tag whose body starts at `from`. */
function findClose(text: string, name: string, from: number): number {
  const re = new RegExp(`<${name}\\b[^>]*>?|</${name}\\s*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    const full = m[0];
    if (full.startsWith("</")) {
      depth -= 1;
      if (depth === 0) return m.index;
      continue;
    }
    // `<tag .../>` never opens a scope.
    if (!full.endsWith("/>")) depth += 1;
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

export function parseMapperText(text: string, file: string): MapperStatement[] {
  const out: MapperStatement[] = [];
  const clean = stripXmlComments(text);

  const nsMatch = /<mapper\b[^>]*namespace\s*=\s*["']([^"']+)["']/i.exec(clean);
  const namespace = nsMatch?.[1] ?? "";
  if (!/<mapper\b/i.test(clean)) return out;

  const fragments = new Map<string, string>();
  const sqlTagRe = /<sql\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = sqlTagRe.exec(clean))) {
    const openEnd = m.index + m[0].length;
    const close = findClose(clean, "sql", openEnd);
    if (close === -1) continue;
    const id = attr(m[1] ?? "", "id");
    if (id) fragments.set(id, clean.slice(openEnd, close));
    sqlTagRe.lastIndex = close;
  }

  for (const tag of STATEMENT_TAGS) {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(clean))) {
      const openIndex = hit.index;
      const bodyStart = openIndex + hit[0].length;
      const closeIndex = findClose(clean, tag, bodyStart);
      if (closeIndex === -1) continue;
      re.lastIndex = closeIndex;

      const attributes = hit[1] ?? "";
      const id = attr(attributes, "id") ?? "unknown";
      const statement: MapperStatement = {
        id,
        namespace,
        kind: tag as StatementKind,
        file,
        line: lineOf(clean, openIndex),
        parameterType: attr(attributes, "parameterType"),
        databaseId: attr(attributes, "databaseId"),
        variants: [],
        rawInterpolation: /\$\{/.test(clean.slice(bodyStart, closeIndex)),
        notes: [],
      };

      const body = clean.slice(bodyStart, closeIndex);
      statement.variants = expand(body, fragments, statement.notes);
      out.push(statement);
    }
  }

  return out;
}

/** Recursive `<choose>` expansion. `<if>` bodies are kept inline. */
function expand(body: string, fragments: Map<string, string>, notes: string[]): MapperVariant[] {
  const chooseStart = /<choose\b/i.exec(body);
  if (!chooseStart || chooseStart.index === undefined) {
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }

  const index = chooseStart.index;
  const innerStart = index + chooseStart[0].length;
  const innerEnd = findClose(body, "choose", innerStart);
  if (innerEnd === -1) {
    notes.push("<choose> 未闭合，已按原样展开");
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }

  const prefix = body.slice(0, index);
  const suffix = body.slice(innerEnd + "</choose>".length);
  const inner = body.slice(innerStart, innerEnd);

  const left = expand(prefix, fragments, notes);
  const right = expand(suffix, fragments, notes);

  const branches: { sql: string; label: string }[] = [];
  const whenRe = /<when\b([^>]*)>/gi;
  let w: RegExpExecArray | null;
  let n = 0;
  while ((w = whenRe.exec(inner))) {
    const start = w.index + w[0].length;
    const close = findClose(inner, "when", start);
    if (close === -1) continue;
    whenRe.lastIndex = close;
    n += 1;
    branches.push({ sql: inner.slice(start, close), label: `when[${n}]` });
  }
  const other = /<otherwise\b[^>]*>/i.exec(inner);
  if (other && other.index !== undefined) {
    const start = other.index + other[0].length;
    const close = findClose(inner, "otherwise", start);
    if (close !== -1) branches.push({ sql: inner.slice(start, close), label: "otherwise" });
  }

  if (branches.length === 0) {
    return [{ sql: finalise(body, fragments, notes), label: "" }];
  }

  const variants: MapperVariant[] = [];
  for (const branch of branches) {
    // Branch bodies recurse: a `<choose>` inside a `<when>` is legal MyBatis.
    for (const mid of expand(branch.sql, fragments, notes)) {
      for (const l of left) {
        for (const r of right) {
          if (variants.length >= MAX_VARIANTS) {
            notes.push(`动态分支组合超过 ${MAX_VARIANTS} 个，已截断`);
            return variants;
          }
          const label = [l.label, `${branch.label}${mid.label ? `.${mid.label}` : ""}`, r.label]
            .filter(Boolean)
            .join("/");
          variants.push({
            sql: finalise(`${l.sql} ${mid.sql} ${r.sql}`, fragments, notes),
            label,
          });
        }
      }
    }
  }
  return variants;
}

/** Replace the remaining dynamic tags with plain SQL text. */
function finalise(body: string, fragments: Map<string, string>, notes: string[]): string {
  let text = body;

  text = text.replace(/<selectKey\b[\s\S]*?<\/selectKey>/gi, " ");
  text = text.replace(/<bind\b[^>]*\/?>/gi, " ");

  // <include refid="...">: inline the shared fragment.
  text = text.replace(/<include\b([^>]*?)\/?>/gi, (_all, a: string) => {
    const refid = attr(a, "refid");
    if (!refid) return " ";
    const short = refid.includes(".") ? refid.slice(refid.lastIndexOf(".") + 1) : refid;
    const frag = fragments.get(refid) ?? fragments.get(short);
    if (!frag) {
      notes.push(`<include refid="${refid}"> 未找到片段，已跳过`);
      return " ";
    }
    return frag;
  });

  text = text.replace(/<foreach\b([^>]*)>([\s\S]*?)<\/foreach>/gi, (_all, a: string) => {
    const open = attr(a, "open") ?? "";
    const close = attr(a, "close") ?? "";
    return open === "(" && close === ")" ? "( ? )" : " ? ";
  });

  text = text.replace(/<trim\b([^>]*)>([\s\S]*?)<\/trim>/gi, (_all, a: string, inner: string) => {
    const prefix = attr(a, "prefix") ?? "";
    const suffix = attr(a, "suffix") ?? "";
    const overrides = (attr(a, "prefixOverrides") ?? "")
      .split("|")
      .map((o) => o.trim())
      .filter(Boolean);
    let bodyText = inner.trim();
    for (const o of overrides) {
      bodyText = bodyText.replace(new RegExp(`^${escapeRe(o)}\\s+`, "i"), "");
    }
    return ` ${prefix} ${bodyText} ${suffix} `;
  });

  // `<where>` / `<set>` may be split apart by <choose> expansion, so treat the
  // open and close tags independently instead of matching the pair.
  text = text.replace(/<where\b[^>]*>/gi, " WHERE ");
  text = text.replace(/<\/where\s*>/gi, " ");
  text = text.replace(/<set\b[^>]*>/gi, " SET ");
  text = text.replace(/<\/set\s*>/gi, " ");

  text = text.replace(/<values?\b[^>]*>([\s\S]*?)<\/values?>/gi, " VALUES ");

  // <if>, <when>, <otherwise> that survived: keep the body, drop the tag.
  text = text.replace(/<(?:if|when|otherwise|choose|where|set|trim|foreach)\b[^>]*>/gi, " ");
  text = text.replace(/<\/(?:if|when|otherwise|choose|where|set|trim|foreach)\s*>/gi, " ");
  text = text.replace(/<\/?[a-zA-Z_][\w.:-]*\b[^>]*>/g, (matched) => {
    notes.push(`已移除未支持的标签 ${matched.slice(0, 30)}`);
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

/**
 * MyBatis assembles SQL from fragments, so the joined text needs the same
 * normalisation MyBatis' own `where`/`set` tags would have done.
 */
function cleanupSql(text: string): string {
  return text
    .replace(/\bWHERE\s+(AND|OR)\s+/gi, "WHERE ")
    // a comma left by a trailing `<if>` inside <set> / <trim>
    .replace(/,\s+(?=(WHERE|SET|ORDER|GROUP|HAVING|LIMIT|VALUES)\b)/gi, " ")
    .replace(/,\s*$/gi, "")
    // fragment removed every predicate: don't leave a dangling WHERE
    .replace(/\bWHERE\s*(?=(ORDER|GROUP|LIMIT|HAVING)\b)/gi, " ")
    .replace(/\bWHERE\s*$/gi, "");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readMapperFile(path: string): string {
  return readFileSync(path, "utf8").replace(/^﻿/, "");
}

/** Accepts a file or a directory; recurses and keeps only `<mapper>` files. */
export function discoverMapperFiles(input: string): string[] {
  const abs = resolve(input);
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];

  const found: string[] = [];
  const walk = (dir: string): void => {
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

export function loadMapperFiles(paths: string[]): MapperStatement[] {
  const statements: MapperStatement[] = [];
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
        notes: [`XML 读取失败：${(err as Error).message}`],
      });
    }
  }
  return statements;
}

/** One QueryRecord per variant; `source.line` points at the `<select>` tag. */
export function mapperStatementsToRecords(statements: MapperStatement[]): QueryRecord[] {
  const records: QueryRecord[] = [];
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
        namespace: stmt.namespace || undefined,
        rawInterpolation: stmt.rawInterpolation,
        occurrences: 1,
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
        occurrences: 1,
      });
    }
  }
  return records;
}
