/**
 * Input plumbing shared by the CLI and the MCP server: figure out what we were
 * handed, and turn loose SQL text into query records.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { QueryRecord } from "./types.js";
import { parseSql, splitStatements } from "../parsers/sql.js";
import { parseSlowLog } from "../parsers/slowlog.js";
import { discoverMapperFiles, loadMapperFiles, mapperStatementsToRecords } from "../parsers/mapper.js";

export type InputKind = "slowlog" | "mapper" | "schema" | "sql";

export function detectInputKind(pathOrText: string): InputKind {
  const name = basename(pathOrText).toLowerCase();
  if (name.endsWith(".xml")) return "mapper";
  if (name.endsWith(".json")) return "schema";
  if (name.endsWith(".log") || name.endsWith(".slow") || /query[-_]?time/.test(pathOrText)) return "slowlog";
  if (name.endsWith(".sql")) return "sql";
  if (existsSync(pathOrText) && isDirectory(pathOrText)) return "mapper";
  return "sql";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface LoadedInput {
  records: QueryRecord[];
  kind: InputKind;
  notes: string[];
}

/** Read a file (or accept inline text) and produce query records. */
export function loadInput(
  source: string,
  options: { inline?: boolean; kind?: InputKind } = {},
): LoadedInput {
  const notes: string[] = [];
  const kind = options.kind ?? detectInputKind(source);

  if (options.inline || (!options.kind && !existsSync(source))) {
    // One record per statement: `analyze_sql` documents `;` as a separator, so a
    // multi-statement call must not be analysed as a single query.
    const records: QueryRecord[] = splitStatements(source).map((sql) => {
      const parsed = parseSql(sql);
      if (parsed.notes.length > 0) notes.push(...parsed.notes);
      return { fingerprint: parsed.fingerprint, sql, parsed, input: "sql" as const, occurrences: 1 };
    });
    return { kind: "sql", notes, records };
  }

  if (kind === "mapper") {
    const files = discoverMapperFiles(source);
    if (files.length === 0) notes.push(`在 ${source} 下没有找到 <mapper> XML 文件`);
    const statements = loadMapperFiles(files);
    return { kind, notes, records: mapperStatementsToRecords(statements) };
  }

  if (kind === "schema") {
    return { kind, records: [], notes: [`${source} 是 schema 文件，请用 --schema 传入`] };
  }

  const text = readFileSync(source, "utf8");
  const result = kind === "sql" && !isDirectory(source) && source.toLowerCase().endsWith(".sql")
    ? { records: buildRecordsFromSqlText(text, source), ignoredEvents: 0, totalEvents: 0 }
    : (() => {
        const slow = parseSlowLog(text, source);
        return { records: slow.records, ignoredEvents: slow.ignoredEvents, totalEvents: slow.totalEvents };
      })();

  if (kind === "slowlog" && result.ignoredEvents > 0) {
    notes.push(`忽略了 ${result.ignoredEvents} 个无法识别的事件块`);
  }
  // A record the parser refused is not a clean record: surface why, or the run
  // ends with "nothing to report" over input that was never looked at.
  for (const reason of new Set(result.records.flatMap((r) => r.parsed.notes))) notes.push(reason);
  return { kind: kind === "sql" ? "sql" : "slowlog", records: result.records, notes };
}

/** A .sql file with one statement per `;`, or a raw statement string. */
export function buildRecordsFromSqlText(text: string, file?: string): QueryRecord[] {
  const records: QueryRecord[] = [];
  let buffer = "";
  let line = 1;
  let bufferLine = 1;

  const flush = (): void => {
    const sql = buffer.trim().replace(/;\s*$/, "");
    buffer = "";
    if (sql.length === 0) return;
    const parsed = parseSql(sql);
    records.push({
      fingerprint: parsed.fingerprint,
      sql,
      source: file ? { file, line: bufferLine } : undefined,
      parsed,
      input: "sql",
      occurrences: 1,
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (buffer.length === 0) bufferLine = line;
    const trimmed = rawLine.trim();
    if (buffer.length === 0 && (trimmed.startsWith("--") || trimmed.startsWith("#"))) {
      line += 1;
      continue;
    }
    buffer += `${rawLine}\n`;
    if (trimmed.endsWith(";")) flush();
    line += 1;
  }
  flush();
  return records;
}

export function readTextFile(path: string): string {
  if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
  if (statSync(path).isDirectory()) throw new Error(`${path} 是目录，不是文件`);
  return readFileSync(path, "utf8");
}
