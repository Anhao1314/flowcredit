/*
 * agent/core/audit-logger.js — JSONL 元数据审计器（域中立，共享内核）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不记录问题/回答明文——只记 SHA-256 前缀哈希；不记录工具结果内容。
 *   2. 不联网、不做任何业务计算；写失败静默返回 false（审计失败不阻断回答）。
 *   3. 本文件不含时钟读取：`now` 由调用方注入或传入默认函数（字段语义层唯一的
 *      时间来源），时间戳格式固定 ISO-8601。
 *   4. 目录由调用方决定（必须在仓库外、重启不丢）；本文件只负责 mkdir 0700 + append。
 *   5. eventType / auditVersion 参数化：业务风险面（risk.agent.completed）与量化面
 *      （quant.agent.completed / quant.inspection.narrative）共享同一写入实现。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createAuditEvent } from "./audit-event.js";

const hash16 = value => createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);

const defaultNow = () => new Date().toISOString();

/**
 * 输入：{ dir, now?, eventType, auditVersion, fileName? }
 *   eventType: 字符串，或 (event) => string（按事件选择类型，如量化侧 narrative）。
 * 输出：{ dir, nowMs(), write(event) -> boolean }。
 * event 允许字段：sessionId/question/answer/harnessStatus/code/toolCalls/steps/usage/durationMs/model/agentVersion/intent/intentSource。
 */
export function createJsonlAuditLogger({ dir, now = defaultNow, eventType, auditVersion, fileName = "agent-audit.jsonl" } = {}) {
  if (!dir) throw new TypeError("audit logger requires a dir (outside the repository)");
  if (!eventType) throw new TypeError("audit logger requires an eventType");
  if (!auditVersion) throw new TypeError("audit logger requires an auditVersion");
  const typeFor = typeof eventType === "function" ? eventType : () => eventType;

  return {
    dir,
    nowMs: () => Date.now(),
    write(event) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const allowed = createAuditEvent({
          eventType: typeFor(event),
          timestamp: now(),
          run: event.run ?? null,
          payload: {
            auditVersion,
            sessionId: event.sessionId ?? null,
            questionHash: event.question == null ? null : hash16(event.question),
            answerHash: event.answer == null ? null : hash16(event.answer),
            harnessStatus: event.harnessStatus ?? null,
            code: event.code ?? null,
            toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls.map(call => `${call.name}:${call.ok ? "ok" : "rejected"}`).join(">") : null,
            steps: event.steps ?? null,
            usage: event.usage ?? null,
            durationMs: event.durationMs ?? null,
            model: event.model ?? null,
            agentVersion: event.agentVersion ?? null,
            intent: event.intent ?? null,
            intentSource: event.intentSource ?? null
          }
        });
        appendFileSync(join(dir, fileName), `${JSON.stringify(allowed)}\n`, { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    }
  };
}
