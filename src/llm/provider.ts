import type { AnalysisResult, AnalyzeOptions } from "../rules/engine.js";
import type { Finding } from "../core/types.js";
import { ruleById } from "../rules/registry.js";
import { mockProvider } from "./mock.js";

/**
 * The LLM is an optional explanation layer, never a decision maker.
 *
 * Structural invariant: enabling `--llm` must not add, drop or re-rank a
 * finding. `tests/llm.test.ts` locks this, because the product's whole claim is
 * that conclusions are reproducible without a model in the loop.
 */
export interface LlmProvider {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

export interface PolishTarget {
  finding: Finding;
}

export function buildPrompt(finding: Finding): string {
  const title = ruleById(finding.rule)?.title ?? finding.rule;
  return [
    `你是 MySQL DBA。针对下面这条索引体检结论，用中文补充 2 句话：执行前要先确认什么、以及误用这条建议的代价。`,
    `不要改动结论本身，不要建议删除数据或 DROP 语句，不要输出免责声明。`,
    `规则：${finding.rule} ${title}`,
    `证据 SQL：${finding.sql}`,
    `已有结论：${finding.message}`,
    ...(finding.suggestedDDL.length ? [`建议 DDL：${finding.suggestedDDL.join(" ")}`] : []),
    ...(finding.rewrite ? [`改写 SQL：${finding.rewrite}`] : []),
  ].join("\n");
}

export interface PolishResult {
  findings: Finding[];
  provider: string;
  failures: number;
}

/**
 * Attach `llmNote` to each finding. Providers that fail fall back to the mock
 * text rather than aborting the run — a flaky endpoint must not break a CI gate.
 */
export async function polish(
  result: AnalysisResult,
  provider: LlmProvider = mockProvider,
  limit = 10,
): Promise<PolishResult> {
  let failures = 0;
  const findings: Finding[] = [];

  for (const [index, finding] of result.findings.entries()) {
    if (index >= limit) {
      findings.push(finding);
      continue;
    }
    try {
      const note = await provider.complete(buildPrompt(finding));
      const trimmed = note.trim();
      findings.push(trimmed ? { ...finding, llmNote: trimmed } : finding);
    } catch {
      failures += 1;
      const fallback = await mockProvider.complete(buildPrompt(finding));
      findings.push({ ...finding, llmNote: fallback });
    }
  }

  return { findings, provider: provider.name, failures };
}

export type { AnalyzeOptions };
