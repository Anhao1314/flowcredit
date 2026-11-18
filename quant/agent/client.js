/*
 * quant/agent/client.js — 量化研究 agent 模型客户端 v0.0.3
 *
 * 不做什么（硬约束）：
 *   1. 只做 env 解析与默认值（QUANT_AGENT_MODEL），网关接线归
 *      agent/core/agent-client.js；本文件不发起任何调用决策。
 *   2. 未配置 key 时 configured()=false，上层必须降级为确定性路径。
 */

import { createAgentClientAdapter } from "../../agent/core/agent-client.js";

export const AGENT_VERSION = "quant-agent/v0.0.3";

/** Quant compatibility adapter: function calling and SSE over the shared gateway. */
export function createAgentClient(options = {}) {
  const envTimeout = Number(process.env.QUANT_AGENT_TIMEOUT_MS);
  return createAgentClientAdapter({
    apiKey: options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY,
    baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL,
    model: options.model || process.env.QUANT_AGENT_MODEL || "deepseek-chat",
    timeoutMs: options.timeoutMs || (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000),
    transport: options.transport
  });
}
