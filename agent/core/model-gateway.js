/**
 * Shared OpenAI-compatible model gateway.
 * Transport, timeout and stream parsing live here; consent, retries, domain
 * tools and authoritative decisions remain outside this zero-business module.
 */

export class ModelGatewayError extends Error {
  constructor(code, message, cause = undefined) {
    super(message);
    this.name = "ModelGatewayError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function malformed(message, cause = undefined) {
  return new ModelGatewayError("MODEL_MALFORMED", message, cause);
}

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
  throw malformed("stream body unsupported");
}

export function createModelGateway(options = {}) {
  const apiKey = options.apiKey;
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model;
  const timeoutMs = options.timeoutMs || 45_000;
  const defaultMaxTokens = options.maxTokens || 800;
  const transport = options.transport || globalThis.fetch;
  if (typeof transport !== "function") throw new TypeError("transport must be a fetch-like function");

  async function request({ messages, tools = [], stream = false, onDelta = null, signal = null } = {}) {
    if (!apiKey) throw new ModelGatewayError("HARNESS_UNCONFIGURED", "DEEPSEEK_API_KEY is not configured");
    if (!Array.isArray(messages) || !messages.length) throw new TypeError("messages must be a non-empty array");
    if (signal?.aborted) throw new ModelGatewayError("MODEL_ABORTED", "model call aborted by caller");

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    // Deliberately referenced; see the standalone timeout regression test.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const body = { model, messages, max_tokens: boundedInteger(undefined, defaultMaxTokens, 1, 8192) };
      if (tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      if (options.temperature !== undefined && options.temperature !== null) body.temperature = options.temperature;
      if (stream) {
        body.stream = true;
        body.stream_options = { include_usage: true };
      }
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      if (stream) headers.Accept = "text/event-stream";

      const response = await transport(`${baseUrl}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal
      });
      if (!response.ok) {
        const error = new ModelGatewayError("MODEL_HTTP_ERROR", `model endpoint returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (stream) return await readEventStream(response, onDelta);

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw malformed("model response was not valid JSON", error);
      }
      const message = payload?.choices?.[0]?.message;
      if (!message) throw malformed("model response missing choices[0].message");
      return { message, usage: payload.usage ?? null };
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (error?.name === "AbortError") {
        if (!timedOut && signal?.aborted) throw new ModelGatewayError("MODEL_ABORTED", "model call aborted by caller", error);
        throw new ModelGatewayError("MODEL_TIMEOUT", "model call timed out", error);
      }
      if (stream && error instanceof SyntaxError) throw malformed("model stream contained a malformed SSE line", error);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  return Object.freeze({
    chat: async input => request({ ...input, stream: false }),
    chatStream: async input => request({ ...input, stream: true }),
    model,
    baseUrl,
    timeoutMs,
    configured: () => Boolean(apiKey)
  });
}

async function readEventStream(response, onDelta) {
  if (!response.body) throw malformed("model stream response missing body");
  const decoder = new TextDecoder();
  const toolCallsAcc = [];
  let buffer = "";
  let content = "";
  let finishReason = null;
  let usage = null;

  const handleLine = line => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const parsed = JSON.parse(data);
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
  if (!finishReason && !message.content && !message.tool_calls) throw malformed("model stream ended without content");
  return { message, usage, finishReason };
}
