/**
 * Input plumbing shared by the CLI and the MCP server: figure out what we were
 * handed, and turn loose SQL text into query records.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { InputNote, QueryRecord } from "./types.js";

export type { InputNote };
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

/**
 * `InputNote` is declared in core/types.ts so the rule engine and the reports can
 * name it without importing the loader.
 */
export interface LoadedInput {
  records: QueryRecord[];
  kind: InputKind;
  notes: InputNote[];
}

/** Wrap a parser-produced note, which exists only as one line of text. */
const parseNote = (text: string): InputNote => ({
  note: text,
  noteEn: text.replace("无法识别的谓词已跳过", "unrecognised predicate skipped").replace("已跳过", "skipped"),
});

/** Read a file (or accept inline text) and produce query records. */
export function loadInput(
  source: string,
  options: { inline?: boolean; kind?: InputKind } = {},
): LoadedInput {
  const notes: InputNote[] = [];
  const kind = options.kind ?? detectInputKind(source);

  if (options.inline || (!options.kind && !existsSync(source))) {
    // One record per statement: `analyze_sql` documents `;` as a separator, so a
    // multi-statement call must not be analysed as a single query.
    const records: QueryRecord[] = splitStatements(source).map((sql) => {
      const parsed = parseSql(sql);
      if (parsed.notes.length > 0) notes.push(...parsed.notes.map(parseNote));
      return { fingerprint: parsed.fingerprint, sql, parsed, input: "sql" as const, occurrences: 1 };
    });
    return { kind: "sql", notes, records };
  }

  if (kind === "mapper") {
    const files = discoverMapperFiles(source);
    if (files.length === 0) {
      notes.push({
        note: `在 ${source} 下没有找到 <mapper> XML 文件，这次没有分析任何语句。`,
        noteEn: `No <mapper> XML files under ${source}; nothing was analysed.`,
      });
    }
    const statements = loadMapperFiles(files);
    const records = mapperStatementsToRecords(statements);
    // A MyBatis `${...}` is a text substitution, so the predicate is not in the
    // file at all: `${criterion.condition}` reaches the parser as `where ?` and
    // every rule correctly finds nothing to say. Without this line the run prints
    // "nothing to report" over a project whose filters were never visible, which
    // is exactly the silence-means-passed failure. Seen on a real project where all
    // 205 statements were generated from Example criteria.
    const unjudged = records.filter((r) => r.parsed.notes.length > 0).length;
    if (unjudged > 0) {
      notes.push({
        note: `${unjudged}/${records.length} 条语句的条件无法静态识别（多为 \${} 文本替换，例如 where \${criterion.condition}），这些语句没有参与判定，这不等于通过。`,
        noteEn: `${unjudged}/${records.length} statement(s) had predicates that cannot be resolved statically (usually a \${} text substitution such as where \${criterion.condition}); they took part in no rule, which is not a pass.`,
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
          note: `${source} 是 schema 文件，请用 --schema 传入，而不是当成查询来分析。`,
          noteEn: `${source} is a schema file: pass it with --schema instead of analysing it as queries.`,
        },
      ],
    };
  }

  const text = readFileSync(source, "utf8");
  const result = kind === "sql" && !isDirectory(source) && source.toLowerCase().endsWith(".sql")
    ? { records: buildRecordsFromSqlText(text, source), ignoredEvents: 0, totalEvents: 0 }
    : (() => {
        const slow = parseSlowLog(text, source);
        return { records: slow.records, ignoredEvents: slow.ignoredEvents, totalEvents: slow.totalEvents };
      })();

  if (kind === "slowlog" && result.ignoredEvents > 0) {
    notes.push({
      note: `忽略了 ${result.ignoredEvents} 个无法识别的事件块`,
      noteEn: `${result.ignoredEvents} event block(s) were ignored as unrecognised`,
    });
  }
  // A record the parser refused is not a clean record: surface why, or the run
  // ends with "nothing to report" over input that was never looked at.
  for (const reason of new Set(result.records.flatMap((r) => r.parsed.notes))) notes.push(parseNote(reason));
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
