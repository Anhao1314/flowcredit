/*
 * agent/src/audit-risk.js — 业务风险 agent 审计日志 v0.1.1（仅元数据，JSONL）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不记录问题/回答明文——只记 SHA-256 前缀哈希；不记录工具结果内容。
 *   2. 不联网、不做任何业务计算；写失败静默返回 false（审计失败不阻断回答）。
 *   3. 时钟语义在本文件：时间戳与耗时需要时钟（仅限此处与 core/audit-logger 的 now 注入）。
 *   4. 目录默认 ~/.flowcredit-agent/（仓库外固定目录，重启不丢），
 *      可用 FC_AGENT_AUDIT_DIR / FC_AGENT_AUDIT_BASE_DIR 覆盖；永不写入仓库内。
 *   5. 写法与量化面共享 agent/core/audit-logger.js（eventType/auditVersion 参数化），
 *      本文件只保留业务侧的目录策略与事件类型。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createJsonlAuditLogger } from "../core/audit-logger.js";

export const RISK_AUDIT_VERSION = "risk-audit/v0.1.0";

export const RISK_AUDIT_BASE_DIR = process.env.FC_AGENT_AUDIT_BASE_DIR || join(homedir(), ".flowcredit-agent");

export function defaultRiskAuditDir() {
  return process.env.FC_AGENT_AUDIT_DIR || join(RISK_AUDIT_BASE_DIR, "audit");
}

/**
 * 输入：{ dir?, now? }（now 可注入以便测试）。
 * 输出：{ dir, nowMs(), write(event) -> boolean }。
 * event 允许字段：sessionId/question/answer/harnessStatus/code/toolCalls/steps/usage/durationMs/model/agentVersion/intent/intentSource（intent 仅标签，不含 prompt 文本）。
 */
export function createRiskAuditLogger({ dir = defaultRiskAuditDir(), now } = {}) {
  return createJsonlAuditLogger({
    dir,
    ...(now ? { now } : {}),
    eventType: "risk.agent.completed",
    auditVersion: RISK_AUDIT_VERSION
  });
}
