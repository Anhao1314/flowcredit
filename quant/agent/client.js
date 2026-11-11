/*
 * quant/agent/client.js — DeepSeek REST 客户端 v0.0.3（quant-agent/v0.0.3 的模型接口）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不含任何业务计算：本文件只与模型 API 通信，不理解 quant 概念。
 *   2. 不 import 任何业务模块（pipeline/signal/risk/metrics）——依赖单向：sidecar→client。
 *   3. 不用随机数、不读时钟；同 transport 同输入 → 同输出（可重放）。
 *   4. 不落盘、不做重试循环——失败原样抛错，降级决策在 sidecar。
 *   5. 密钥只在构造参数或 env 中读取，永不写入日志或产物。
 */

export const AGENT_VERSION = "quant-agent/v0.0.3";

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

  /** fetch Response.body（web ReadableStream）或任意 async-iterable/字符串 → 文本块序列。 */
  async function* bodyChunks(body) {
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock?.();
      }
      return;
    }
    if (body && typeof body[Symbol.asyncIterator] === "function") { yield* body; return; }
    if (typeof body === "string") { yield body; return; }
    const error = new Error("stream body unsupported");
    error.code = "MODEL_MALFORMED";
    throw error;
  }

  /**
   * 流式 chat：OpenAI 兼容 SSE（stream:true）。逐块回调 onDelta(piece, accumulated)，
   * 返回 { message, usage, finishReason }——message 与 chat() 同形状（tool_calls 聚合完毕）。
   * signal 为外部取消（调用方断连/用户停止）→ 抛 code=MODEL_ABORTED；内部超时仍为 MODEL_TIMEOUT。
   */
  async function chatStream({ messages, tools = [], signal = null, onDelta = null } = {}) {
    if (!apiKey) {
      const error = new Error("DEEPSEEK_API_KEY is not configured");
      error.code = "HARNESS_UNCONFIGURED";
      throw error;
    }
    if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages must be a non-empty array");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const response = await transport(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify({
          model, messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`model endpoint returned HTTP ${response.status}`);
        error.code = "MODEL_HTTP_ERROR";
        error.status = response.status;
        throw error;
      }
      if (!response.body) {
        const error = new Error("model stream response missing body");
        error.code = "MODEL_MALFORMED";
        throw error;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      const toolCallsAcc = [];
      let finishReason = null;
      let usage = null;
      const handleLine = line => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        const parsed = JSON.parse(data); // 协议坏行 = 上游不再可信，直接抛错（fail-closed）
        if (parsed?.usage) usage = parsed.usage;
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        if (delta && typeof delta.content === "string" && delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content, content);
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const piece of delta.tool_calls) {
            const index = typeof piece.index === "number" ? piece.index : toolCallsAcc.length;
            const acc = toolCallsAcc[index] ??= { id: undefined, type: "function", function: { name: "", arguments: "" } };
            if (piece.id) acc.id = piece.id;
            if (piece.type) acc.type = piece.type;
            if (piece.function?.name) acc.function.name += piece.function.name;
            if (piece.function?.arguments) acc.function.arguments += piece.function.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      };
      for await (const chunk of bodyChunks(response.body)) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt).replace(/\r$/, "");
          buffer = buffer.slice(newlineAt + 1);
          handleLine(line);
          newlineAt = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) handleLine(buffer.trim());
      const message = { role: "assistant", content: content || null };
      if (toolCallsAcc.length) {
        message.tool_calls = toolCallsAcc.map((call, index) => ({
          id: call.id ?? `call-${index}`,
          type: call.type || "function",
          function: { name: call.function.name, arguments: call.function.arguments }
        }));
      }
      if (!finishReason && !message.content && !message.tool_calls) {
        const error = new Error("model stream ended without content");
        error.code = "MODEL_MALFORMED";
        throw error;
      }
      return { message, usage, finishReason };
    } catch (error) {
      if (error?.name === "AbortError") {
        if (signal?.aborted) {
          const aborted = new Error("model call aborted by caller");
          aborted.code = "MODEL_ABORTED";
          throw aborted;
        }
        const wrapped = new Error("model call timed out");
        wrapped.code = "MODEL_TIMEOUT";
        throw wrapped;
      }
      if (error instanceof SyntaxError) {
        const malformed = new Error("model stream contained a malformed SSE line");
        malformed.code = "MODEL_MALFORMED";
        throw malformed;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  return { chat, chatStream, model, configured: () => Boolean(apiKey) };
}
