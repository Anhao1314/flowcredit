/*
 * agent/src/risk-client.js — 业务风险 agent 模型客户端 v0.1.1
 *
 * 不做什么（硬约束）：
 *   1. 只做 env 解析与默认值（FC_AGENT_* → DEEPSEEK_* 兼容链），网关接线归
 *      core/agent-client.js；本文件不发起任何调用决策。
 *   2. 未配置 key 时 configured()=false，上层必须降级为确定性路径。
 */

import { createAgentClientAdapter } from "../core/agent-client.js";

export const AGENT_VERSION = "risk-agent/v0.1.0";

/** Risk agent compatibility adapter: function calling and SSE over the shared gateway. */
export function createRiskClient(options = {}) {
  const envTimeout = Number(options.env?.FC_AGENT_TIMEOUT_MS ?? process.env.FC_AGENT_TIMEOUT_MS);
  return createAgentClientAdapter({
    apiKey: options.apiKey !== undefined ? options.apiKey : (options.env?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY),
    baseUrl: options.baseUrl || options.env?.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL,
    model: options.model || options.env?.FC_AGENT_MODEL || process.env.FC_AGENT_MODEL || options.env?.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
    timeoutMs: options.timeoutMs || (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000),
    maxTokens: options.maxTokens || 1400,
    transport: options.transport
  });
}
