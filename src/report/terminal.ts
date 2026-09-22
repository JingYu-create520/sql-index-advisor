import pc from "picocolors";

import type { AnalysisResult } from "../rules/engine.js";
import { skippedCover } from "../rules/engine.js";
import type { Finding, Severity } from "../core/types.js";
import { evidence } from "../parsers/fingerprint.js";
import { workspaceRelative } from "./github.js";

const WIDTH = 96;

export interface TerminalOptions {
  top?: number;
  showEvidence?: boolean;
  /** Body text language. Data (JSON) always carries both. */
  lang?: "zh" | "en";
}

const SEVERITY_STYLE: Record<Severity, (text: string) => string> = {
  error: pc.red,
  warn: pc.yellow,
  info: pc.cyan,
};

const LABELS = {
  zh: {
    evidence: "证据",
    rewrite: "改写",
    ddl: "DDL",
    message: "说明",
    none: "✓ 没有发现可报告的索引问题",
    noneQuiet: "没有得出可报告的结论，原因见下方说明",
    advice: "建议",
    fingerprints: "个查询指纹",
    skipped: "未参与判定",
    marker: "!",
    footnote: "建议需人工评审后再执行；本工具永不自动改动数据库。",
    more: "… 另有",
    moreTail: "条，使用 --top 查看全部",
  },
  en: {
    evidence: "evidence",
    rewrite: "rewrite",
    ddl: "DDL",
    message: "why",
    none: "✓ nothing to report",
    noneQuiet: "nothing could be concluded, see the notes below",
    advice: "suggestions",
    fingerprints: "query fingerprints covered",
    skipped: "not evaluated:",
    marker: "!",
    footnote: "Review every suggestion before running it; this tool never touches the database.",
    more: "… ",
    moreTail: " more, raise --top to see them",
  },
} as const;

export function renderTerminal(result: AnalysisResult, options: TerminalOptions = {}): string {
  const lang = options.lang ?? "zh";
  const t = LABELS[lang];
  const lines: string[] = [];
  const counts = countBySeverity(result.findings);

  if (result.findings.length === 0) {
    // A checkmark is a claim. If the loader had something to complain about (no
    // mappers found, predicates that only exist at runtime), the run is not
    // clean, it is uninformative, and the difference has to show.
    lines.push(result.notes.length === 0 ? pc.green(t.none) : pc.yellow(`! ${t.noneQuiet}`));
  } else {
    lines.push(
      [
        pc.bold(`${result.findings.length} ${t.advice}`),
        pc.red(`${counts.error} error`),
        pc.yellow(`${counts.warn} warn`),
        pc.cyan(`${counts.info} info`),
        pc.dim(`· ${result.records} ${t.fingerprints}`),
      ].join("  "),
    );
  }

  const top = options.top ?? result.findings.length;
  result.findings.slice(0, top).forEach((finding, index) => {
    lines.push("");
    lines.push(...renderFinding(finding, index + 1, lang));
  });
  if (result.findings.length > top) {
    lines.push(
      pc.dim(
        lang === "en"
          ? `${t.more}${result.findings.length - top}${t.moreTail}`
          : `${t.more}${result.findings.length - top}${t.moreTail}`,
      ),
    );
  }

  const footer = renderFooter(result, lang);
  if (footer.length > 0) {
    lines.push("");
    lines.push(...footer);
  }
  return lines.join("\n");
}

function renderFinding(finding: Finding, ordinal: number, lang: "zh" | "en"): string[] {
  const t = LABELS[lang];
  const style = SEVERITY_STYLE[finding.severity];
  const where = [
    finding.table,
    finding.source
      ? `${workspaceRelative(finding.source.file)}:${finding.source.line}`
      : undefined,
    finding.queryTime !== undefined ? `${finding.queryTime.toFixed(3)}s` : undefined,
    finding.rowsExamined !== undefined ? `${finding.rowsExamined.toLocaleString("en-US")} rows` : undefined,
    (finding.occurrences ?? 1) > 1 ? `×${finding.occurrences}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = lang === "en" ? finding.messageEn : finding.message;

  const out: string[] = [
    `${pc.dim(String(ordinal).padStart(2))} ${style(`[${finding.severity}]`)} ${pc.bold(finding.rule)} ${findingTitle(finding, lang)} ${pc.dim(where)}`,
  ];

  out.push(`   ${pc.dim(t.evidence)} ${evidence(finding.sql, WIDTH - 8)}`);

  if (finding.rewrite) out.push(...wrap(finding.rewrite, 3, pc.green(t.rewrite)));
  for (const ddl of finding.suggestedDDL) out.push(...wrap(ddl, 3, pc.magenta(t.ddl)));
  out.push(...wrap(body, 3, pc.dim(t.message)));
  if (finding.llmNote) out.push(...wrap(finding.llmNote, 3, pc.blue("AI")));
  return out;
}

/** The rule id is stable; the human title comes from the rule catalogue. */
let titles = new Map<string, { title: string; titleEn: string }>();

export function registerTitles(
  pairs: Array<{ id: string; title: string; titleEn?: string }>,
): void {
  titles = new Map(
    pairs.map((p) => [p.id, { title: p.title, titleEn: p.titleEn ?? p.title }]),
  );
}

function findingTitle(finding: Finding, lang: "zh" | "en"): string {
  const entry = titles.get(finding.rule);
  if (!entry) return "";
  return lang === "en" ? entry.titleEn : entry.title;
}

function wrap(text: string, indent: number, label?: string): string[] {
  const pad = " ".repeat(indent + (label ? 5 : 0));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > WIDTH - indent) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.map((line, index) =>
    index === 0 && label ? `   ${label} ${line.padEnd(0)}` : `${pad}${line}`,
  );
}

function renderFooter(result: AnalysisResult, lang: "zh" | "en"): string[] {
  const t = LABELS[lang];
  const out: string[] = [];
  for (const note of result.notes) {
    out.push(`${pc.yellow("!")} ${lang === "en" ? note.noteEn : note.note}`);
  }
  if (result.skipped.length > 0) {
    const groups = new Map<string, string[]>();
    for (const skipped of result.skipped) {
      const reason = lang === "en" ? skipped.reasonEn : skipped.reason;
      // A rule skipped on part of the run did run on the rest, and saying only
      // "not evaluated" above a suggestion the same rule just produced reads as if
      // the suggestion itself were unverified.
      const cover = skippedCover(skipped, result.records, lang, reason);
      const list = groups.get(cover) ?? [];
      list.push(skipped.id);
      groups.set(cover, list);
    }
    for (const [reason, ids] of groups) {
      out.push(`${pc.yellow(t.skipped)} ${ids.join(", ")} · ${reason}`);
    }
  }
  for (const error of result.errors) {
    out.push(`${pc.red("x")} ${error}`);
  }
  if (result.findings.length > 0) {
    out.push(pc.dim(t.footnote));
  }
  return out;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
