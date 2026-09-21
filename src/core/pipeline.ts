/**
 * One pipeline for every delivery form: load -> analyse -> (optional polish) ->
 * report. The CLI and the MCP server both call this, so they can never drift
 * apart in behaviour.
 */

import type { Severity } from "./types.js";
import { SEVERITY_ORDER } from "./types.js";
import { loadInput, type InputKind, type LoadedInput } from "./input.js";
import { analyze, type AnalysisResult, type AnalyzeOptions } from "../rules/engine.js";
import { ruleCatalogue } from "../rules/registry.js";
import { polish, type LlmProvider, type PolishResult } from "../llm/provider.js";
import { registerTitles } from "../report/terminal.js";

registerTitles(ruleCatalogue());

export interface PipelineOptions extends AnalyzeOptions {
  /** Providing a provider appends commentary; it cannot change findings. */
  llm?: LlmProvider;
  llmLimit?: number;
  /** Force mapper parsing for a path whose name lacks .xml. */
  loadKind?: InputKind;
  /** Treat the source string as SQL text rather than a path. */
  loadInline?: boolean;
}

export interface PipelineOutput {
  loaded: LoadedInput;
  result: AnalysisResult;
  polished?: PolishResult;
}

export async function runPipeline(
  source: string,
  options: PipelineOptions = {},
): Promise<PipelineOutput> {
  const { llm, llmLimit, loadKind, loadInline, ...analyzeOptions } = options;
  const loaded = loadInput(source, { kind: loadKind, inline: loadInline });
  const result = analyze(loaded.records, analyzeOptions);

  if (!llm) return { loaded, result };
  const polished = await polish(result, llm, llmLimit ?? 10);
  return { loaded, result: { ...result, findings: polished.findings }, polished };
}

/**
 * Exit codes (docs/DESIGN-NOTES.md D6). Adopting a lint tool should never turn a green
 * build red on day one, so only `--fail-on` severity blocks.
 */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export function exitCodeFor(result: AnalysisResult, failOn: Severity): number {
  const threshold = SEVERITY_ORDER[failOn];
  return result.findings.some((f) => SEVERITY_ORDER[f.severity] >= threshold)
    ? EXIT_FINDINGS
    : EXIT_OK;
}

export { ruleCatalogue };
