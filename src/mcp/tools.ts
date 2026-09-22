/**
 * MCP tool handlers, kept free of transport concerns so they can be unit tested
 * directly and the stdio layer stays a thin adapter.
 */

import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import type { Schema, Severity } from "../core/types.js";
import { DEFAULT_RULE_OPTIONS } from "../core/types.js";
import { analyze, type AnalysisResult } from "../rules/engine.js";
import { ALL_RULES, ruleCatalogue } from "../rules/registry.js";
import { buildJsonReport, REPORT_VERSION } from "../report/json.js";
import { renderMigration } from "../report/migration.js";
import { parseSlowLog } from "../parsers/slowlog.js";
import { mapperStatementsToRecords, parseMapperText } from "../parsers/mapper.js";
import { loadInput } from "../core/input.js";
import { validateSchema } from "../schema/loader.js";
import { VERSION } from "../version.js";

export { VERSION };

export const INSTRUCTIONS = [
  "sql-index-advisor：MySQL / MyBatis 离线索引顾问。",
  "分析结果由确定性规则产生，可复现、可单测；不连接数据库、不执行任何 DDL。",
  "返回的每条 finding 都带 rule / 证据 SQL / suggestedDDL，需要解释时调用 explain_rules。",
  "提供 schema.json 会显著提高精度（SIA002/003/005/007 依赖它）；拿不到时先用无 schema 模式，并向用户说明精度受限。",
].join("\n");

export const schemaInput = z
  .string()
  .optional()
  .describe("schema.json 的内容（JSON 字符串），或本机上的路径");

export const severitySchema = z.enum(["error", "warn", "info"]).optional();
export const emitSqlSchema = z.boolean().optional().describe("为 true 时附带去重后的迁移 SQL");

export interface ToolContent {
  type: "text";
  text: string;
}

/**
 * Structurally compatible with the SDK's CallToolResult, which carries an index
 * signature; a plain interface would not satisfy it.
 */
export type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
};

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function loadSchemaInput(input: string | undefined): {
  schema?: Schema;
  error?: string;
} {
  if (!input) return {};
  const text = existsSync(input) ? safeRead(input) : input;
  if (!text) return { error: `无法读取 schema：${input}` };
  try {
    const parsed = validateSchema(JSON.parse(text));
    if (parsed.errors.length > 0) return { error: `schema 校验失败：${parsed.errors.join("; ")}` };
    return { schema: parsed.schema };
  } catch (err) {
    return { error: `schema 不是合法 JSON：${(err as Error).message}` };
  }
}

function ruleOptions(input: {
  minSeverity?: Severity;
  mysqlVersion?: string;
  prefixBytes?: number;
  deepOffset?: number;
}) {
  return {
    minSeverity: input.minSeverity ?? ("info" as Severity),
    mysqlVersion: Number.parseFloat(input.mysqlVersion ?? "8"),
    prefixBytes: input.prefixBytes ?? DEFAULT_RULE_OPTIONS.prefixBytes,
    deepOffsetThreshold: input.deepOffset ?? DEFAULT_RULE_OPTIONS.deepOffsetThreshold,
  };
}

export function toolResult(
  source: string,
  result: AnalysisResult,
  options: { emitSql?: boolean; top?: number } = {},
): ToolResult {
  const capped = options.top && options.top > 0 ? options.top : 50;
  const report = {
    ...buildJsonReport({ ...result, findings: result.findings.slice(0, capped) }, source, VERSION),
    truncated: Math.max(0, result.findings.length - capped),
  };

  const headline =
    result.findings.length === 0
      ? "没有发现可报告的索引问题。"
      : `发现 ${result.findings.length} 条建议：${result.findings
          .slice(0, 8)
          .map((f) => `${f.rule}(${f.severity})`)
          .join(", ")}${result.findings.length > 8 ? " …" : ""}`;

  const skipped =
    result.skipped.length > 0
      ? `未参与判定的规则：${result.skipped.map((s) => `${s.id}(${s.reason})`).join("; ")}`
      : "";

  const text = [
    headline,
    `${result.records} 个查询指纹`,
    ...(skipped ? [skipped] : []),
    ...(result.errors.map((e) => `规则异常：${e}`) ?? []),
    ...(options.emitSql ? ["", "── migration SQL ──", renderMigration(result, source, { lang: "en" })] : []),
    "",
    "── 结构化结果 ──",
    JSON.stringify(report, null, 2),
  ].join("\n");

  return { content: [{ type: "text", text }], structuredContent: report };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * "Nothing to report" and "nothing was understood" are different answers; only
 * the first may look like a clean bill of health.
 */
function analysableRecords(records: Parameters<typeof analyze>[0]) {
  return records.filter((record) => record.parsed.kind !== "unknown");
}

const NOTHING_ANALYSABLE =
  "没有解析出任何可分析的语句（支持 SELECT / INSERT / UPDATE / DELETE）。";

export interface AnalyzeSqlArgs {
  sql: string;
  schema?: string;
  minSeverity?: Severity;
  mysqlVersion?: string;
  prefixBytes?: number;
  emitSql?: boolean;
}

export function analyzeSqlTool(args: AnalyzeSqlArgs): ToolResult {
  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);

  const records = loadInput(args.sql, { inline: true }).records;
  const usable = analysableRecords(records);
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  return toolResult("inline-sql", analyze(usable, { schema, ...ruleOptions(args) }), {
    emitSql: args.emitSql,
  });
}

export interface AnalyzeSlowLogArgs {
  path?: string;
  content?: string;
  schema?: string;
  minSeverity?: Severity;
  mysqlVersion?: string;
  top?: number;
  emitSql?: boolean;
}

export function analyzeSlowLogTool(args: AnalyzeSlowLogArgs): ToolResult {
  if (!args.path && !args.content) return failure("需要 path 或 content 之一。");
  const text = args.content ?? safeRead(args.path!);
  if (!text) return failure(`读不到慢日志文件：${args.path}`);

  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);

  const source = args.path ?? "inline-slowlog";
  const parsed = parseSlowLog(text, source);
  const usable = analysableRecords(parsed.records);
  if (parsed.records.length === 0) {
    return failure(`没有从慢日志中解析出语句（忽略了 ${parsed.ignoredEvents} 个事件块）。`);
  }
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  return toolResult(source, analyze(usable, { schema, ...ruleOptions(args) }), {
    emitSql: args.emitSql,
    top: args.top,
  });
}

export interface AnalyzeMapperArgs {
  path?: string;
  xml?: string;
  schema?: string;
  minSeverity?: Severity;
  mysqlVersion?: string;
  top?: number;
  emitSql?: boolean;
}

export function analyzeMapperTool(args: AnalyzeMapperArgs): ToolResult {
  if (!args.path && !args.xml) return failure("需要 path 或 xml 之一。");
  const { schema, error } = loadSchemaInput(args.schema);
  if (error) return failure(error);

  let records;
  let source: string;
  let notes: AnalysisResult["notes"] = [];
  if (args.xml) {
    records = mapperStatementsToRecords(parseMapperText(args.xml, "inline-mapper.xml"));
    source = "inline-mapper.xml";
  } else {
    const loaded = loadInput(args.path!, { kind: "mapper" });
    records = loaded.records;
    source = args.path!;
    notes = loaded.notes;
  }
  if (records.length === 0) return failure("没有解析出任何 mapper 语句。");
  const usable = analysableRecords(records);
  if (usable.length === 0) return failure(NOTHING_ANALYSABLE);
  // An agent asking through MCP deserves the same caveats a human reads in the
  // terminal: a directory of runtime-built predicates must not come back as a
  // clean result just because the renderer is different.
  const result = { ...analyze(usable, { schema, ...ruleOptions(args) }), notes };
  return toolResult(source, result, {
    emitSql: args.emitSql,
    top: args.top,
  });
}

export interface ExplainRulesArgs {
  ruleId?: string;
}

export function explainRulesTool(args: ExplainRulesArgs): ToolResult {
  const wanted = args.ruleId
    ? ALL_RULES.filter((rule) => rule.id.toLowerCase() === args.ruleId!.toLowerCase())
    : ALL_RULES;

  if (wanted.length === 0) {
    return failure(`未知规则 ${args.ruleId}；可选：${ruleCatalogue().map((c) => c.id).join(", ")}`);
  }

  const text = wanted
    .map((rule) => {
      const deps = [
        rule.needsSchema ? "需要 schema.json" : null,
        rule.needsMetrics ? "需要慢日志指标" : null,
      ].filter(Boolean);
      return [
        `${rule.id} ${rule.title}`,
        `  输入依赖：${deps.length ? deps.join(" + ") : "无，任何输入形态都可判定"}`,
      ].join("\n");
    })
    .join("\n\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      reportVersion: REPORT_VERSION,
      rules: ruleCatalogue(),
    },
  };
}
