import type { LlmProvider } from "./provider.js";

/**
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, DeepSeek, Qwen,
 * Ollama, vLLM, an internal gateway. Configured entirely by environment so a
 * key never lands in a command line or a CI log.
 *
 *   SIA_LLM_BASE_URL   e.g. https://api.openai.com/v1   (required to enable)
 *   SIA_LLM_API_KEY    bearer token
 *   SIA_LLM_MODEL      default gpt-4o-mini
 */
export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("未设置 SIA_LLM_BASE_URL，无法启用 --llm；离线模式请使用默认 mock provider。");
    this.name = "LlmNotConfiguredError";
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiCompatConfig | undefined {
  const baseUrl = env.SIA_LLM_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.SIA_LLM_API_KEY?.trim(),
    model: env.SIA_LLM_MODEL?.trim() || "gpt-4o-mini",
  };
}

export function createOpenAiCompatProvider(config: OpenAiCompatConfig): LlmProvider {
  return {
    name: `openai-compat:${config.model}`,
    async complete(prompt: string): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
      try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            temperature: config.temperature ?? 0.2,
            messages: [
              {
                role: "system",
                content:
                  "你为 MySQL 索引体检工具补充运维提示。只输出中文正文，不要复述结论，不要添加免责声明或标题。",
              },
              { role: "user", content: prompt },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`LLM 端点返回 ${response.status} ${response.statusText}`);
        }

        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = payload.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("LLM 返回内容为空");
        return text;
      } catch (err) {
        throw new Error(
          (err as Error).name === "AbortError"
            ? `LLM 请求超时（${config.timeoutMs ?? 15000}ms）`
            : (err as Error).message,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Provider selection for the CLI: explicit config, then env, then nothing. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const config = configFromEnv(env);
  if (!config) throw new LlmNotConfiguredError();
  return createOpenAiCompatProvider(config);
}
