import { describe, expect, it } from "vitest";

import type { Finding } from "../src/core/types.js";
import { analyze } from "../src/rules/engine.js";
import { record, TEST_SCHEMA } from "./support.js";
import { renderTerminal, registerTitles } from "../src/report/terminal.js";
import { buildJsonReport, renderJson } from "../src/report/json.js";
import { annotation, renderGithub } from "../src/report/github.js";
import { renderMigration } from "../src/report/migration.js";
import { exitCodeFor, EXIT_FINDINGS, EXIT_OK } from "../src/core/pipeline.js";
import { ruleCatalogue } from "../src/rules/registry.js";

registerTitles(ruleCatalogue());

const SQL = "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17' AND user_id = 1";

const sample = () =>
  analyze([record(SQL, { queryTime: 2.5, rowsExamined: 400000 })], { schema: TEST_SCHEMA });

function synthetic(overrides: Partial<Finding> = {}): Finding {
  return {
    rule: "SIA001",
    severity: "warn",
    sql: "SELECT 1",
    fingerprint: "select 1",
    message: "说明文本",
    messageEn: "english summary",
    suggestedDDL: [],
    needsSchema: false,
    needsMetrics: false,
    ...overrides,
  };
}

const stripAnsi = (text: string): string =>
  text.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

describe("terminal report", () => {
  it("prints severity, evidence, rewrite and DDL per finding", () => {
    const text = stripAnsi(renderTerminal(sample()));
    expect(text).toContain("SIA004");
    expect(text).toContain("索引列上使用函数或运算");
    expect(text).toContain("证据");
    expect(text).toContain("DDL");
    expect(text).toContain("ALTER TABLE");
    expect(text).toContain("400,000 rows");
  });

  it("shows which rules could not run and why", () => {
    const text = stripAnsi(renderTerminal(analyze([record(SQL)])));
    expect(text).toContain("未参与判定");
    expect(text).toContain("--schema");
  });

  it("says so when nothing was found", () => {
    const text = stripAnsi(renderTerminal(analyze([])));
    expect(text).toContain("没有发现");
  });

  it("respects --top", () => {
    const result = sample();
    expect(result.findings.length).toBeGreaterThan(1);
    const text = stripAnsi(renderTerminal(result, { top: 1 }));
    expect(text).toContain("另有");
  });
});

describe("json report", () => {
  it("is stable, complete and parseable", () => {
    const report = buildJsonReport(sample(), "test.sql", "0.1.0");
    const parsed = JSON.parse(renderJson(report)) as ReturnType<typeof buildJsonReport>;
    expect(parsed.reportVersion).toBe(1);
    expect(parsed.toolVersion).toBe("0.1.0");
    expect(parsed.source).toBe("test.sql");
    expect(parsed.rules).toHaveLength(7);
    expect(parsed.summary.findings).toBe(parsed.findings.length);
    expect(parsed.summary.bySeverity.error + parsed.summary.bySeverity.warn).toBeGreaterThan(0);
    expect(parsed.options.mysqlVersion).toBe(8);
  });

  it("keeps skipped rules and errors visible to agents", () => {
    const report = buildJsonReport(analyze([record(SQL)]), "t");
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped[0]).toHaveProperty("reason");
  });
});

describe("github report", () => {
  it("emits workflow commands with file, line and title", () => {
    const line = annotation(
      synthetic({
        source: { file: "m/UserMapper.xml", line: 42 },
        suggestedDDL: ["ALTER TABLE `t` ADD INDEX `i` (`a`);"],
      }),
    );
    expect(line).toBe(
      "::warning file=m/UserMapper.xml,line=42,title=SIA001 Missing index candidate::english summary | DDL: ALTER TABLE `t` ADD INDEX `i` (`a`);",
    );
  });

  it("maps severities onto annotation levels", () => {
    expect(annotation(synthetic({ severity: "error" }))).toMatch(/^::error /);
    expect(annotation(synthetic({ severity: "info" }))).toMatch(/^::notice /);
  });

  it("escapes property and data separators", () => {
    const line = annotation(
      synthetic({
        source: { file: "a,b:c%d.xml", line: 1 },
        messageEn: "line1\nline2 50% ok",
      }),
    );
    // Property values escape % : , and newlines; the message body escapes % and newlines.
    expect(line).toContain("file=a%2Cb%3Ac%25d.xml");
    expect(line.split("::")[2]).toBe("line1%0Aline2 50%25 ok");
  });

  it("renders nothing when there are no findings", () => {
    expect(renderGithub(analyze([]))).toBe("");
  });

  it("rewrites workspace paths so annotations actually link", async () => {
    const { workspaceRelative } = await import("../src/report/github.js");
    expect(workspaceRelative(process.cwd() + "/src/cli.ts")).toBe("src/cli.ts");
    expect(workspaceRelative(process.cwd() + "\\src\\cli.ts")).toBe("src/cli.ts");
    // Anything outside the workspace stays untouched rather than becoming ../..
    expect(workspaceRelative("/var/log/mysql/slow.log")).toBe("/var/log/mysql/slow.log");
    const line = annotation(
      synthetic({ source: { file: `${process.cwd()}/m/UserMapper.xml`, line: 7 } }),
    );
    expect(line).toContain("file=m/UserMapper.xml");
  });
});

describe("migration report", () => {
  it("deduplicates the same DDL coming from different queries", () => {
    const result = analyze(
      [
        record("SELECT id FROM order_item WHERE sku_id = 1"),
        record("SELECT id FROM order_item WHERE sku_id = 2"),
      ],
      { schema: TEST_SCHEMA },
    );
    const sql = renderMigration(result, "two queries");
    expect(sql.match(/ALTER TABLE `order_item`/g)).toHaveLength(1);
    expect(sql).toContain("Generated by sql-index-advisor");
    expect(sql).toContain("-- 本文件只做两件事：加索引");
  });

  it("lists rewrite-only advice as comments", () => {
    // SIA006 emits no DDL at all, so it must show up as a comment section.
    const result = analyze(
      [record("SELECT o.* FROM orders o WHERE o.user_id = 1 ORDER BY o.id DESC LIMIT 100000, 20")],
      { schema: TEST_SCHEMA },
    );
    const sql = renderMigration(result, "slow.log");
    expect(sql).toContain("-- SIA006");
    expect(sql).toContain("需要改写 SQL 的建议");
  });

  it("emits only ADD INDEX as executable statements", () => {
    const result = analyze(
      [
        record(SQL),
        record("SELECT id FROM order_item WHERE sku_id = 1"),
        record("SELECT o.* FROM orders o WHERE o.user_id = 1 ORDER BY o.id LIMIT 100000, 20"),
      ],
      { schema: TEST_SCHEMA },
    );
    const executable = renderMigration(result, "x")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"));
    expect(executable.length).toBeGreaterThan(0);
    for (const statement of executable) {
      expect(statement).toMatch(/^ALTER TABLE .+ ADD (UNIQUE )?INDEX/);
      expect(statement).not.toMatch(/\bDROP\b/i);
    }
  });
});

describe("language selection", () => {
  it("renders the same findings in either language", () => {
    // This one yields SIA001, whose title differs per language.
    const result = analyze(
      [record("SELECT id FROM order_item WHERE sku_id = 1")],
      { schema: TEST_SCHEMA },
    );
    expect(result.findings.some((f) => f.rule === "SIA001")).toBe(true);

    const zh = stripAnsi(renderTerminal(result, { lang: "zh" }));
    const en = stripAnsi(renderTerminal(result, { lang: "en" }));

    expect(zh).toContain("缺失索引候选");
    expect(en).toContain("Missing index candidate");
    // Rule ids and DDL are language-independent: nothing is lost in translation.
    for (const finding of result.findings) {
      expect(zh).toContain(finding.rule);
      expect(en).toContain(finding.rule);
      for (const ddl of finding.suggestedDDL) {
        expect(zh).toContain(ddl);
        expect(en).toContain(ddl);
      }
    }
    expect(en).not.toContain("证据");
    expect(zh).not.toContain("evidence");
  });

  it("auto-detects from the environment and defaults to English", async () => {
    const { resolveLang } = await import("../src/core/types.js");
    expect(resolveLang("zh")).toBe("zh");
    expect(resolveLang("en")).toBe("en");
    const saved = process.env.LANG;
    try {
      process.env.LANG = "zh_CN.UTF-8";
      expect(resolveLang("auto")).toBe("zh");
      process.env.LANG = "en_US.UTF-8";
      expect(resolveLang("auto")).toBe("en");
      delete process.env.LANG;
      delete process.env.LC_ALL;
      expect(resolveLang("auto")).toBe("en");
    } finally {
      process.env.LANG = saved;
    }
  });
});

describe("exit codes (PLAN R6)", () => {
  const withSeverity = (severity: Finding["severity"]) =>
    analyze([]) && {
      ...analyze([]),
      findings: [synthetic({ severity })],
    };

  it("returns 0 when nothing reaches --fail-on", () => {
    expect(exitCodeFor(withSeverity("warn"), "error")).toBe(EXIT_OK);
    expect(exitCodeFor(analyze([]), "error")).toBe(EXIT_OK);
  });

  it("returns 1 once the threshold is reached", () => {
    expect(exitCodeFor(withSeverity("error"), "error")).toBe(EXIT_FINDINGS);
    expect(exitCodeFor(withSeverity("warn"), "warn")).toBe(EXIT_FINDINGS);
  });
});
