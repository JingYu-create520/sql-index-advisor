import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeMapperTool,
  analyzeSlowLogTool,
  analyzeSqlTool,
  explainRulesTool,
  loadSchemaInput,
} from "../src/mcp/tools.js";

const BANNER = "── 结构化结果 ──";

describe("MCP tool handlers", () => {
  it("analyze_sql returns findings plus a parseable structured payload", () => {
    const result = analyzeSqlTool({
      sql: "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("SIA004");
    expect(text).toContain(BANNER);

    const report = JSON.parse(text.split(BANNER)[1]!.trim()) as {
      findings: Array<{ rule: string }>;
      rules: unknown[];
    };
    expect(report.rules).toHaveLength(7);
    expect(report.findings.some((f) => f.rule === "SIA004")).toBe(true);
  });

  it("analyze_mapper reaches a table that only appears inside a subquery", () => {
    const result = analyzeMapperTool({
      xml: `<mapper namespace="demo">
        <select id="list" resultType="int">
          select id from users u where u.level = 1
            and exists (select 1 from user_address a where a.user_id = u.id and a.city = #{city})
        </select>
      </mapper>`,
    });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(result.content[0]!.text.split(BANNER)[1]!.trim()) as {
      findings: Array<{ table?: string; indexColumns?: string[] }>;
    };
    const inner = report.findings.find((f) => f.table === "user_address");
    expect(inner?.indexColumns).toEqual(["user_id", "city"]);
  });

  it("accepts an inline schema document, not only a path", () => {
    const inline = JSON.stringify({
      tables: [{ name: "t", columns: [{ name: "a", type: "int" }], indexes: [] }],
    });
    const { schema, error } = loadSchemaInput(inline);
    expect(error).toBeUndefined();
    expect(schema?.tables[0]?.name).toBe("t");
  });

  it("reports schema problems instead of guessing", () => {
    expect(analyzeSqlTool({ sql: "SELECT 1 FROM t", schema: "{not json" }).isError).toBe(true);
    expect(analyzeSqlTool({ sql: "SELECT 1 FROM t", schema: '{"tables":[]}' }).isError).toBe(true);
  });

  it("fails politely on empty or unusable input", () => {
    expect(analyzeSlowLogTool({}).isError).toBe(true);
    expect(analyzeMapperTool({}).isError).toBe(true);
    expect(analyzeSlowLogTool({ content: "nothing here" }).isError).toBe(true);
    expect(analyzeSqlTool({ sql: "-- just a comment" }).isError).toBe(true);
  });

  it("reads the example assets from disk", () => {
    const slow = analyzeSlowLogTool({ path: "examples/slow.log", schema: "examples/schema.json" });
    expect(slow.isError).toBeFalsy();
    expect(slow.content[0]!.text).toContain("个查询指纹");

    const mapper = analyzeMapperTool({ path: "examples/mapper", top: 3 });
    expect(mapper.isError).toBeFalsy();
    expect(mapper.content[0]!.text).toContain("SIA");
  });

  it("emitSql appends deduplicated migration text", () => {
    const text = analyzeSqlTool({
      sql: "SELECT id FROM order_item WHERE sku_id = 1; SELECT id FROM order_item WHERE sku_id = 2;",
      emitSql: true,
    }).content[0]!.text;
    expect(text).toContain("migration SQL");
    // Count only inside the migration block; the JSON payload repeats the DDL.
    const migration = text.slice(
      text.indexOf("── migration SQL ──"),
      text.indexOf("── 结构化结果 ──"),
    );
    expect(migration.match(/ALTER TABLE `order_item`/g)).toHaveLength(1);
  });

  it("explain_rules covers all seven and rejects unknown ids", () => {
    const all = explainRulesTool({});
    expect(all.content[0]!.text).toContain("SIA007");
    expect(all.content[0]!.text).toContain("需要 schema.json");
    expect(explainRulesTool({ ruleId: "SIA042" }).isError).toBe(true);
  });

  it("top actually caps the payload and reports the remainder", () => {
    const text = analyzeSlowLogTool({ path: "examples/slow.log", top: 1 }).content[0]!.text;
    const report = JSON.parse(text.split(BANNER)[1]!.trim()) as {
      findings: unknown[];
      truncated: number;
    };
    expect(report.findings).toHaveLength(1);
    expect(report.truncated).toBeGreaterThan(0);
  });
});

/**
 * End-to-end over real stdio JSON-RPC against the built bundle. This is the M4
 * acceptance criterion: a client must be able to handshake and call a tool.
 */
describe("MCP stdio handshake", () => {
  const entry = resolve("dist/mcp.js");
  const built = existsSync(entry);

  let child: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<number, (value: unknown) => void>();
  let buffer = "";

  afterAll(() => {
    // The child may already have exited; Windows reports EPERM rather than
    // ESRCH in that case, so teardown has to be idempotent.
    try {
      child?.stdin.end();
      if (child?.exitCode === null) child.kill();
    } catch {
      /* already gone */
    }
  });

  async function start(): Promise<ChildProcessWithoutNullStreams> {
    const proc = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: number };
            if (typeof message.id === "number") {
              pending.get(message.id)?.(message);
              pending.delete(message.id);
            }
          } catch {
            /* ignore non-JSON stdout noise */
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    child = proc;
    return proc;
  }

  function notify(proc: ChildProcessWithoutNullStreams, method: string): void {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  function request(
    proc: ChildProcessWithoutNullStreams,
    id: number,
    method: string,
    params: Record<string, unknown>,
  ) {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise<Record<string, unknown>>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise({ timeout: true }), 15_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolvePromise(value as Record<string, unknown>);
      });
    });
  }

  // Genuinely skip when the bundle is absent (CI runs tests before build unless
  // the workflow builds first) — a renamed test would still run and time out.
  it.skipIf(!built)(
    "initialises, lists tools and calls analyze_sql",
    async () => {
    const proc = await start();

    const init = await request(proc, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    if ((init as { timeout?: boolean }).timeout) {
      throw new Error(`no initialize response within 15s; stdout buffer was: ${buffer.slice(0, 200)}`);
    }
    const serverInfo = (init as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo;
    expect(serverInfo?.name).toBe("sql-index-advisor");

    notify(proc, "notifications/initialized");

    const tools = await request(proc, 2, "tools/list", {});
    const names = (
      (tools as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []
    ).map((t) => t.name);
    expect(names.sort()).toEqual([
      "analyze_mapper",
      "analyze_slow_log",
      "analyze_sql",
      "explain_rules",
    ]);

    const call = await request(proc, 3, "tools/call", {
      name: "analyze_sql",
      arguments: { sql: "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17'" },
    });
    const result = (call as { result?: { content?: Array<{ text: string }> } }).result;
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain("SIA004");
    // No --schema was passed, so schema-dependent rules must say why they stayed
    // silent — and the functional-index DDL must NOT be offered.
    expect(text).toContain("未参与判定的规则");
    expect(text).not.toContain("ALTER TABLE");
    expect(JSON.parse(text.split(BANNER)[1]!.trim()).findings[0].rule).toBe("SIA004");
    },
    30_000,
  );
});
