import { createModelGateway } from "../core/model-gateway.js";

export const AGENT_VERSION = "risk-agent/v0.1.0";

/** Risk agent compatibility adapter: function calling and SSE over the shared gateway. */
export function createRiskClient(options = {}) {
  const envTimeout = Number(options.env?.FC_AGENT_TIMEOUT_MS ?? process.env.FC_AGENT_TIMEOUT_MS);
  const gateway = createModelGateway({
    apiKey: options.apiKey !== undefined ? options.apiKey : (options.env?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY),
    baseUrl: options.baseUrl || options.env?.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL,
    model: options.model || options.env?.FC_AGENT_MODEL || process.env.FC_AGENT_MODEL || options.env?.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
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
