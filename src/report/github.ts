import { relative } from "node:path";

import type { AnalysisResult } from "../rules/engine.js";
import type { Finding, Severity } from "../core/types.js";
import { ruleById } from "../rules/registry.js";

/**
 * GitHub resolves annotation `file=` against the runner workspace, so an
 * absolute path would silently produce a comment that links to nothing.
 */
export function workspaceRelative(file: string): string {
  const rel = relative(process.cwd(), file).replace(/\\/g, "/");
  // Outside the workspace (or the same path) -> keep the original.
  if (!rel || rel.startsWith("../") || rel === "." || rel.length >= file.length) return file;
  return rel;
}

/**
 * GitHub Actions workflow-command output, so the Action needs no extra parser:
 * the annotations show up as line comments on the changed file.
 *
 * `file`/`line`/`title` are workflow *properties* and message is *data*; each has
 * its own escaping rules (% , : , , and newlines).
 */

const COMMAND_LEVEL: Record<Severity, "error" | "warning" | "notice"> = {
  error: "error",
  warn: "warning",
  info: "notice",
};

export function renderGithub(result: AnalysisResult, lang: "zh" | "en" = "en"): string {
  const lines: string[] = [];
  for (const finding of result.findings) {
    lines.push(annotation(finding, lang));
  }
  for (const error of result.errors) {
    lines.push(`::notice title=sql-index-advisor::${escapeData(`rule error: ${error}`)}`);
  }
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

export function annotation(finding: Finding, lang: "zh" | "en" = "en"): string {
  const level = COMMAND_LEVEL[finding.severity];
  const rule = ruleById(finding.rule);
  const title = lang === "en" ? (rule?.titleEn ?? finding.rule) : (rule?.title ?? "");
  const body = lang === "en" ? finding.messageEn : finding.message;
  const properties = [
    finding.source ? `file=${escapeProperty(workspaceRelative(finding.source.file))}` : undefined,
    finding.source ? `line=${finding.source.line}` : undefined,
    `title=${escapeProperty(`${finding.rule} ${title}`.trim())}`,
  ]
    .filter(Boolean)
    .join(",");

  const text = [
    body,
    finding.suggestedDDL.length ? `DDL: ${finding.suggestedDDL.join(" ")}` : undefined,
    finding.rewrite ? `rewrite: ${finding.rewrite}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");

  return `::${level} ${properties}::${escapeData(text)}`;
}

function escapeProperty(text: string): string {
  return text
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
