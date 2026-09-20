import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Command } from "commander";
import pc from "picocolors";

import type { ReportLang, Severity } from "./core/types.js";
import { resolveLang } from "./core/types.js";
import type { InputKind } from "./core/input.js";
import { loadInput } from "./core/input.js";
import { EXIT_ERROR, runPipeline, exitCodeFor } from "./core/pipeline.js";
import { loadSchema } from "./schema/loader.js";
import { renderTerminal } from "./report/terminal.js";
import { buildJsonReport, renderJson } from "./report/json.js";
import { renderGithub } from "./report/github.js";
import { renderMigration } from "./report/migration.js";
import { mockProvider } from "./llm/mock.js";
import type { LlmProvider } from "./llm/provider.js";
import { configFromEnv, createOpenAiCompatProvider } from "./llm/openaiCompat.js";
import { ALL_RULES, ruleCatalogue } from "./rules/registry.js";

const VERSION = "0.1.0";
const SEVERITIES: Severity[] = ["error", "warn", "info"];
const EXIT_HELP = "\n退出码：0 无阻塞问题 · 1 达到 --fail-on 的发现 · 2 运行错误";

interface GlobalFlags {
  format: "table" | "json" | "github";
  schema?: string;
  llm?: boolean;
  emitSql?: string;
  top: string;
  minSeverity: string;
  failOn: string;
  mysqlVersion: string;
  prefixBytes: string;
  deepOffset: string;
  rules?: string;
  lang?: ReportLang;
}

function fail(message: string): never {
  process.stderr.write(`${pc.red("错误")} ${message}\n`);
  process.exit(EXIT_ERROR);
}

function severity(value: string, flag: string): Severity {
  const lowered = value.toLowerCase() as Severity;
  if (!SEVERITIES.includes(lowered)) fail(`--${flag} 只接受 error | warn | info，收到 "${value}"`);
  return lowered;
}

function intFlag(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`--${flag} 需要正整数，收到 "${value}"`);
  return parsed;
}

function addAnalysisFlags(cmd: Command): Command {
  cmd.enablePositionalOptions();
  return cmd
    .option("--format <fmt>", "table | json | github", "table")
    .option("--schema <path>", "schema.json; unlocks index-aware rules")
    .option("--llm", "polish the explanation text via an OpenAI-compatible endpoint")
    .option("--emit-sql <path>", "write deduplicated DDL to a migration file")
    .option("--top <n>", "maximum findings to print", "50")
    .option("--min-severity <s>", "drop quieter findings", "info")
    .option("--fail-on <s>", "exit 1 only at or above this severity", "error")
    .option("--mysql-version <v>", "5.7 | 8.0", "8.0")
    .option("--prefix-bytes <n>", "index key budget before recommending a prefix", "3072")
    .option("--deep-offset <n>", "LIMIT offset considered deep", "10000")
    .option("--rules <ids>", "comma-separated allow-list, e.g. SIA001,SIA004")
    .option("--lang <lang>", "auto | zh | en (terminal and GitHub annotations)", "auto");
}

/** Shared body for every analysis entry point. */
async function emit(source: string, flags: GlobalFlags, label: string, load: { kind?: InputKind; inline?: boolean } = {}): Promise<never> {
  if (!load.inline && !existsSync(source)) fail(`找不到输入：${source}`);

  let schema;
  if (flags.schema) {
    const loaded = loadSchema(flags.schema);
    if (loaded.errors.length > 0) {
      for (const err of loaded.errors) process.stderr.write(`${pc.red("schema 校验失败")} ${err}\n`);
      process.exit(EXIT_ERROR);
    }
    schema = loaded.schema;
  }

  let llm: LlmProvider | undefined;
  if (flags.llm) {
    const config = configFromEnv();
    if (!config) {
      process.stderr.write(`${pc.yellow("提示")} 未设置 SIA_LLM_BASE_URL，--llm 回退到离线 mock。\n`);
      llm = mockProvider;
    } else {
      llm = createOpenAiCompatProvider(config);
    }
  }

  const enabledRules = flags.rules
    ? ALL_RULES.filter((rule) =>
        flags
          .rules!.split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean)
          .includes(rule.id.toLowerCase()),
      )
    : undefined;

  if (flags.rules && enabledRules?.length === 0) fail(`--rules 没有匹配到任何规则：${flags.rules}`);

  const { result } = await runPipeline(source, {
    schema,
    llm,
    rules: enabledRules,
    minSeverity: severity(flags.minSeverity, "min-severity"),
    mysqlVersion: Number.parseFloat(flags.mysqlVersion),
    prefixBytes: intFlag(flags.prefixBytes, "prefix-bytes"),
    deepOffsetThreshold: intFlag(flags.deepOffset, "deep-offset"),
    loadKind: load.kind,
    loadInline: load.inline,
  });

  const top = intFlag(flags.top, "top");
  const lang = resolveLang((flags.lang ?? "auto") as ReportLang);
  switch (flags.format) {
    case "json":
      process.stdout.write(renderJson(buildJsonReport(result, label, VERSION)));
      break;
    case "github":
      process.stdout.write(renderGithub(result, lang));
      break;
    case "table":
      process.stdout.write(`${renderTerminal(result, { top, lang })}\n`);
      break;
    default:
      fail(`--format 只接受 table | json | github，收到 "${flags.format}"`);
  }

  if (flags.emitSql) {
    const target = resolve(flags.emitSql);
    writeFileSync(target, renderMigration(result, label, { lang }), "utf8");
    process.stderr.write(`${pc.green("✓")} 迁移文件已写入 ${target}\n`);
  }

  process.exit(exitCodeFor(result, severity(flags.failOn, "fail-on")));
}

const program = new Command();

// The root command takes a positional path *and* shares option names with its
// subcommands. Without positional options, `sia mapper x --format json` would
// hand --format to the root and the subcommand would silently use its default.
program.enablePositionalOptions();
program.showHelpAfterError(true);

addAnalysisFlags(
  program
    .name("sia")
    .description("sql-index-advisor — offline index advisor for MySQL / MyBatis")
    .version(VERSION)
    .argument("[input]", "slow query log / .sql file / mapper XML file or directory")
    .addHelpText(
      "after",
      `
示例：
  sia examples/slow.log --schema examples/schema.json
  sia query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20"
  sia mapper src/main/resources/mapper --emit-sql migrations.sql --format github
${EXIT_HELP}`,
    ),
).action(async (input: string | undefined, flags: GlobalFlags) => {
  if (!input) {
    program.outputHelp();
    process.exit(EXIT_ERROR);
  }
  await emit(input, flags, input);
});

addAnalysisFlags(
  program
    .command("query")
    .description("analyse inline SQL (one statement, or several separated by ;)")
    .argument("<sql...>", "SQL text")
    .addHelpText("after", EXIT_HELP),
).action(async (sqlParts: string[], flags: GlobalFlags) => {
  await emit(sqlParts.join(" "), flags, "inline-sql", { inline: true });
});

addAnalysisFlags(
  program
    .command("mapper")
    .description("scan MyBatis mapper XML files or a directory")
    .argument("<path>", "a .xml file or a directory")
    .addHelpText("after", EXIT_HELP),
).action(async (path: string, flags: GlobalFlags) => {
  await emit(path, flags, path, { kind: "mapper" });
});

program
  .command("list")
  .description("show what the parsers found, without running any rule")
  .argument("<input>", "slow query log / .sql / mapper path")
  .option("--format <fmt>", "table | json", "table")
  .action((input: string, flags: { format: string }) => {
    if (!existsSync(input)) emitListInline(input, flags);
    else printList(loadInput(input), flags, input);
  });

function emitListInline(sql: string, flags: { format: string }): void {
  printList(loadInput(sql, { inline: true }), flags, "inline-sql");
}

function printList(
  loaded: ReturnType<typeof loadInput>,
  flags: { format: string },
  label: string,
): void {
  const rows = loaded.records.map((record) => ({
    line: record.source?.line,
    file: record.source?.file,
    id: record.statementId,
    kind: record.parsed.kind,
    tables: record.parsed.tables.map((t) => t.name),
    predicates: record.parsed.columns.length,
    orderBy: record.parsed.orderBy.map((c) => `${c.raw}${c.desc ? " desc" : ""}`),
    limit: record.parsed.limit?.raw,
    occurrences: record.occurrences,
    fingerprint: record.fingerprint,
    notes: record.parsed.notes,
  }));

  if (flags.format === "json") {
    process.stdout.write(`${JSON.stringify({ source: label, count: rows.length, rows }, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      `${pc.dim(String(row.line ?? "-").padStart(4))}  ${row.kind.padEnd(6)} ${(row.tables.join(",") || "-").padEnd(18)} ${pc.dim(`p=${row.predicates}`)} ${row.fingerprint.slice(0, 66)}\n`,
    );
    for (const note of row.notes) process.stdout.write(`       ${pc.yellow("!")} ${note}\n`);
  }
  process.stdout.write(`\n${pc.bold(String(rows.length))} 个指纹\n`);
  for (const note of loaded.notes) process.stdout.write(`${pc.yellow("!")} ${note}\n`);
}

program
  .command("mcp")
  .description("start the MCP server on stdio (for Claude / Qoder / Cursor)")
  .action(async () => {
    const { main } = await import("./mcp/index.js");
    await main();
    // Keep the process alive for the lifetime of the stdio transport.
    await new Promise<void>((resolvePromise) => {
      process.stdin.once("end", () => resolvePromise());
    });
  });

program
  .command("rules")
  .description("print the rule catalogue as JSON")
  .action(() => {
    process.stdout.write(`${JSON.stringify(ruleCatalogue(), null, 2)}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${pc.red("运行错误")} ${(err as Error).message ?? String(err)}\n`);
  process.exit(EXIT_ERROR);
});
