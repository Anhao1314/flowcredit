/*
 * quant/agent/audit.js — agent 审计日志 v0.0.3（仅元数据，JSONL）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不记录问题/回答明文——只记 SHA-256 前缀哈希；不记录工具结果内容。
 *   2. 不联网、不做任何业务计算；写失败静默返回 false（审计失败不阻断回答）。
 *   3. 本文件是 agent 层唯一的"时钟岛"：时间戳与耗时需要时钟，lint 对本文件豁免
 *      new Date/Date.now（仅限此处；其余 agent 文件仍禁——可重放要求不变）。
 *   4. 目录默认 ~/.flowcredit-quant/（仓库外固定目录，重启不丢——"全程录像"的载体），
 *      可用 QUANT_AUDIT_DIR / QUANT_PAPER_AUDIT_DIR 覆盖；永不写入仓库内。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createAuditEvent } from "../../agent/core/audit-event.js";

export const AUDIT_VERSION = "quant-audit/v0.0.3";

// 审计基目录：仓库外固定位置（替代曾经的系统临时目录——tmpdir 重启即清，审计会丢）。
export const AUDIT_BASE_DIR = process.env.QUANT_AUDIT_BASE_DIR || join(homedir(), ".flowcredit-quant");

export function defaultAuditDir() {
  return process.env.QUANT_AUDIT_DIR || join(AUDIT_BASE_DIR, "audit");
}

export function defaultPaperAuditDir() {
  return process.env.QUANT_PAPER_AUDIT_DIR || join(AUDIT_BASE_DIR, "paper-audit");
}

const hash16 = value => createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);

/**
 * 输入：{ dir?, now? }（now 可注入以便测试）。
 * 输出：{ dir, nowMs(), write(event) -> boolean }。
 * event 允许字段：sessionId/question/answer/harnessStatus/code/toolCalls/steps/usage/durationMs/model/agentVersion。
 */
export function createAuditLogger({ dir = defaultAuditDir(), now = () => new Date().toISOString() } = {}) {
  return {
    dir,
    nowMs: () => Date.now(),
    write(event) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const allowed = createAuditEvent({
          eventType: event.kind === "inspection-narrative" ? "quant.inspection.narrative" : "quant.agent.completed",
          timestamp: now(),
          run: event.run ?? null,
          payload: {
            auditVersion: AUDIT_VERSION,
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
            agentVersion: event.agentVersion ?? null
          }
        });
        appendFileSync(join(dir, "agent-audit.jsonl"), `${JSON.stringify(allowed)}\n`, { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    }
  };
}
