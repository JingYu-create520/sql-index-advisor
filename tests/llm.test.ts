import { afterEach, describe, expect, it, vi } from "vitest";

import { analyze } from "../src/rules/engine.js";
import { polish, buildPrompt, type LlmProvider } from "../src/llm/provider.js";
import { mockProvider } from "../src/llm/mock.js";
import { runPipeline } from "../src/core/pipeline.js";
import { configFromEnv, createOpenAiCompatProvider, LlmNotConfiguredError, providerFromEnv } from "../src/llm/openaiCompat.js";
import { record, TEST_SCHEMA } from "./support.js";

const SQLS = [
  "SELECT id FROM orders WHERE DATE(create_time) = '2026-09-17' AND user_id = 1",
  "SELECT id FROM order_item WHERE sku_id = 7",
  "SELECT o.* FROM orders o WHERE o.shop_id = 3 ORDER BY o.id LIMIT 100000, 20",
];

function run() {
  return analyze(
    SQLS.map((sql) => record(sql, { queryTime: 3, rowsExamined: 500000 })),
    { schema: TEST_SCHEMA },
  );
}

/** The structural identity of a conclusion: everything except the prose. */
function structure(findings: ReturnType<typeof run>["findings"]) {
  return findings.map((f) => ({
    rule: f.rule,
    fingerprint: f.fingerprint,
    severity: f.severity,
    ddl: [...f.suggestedDDL].sort(),
    rewrite: f.rewrite ?? null,
    table: f.table ?? null,
  }));
}

const echoing: LlmProvider = {
  name: "echo",
  async complete(prompt) {
    return `补充说明：${prompt.slice(0, 12)}…`;
  },
};

describe("LLM layer cannot change conclusions (DESIGN-NOTES D10)", () => {
  it("polish only appends llmNote", async () => {
    const result = run();
    const polished = await polish(result, echoing, 10);

    expect(polished.findings.length).toBe(result.findings.length);
    polished.findings.forEach((finding, index) => {
      expect(finding.llmNote).toBeTruthy();
      // Every structural field is untouched.
      expect({ ...finding, llmNote: undefined }).toEqual(result.findings[index]);
    });
    expect(polished.provider).toBe("echo");
  });

  it("the finding set is identical with and without --llm", async () => {
    const without = structure(run().findings);
    const withLlm = structure((await polish(run(), mockProvider, 10)).findings);
    expect(withLlm).toEqual(without);
  });

  it("the pipeline keeps ordering and counts when a provider is attached", async () => {
    const plain = await runPipeline(SQLS[0]!, { schema: TEST_SCHEMA, loadInline: true });
    const llm = await runPipeline(SQLS[0]!, {
      schema: TEST_SCHEMA,
      loadInline: true,
      llm: mockProvider,
    });
    expect(llm.result.findings.map((f) => f.rule)).toEqual(plain.result.findings.map((f) => f.rule));
    expect(llm.polished?.provider).toBe("mock");
  });
});

describe("mock provider", () => {
  it("is deterministic, which is what offline reproducibility means", async () => {
    const finding = run().findings[0]!;
    const a = await mockProvider.complete(buildPrompt(finding));
    const b = await mockProvider.complete(buildPrompt(finding));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it("gives rule-specific advice rather than boilerplate", async () => {
    const byRule = new Map<string, string>();
    for (const finding of run().findings) {
      byRule.set(finding.rule, await mockProvider.complete(buildPrompt(finding)));
    }
    const texts = [...byRule.values()];
    expect(new Set(texts).size).toBe(texts.length);
    expect(byRule.get("SIA006")).toContain("游标");
  });

  it("the prompt carries the rule id so a real model gets context", () => {
    const prompt = buildPrompt(run().findings[0]!);
    expect(prompt).toMatch(/^你是 MySQL DBA/m);
    expect(prompt).toContain("规则：SIA00");
    expect(prompt).toContain("证据 SQL");
  });
});

describe("openaiCompat provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads configuration from the environment only", () => {
    expect(configFromEnv({})).toBeUndefined();
    expect(() => providerFromEnv({})).toThrow(LlmNotConfiguredError);

    const config = configFromEnv({
      SIA_LLM_BASE_URL: "https://gw.internal/v1/",
      SIA_LLM_API_KEY: "k",
      SIA_LLM_MODEL: "qwen-plus",
    });
    expect(config).toMatchObject({ baseUrl: "https://gw.internal/v1", apiKey: "k", model: "qwen-plus" });
    expect(providerFromEnv({ SIA_LLM_BASE_URL: "https://x/v1" }).name).toContain("gpt-4o-mini");
  });

  it("posts a chat completion and returns the assistant text", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://gw.internal/v1/chat/completions");
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret");
      expect(JSON.parse(String(init.body)).model).toBe("deepseek-chat");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "  先确认写入频率。  " } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiCompatProvider({
      baseUrl: "https://gw.internal/v1",
      apiKey: "secret",
      model: "deepseek-chat",
    });
    await expect(provider.complete("hi")).resolves.toBe("先确认写入频率。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-2xx response as an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503, statusText: "Unavailable" }));
    const provider = createOpenAiCompatProvider({ baseUrl: "https://x/v1", model: "m" });
    await expect(provider.complete("hi")).rejects.toThrow("503");
  });

  it("an endpoint failure degrades to mock text instead of breaking the run", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createOpenAiCompatProvider({ baseUrl: "https://x/v1", model: "m" });
    const result = run();
    const polished = await polish(result, provider, 10);

    expect(polished.failures).toBe(result.findings.length);
    expect(polished.findings.every((f) => !!f.llmNote)).toBe(true);
    expect(structure(polished.findings)).toEqual(structure(result.findings));
  });
});
