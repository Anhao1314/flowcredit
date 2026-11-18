/*
 * agent/core/agent-client.js — 模型网关的冻结适配器（域中立，共享内核）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 本文件不做鉴权/降级决策：只把 createModelGateway 包成 frozen 的
 *      {chat, chatStream, model, baseUrl, configured} 形状；未配置时由 gateway 抛
 *      HARNESS_UNCONFIGURED，上层必须降级为确定性结果。
 *   2. 本文件不读环境变量、不决定默认模型/超时——env 解析留在各业务面的薄封装
 *      （agent/src/risk-client.js 与 quant/agent/client.js），保持各自兼容策略。
 *   3. 不缓存、不落盘、不重试；SSE 由 gateway 实现，信号透传。
 */

import { createModelGateway } from "./model-gateway.js";

/**
 * 输入：{ apiKey, baseUrl, model, timeoutMs?, maxTokens?, transport? }
 * 输出：frozen { chat, chatStream, model, baseUrl, configured }。
 */
export function createAgentClientAdapter({ apiKey, baseUrl, model, timeoutMs = 30_000, maxTokens = 800, transport } = {}) {
  const gateway = createModelGateway({ apiKey, baseUrl, model, timeoutMs, maxTokens, transport });
  return Object.freeze({
    chat: ({ messages, tools = [] }) => gateway.chat({ messages, tools }),
    chatStream: ({ messages, tools = [], signal = null, onDelta = null }) => gateway.chatStream({ messages, tools, signal, onDelta }),
    model: gateway.model,
    baseUrl: gateway.baseUrl,
    configured: gateway.configured
  });
}
