/**
 * MySQL slow query log reader.
 *
 * Two jobs: split the file into events, then aggregate events by SQL fingerprint
 * (docs/PLAN.md R2). A real log repeats one pattern hundreds of times, so ranking
 * raw events produces a report nobody can act on.
 */

import type { QueryRecord, QueryMetrics } from "../core/types.js";
import { fingerprint } from "./fingerprint.js";
import { parseSql } from "./sql.js";

export interface SlowLogResult {
  records: QueryRecord[];
  /** Events we could not turn into a statement (admin commands, empty blocks). */
  ignoredEvents: number;
  totalEvents: number;
}

interface Event {
  line: number;
  metrics: QueryMetrics;
  sqlLines: string[];
  /** True once a `;` closed the statement. */
  terminated: boolean;
}

const RE_TIME = /^#\s*Time:\s*(.+)$/;
const RE_USER_HOST = /^#\s*User@Host:\s*(.+)$/;
const RE_QUERY_TIME = /#\s*Query_time:\s*([0-9.]+)/;
const RE_LOCK_TIME = /Lock_time:\s*([0-9.]+)/;
const RE_ROWS_SENT = /Rows_sent:\s*([0-9]+)/;
const RE_ROWS_EXAMINED = /Rows_examined:\s*([0-9]+)/;
const RE_SCHEMA = /^#\s*Schema:\s*(.*)$/;

/** Lines that belong to the log harness rather than to a query. */
function isNoise(line: string): boolean {
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

function newEvent(line: number): Event {
  return { line, metrics: {}, sqlLines: [], terminated: false };
}

export function parseSlowLog(content: string, file = "slow.log"): SlowLogResult {
  const lines = content.split(/\r?\n/);
  const events: Event[] = [];
  let current = newEvent(1);
  let hasCurrent = false;
  let ignoredEvents = 0;

  const flush = (): void => {
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
      // `# Time:` always starts a new event.
      flush();
      current = newEvent(i + 1);
      hasCurrent = true;
      continue;
    }

    if (RE_USER_HOST.test(line)) {
      // A new connection block; keep the buffer if it is still open.
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
      // Unknown `#` comment: ignore, do not break the block.
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

function aggregate(events: Event[], file: string, ignoredEvents: number): SlowLogResult {
  const byFingerprint = new Map<string, QueryRecord>();
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
      // Keep the worst single execution for ranking intuition.
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
      input: "slowlog",
    });
  }

  const records = [...byFingerprint.values()].sort(
    (a, b) => (b.totalQueryTime ?? 0) - (a.totalQueryTime ?? 0),
  );

  return { records, ignoredEvents, totalEvents };
}
