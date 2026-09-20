/**
 * stdio MCP server adapter.
 *
 * Written against the installed SDK's real surface:
 *   new McpServer(serverInfo, options) -> registerTool(name, config, handler)
 *   -> connect(new StdioServerTransport())
 *
 * Two invariants: stdout belongs to JSON-RPC (all logs go to stderr), and a tool
 * failure returns an `isError` result rather than throwing into the transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  analyzeMapperTool,
  analyzeSlowLogTool,
  analyzeSqlTool,
  explainRulesTool,
  emitSqlSchema,
  INSTRUCTIONS,
  schemaInput,
  severitySchema,
  VERSION,
} from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "sql-index-advisor", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "analyze_sql",
    {
      title: "分析单条 SQL",
      description:
        "对一条（或多条以 ; 分隔的）SQL 做索引体检，返回带规则 ID、证据 SQL、建议 DDL 与改写语句的结构化结果。",
      inputSchema: {
        sql: z.string().min(1).describe("MySQL 语句，可用 ; 分隔多条"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z.enum(["5.7", "8.0"]).optional(),
        prefixBytes: z.number().int().positive().optional(),
        emitSql: emitSqlSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => analyzeSqlTool(args),
  );

  server.registerTool(
    "analyze_slow_log",
    {
      title: "分析慢查询日志",
      description:
        "解析 MySQL 慢日志，按 SQL 指纹聚合（次数 / 总耗时 / 最大扫描行数）后按收益降序给出索引建议。path 与 content 二选一。",
      inputSchema: {
        path: z.string().optional().describe("本机慢日志文件路径"),
        content: z.string().optional().describe("慢日志文本内容"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z.enum(["5.7", "8.0"]).optional(),
        top: z.number().int().positive().optional().describe("最多返回多少条，默认 50"),
        emitSql: emitSqlSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => analyzeSlowLogTool(args),
  );

  server.registerTool(
    "analyze_mapper",
    {
      title: "分析 MyBatis Mapper",
      description:
        "解析 mapper XML（含 <if>/<where>/<choose>/<foreach>/${}），动态分支展开为多变体后逐条体检；结果带文件与行号，可直接用于 PR 行级评论。path 与 xml 二选一。",
      inputSchema: {
        path: z.string().optional().describe("mapper XML 文件或目录"),
        xml: z.string().optional().describe("<mapper> 文档内容"),
        schema: schemaInput,
        minSeverity: severitySchema,
        mysqlVersion: z.enum(["5.7", "8.0"]).optional(),
        top: z.number().int().positive().optional(),
        emitSql: emitSqlSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => analyzeMapperTool(args),
  );

  server.registerTool(
    "explain_rules",
    {
      title: "查询规则说明",
      description: "返回 7 条规则的清单与输入依赖。给出建议前先引用这里的说明。",
      inputSchema: {
        ruleId: z.string().optional().describe("例如 SIA001，省略则返回全部"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (args) => explainRulesTool(args),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("sql-index-advisor MCP server ready (stdio)\n");
}

export * from "./tools.js";
