/*
 * agent/src/model-client.js — 模型层（OpenAI 兼容 REST，零 SDK 依赖）
 *
 * 不做什么（硬约束）：
 *   1. 只与模型 API 通信：不理解 FlowCredit 业务、不计算任何风险字段。
 *   2. 不读时钟做业务决策；仅超时控制使用 AbortController。
 *   3. 不落盘、不重试（重试策略在 harness 层）；失败原样抛出带 code 的错误。
 *   4. 密钥只从构造参数或 env 读取，永不打印。
 *
 * 环境变量：DEEPSEEK_API_KEY · DEEPSEEK_BASE_URL（默认 https://api.deepseek.com）
 * 替代已下线的 DSH SDK 层（@deepseek-ai/dsh-sdk-client）。
 */

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export function createModelClient(options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY;
  const baseUrl = String(options.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model;
  const transport = options.transport || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 45_000;
  const maxTokens = options.maxTokens || 2_400;
  if (typeof transport !== "function") throw new TypeError("transport must be a fetch-like function");

  async function chat(messages) {
    if (!apiKey) {
      const error = new Error("DeepSeek credential is not configured");
      error.code = "HARNESS_UNCONFIGURED";
      throw error;
    }
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError("messages must be a non-empty array");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`model endpoint returned HTTP ${response.status}`);
        error.code = "MODEL_HTTP_ERROR";
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        const error = new Error("model response missing content");
        error.code = "MODEL_MALFORMED";
        throw error;
      }
      return { content, usage: body.usage ?? null };
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("model call timed out");
        timeout.code = "MODEL_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { chat, model, baseUrl, configured: () => Boolean(apiKey) };
}
