import { createModelGateway } from "../../agent/core/model-gateway.js";

export const AGENT_VERSION = "quant-agent/v0.0.3";

/** Quant compatibility adapter: function calling and SSE over the shared gateway. */
export function createAgentClient(options = {}) {
  const envTimeout = Number(process.env.QUANT_AGENT_TIMEOUT_MS);
  const gateway = createModelGateway({
    apiKey: options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY,
    baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL,
    model: options.model || process.env.QUANT_AGENT_MODEL || "deepseek-chat",
    timeoutMs: options.timeoutMs || (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000),
    maxTokens: 800,
    transport: options.transport
  });

  return Object.freeze({
    chat: ({ messages, tools = [] }) => gateway.chat({ messages, tools }),
    chatStream: ({ messages, tools = [], signal = null, onDelta = null }) => gateway.chatStream({ messages, tools, signal, onDelta }),
    model: gateway.model,
    baseUrl: gateway.baseUrl,
    configured: gateway.configured
  });
}
