/*
 * quant/agent/client.js — DeepSeek REST 客户端 v0.0.2（quant-agent/v0.0.2 的模型接口）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不含任何业务计算：本文件只与模型 API 通信，不理解 quant 概念。
 *   2. 不 import 任何业务模块（pipeline/signal/risk/metrics）——依赖单向：sidecar→client。
 *   3. 不用随机数、不读时钟；同 transport 同输入 → 同输出（可重放）。
 *   4. 不落盘、不做重试循环——失败原样抛错，降级决策在 sidecar。
 *   5. 密钥只在构造参数或 env 中读取，永不写入日志或产物。
 */

export const AGENT_VERSION = "quant-agent/v0.0.2";

/**
 * 输入：{ model?, baseUrl?, apiKey?, transport?, timeoutMs? }。
 * transport 可注入（fetch 同签名）→ scripted 模式完全离线可测。
 * 输出：{ chat({messages, tools}) → message, model, configured() }。
 * message 为 OpenAI/DeepSeek chat.completion 格式：{ role, content, tool_calls? }。
 */
export function createAgentClient(options = {}) {
  const model = options.model || process.env.QUANT_AGENT_MODEL || "deepseek-chat";
  const baseUrl = String(options.baseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY;
  const transport = options.transport || globalThis.fetch;
  const envTimeout = Number(process.env.QUANT_AGENT_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs || (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000);
  if (typeof transport !== "function") throw new TypeError("transport must be a fetch-like function");

  async function chat({ messages, tools = [] }) {
    if (!apiKey) {
      const error = new Error("DEEPSEEK_API_KEY is not configured");
      error.code = "HARNESS_UNCONFIGURED";
      throw error;
    }
    if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages must be a non-empty array");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? "auto" : undefined }),
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`model endpoint returned HTTP ${response.status}`);
        error.code = "MODEL_HTTP_ERROR";
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      const message = body?.choices?.[0]?.message;
      if (!message) {
        const error = new Error("model response missing choices[0].message");
        error.code = "MODEL_MALFORMED";
        throw error;
      }
      return { message, usage: body.usage ?? null };
    } catch (error) {
      if (error?.name === "AbortError") {
        const wrapped = new Error("model call timed out");
        wrapped.code = "MODEL_TIMEOUT";
        throw wrapped;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { chat, model, configured: () => Boolean(apiKey) };
}
