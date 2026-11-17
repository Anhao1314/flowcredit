/*
 * quant/agent/workflow/case-store.js — 案件档案持久化 v0.2.0（去框架：vanilla 状态存取）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. CaseFileStore：案件状态机快照（{values, next}）的文件持久化——案件跨进程
 *      重启可恢复（签字门不断）。v0.2 起为零依赖手写实现（不再继承 LangGraph
 *      MemorySaver）；生产部署可换 Postgres 等后端（工厂参数化，本层零改动）。
 *   2. 存储文件含序列化状态（哈希/指标/版本），不含明文密钥——目录权限 0700。
 *   3. 案件索引（index.json）持久化：重启后案件列表/序号不丢。
 *   4. 写入即落盘（write-through）；损坏/版本不符文件静默降级为空库（fail-open
 *      仅限读侧，写侧失败原样抛出）。v0.1 的 LangGraph 检查点文件不迁移——旧案件
 *      目录读出为空库（本地测试数据，已在发版说明披露）。
 */

import { JsonCheckpointFile } from "../../../agent/core/checkpoint-file.js";

export const CASE_STORE_VERSION = "quant-case-store/v0.2.0";

/** 案件状态存取：get/put 单线程键（threadId），写穿到单个 JSON 文件。 */
export class CaseFileStore {
  #store;
  constructor(filePath) {
    this.#store = new JsonCheckpointFile(filePath, { version: CASE_STORE_VERSION, versionKey: "caseStoreVersion" });
    // 读侧 fail-open：损坏/版本不符（如 v0.1 的 LangGraph 检查点文件）→ 空库起步，
    // 下一次 put 写穿后以 v0.2 格式覆盖。写侧失败仍原样抛出。
    let saved = null;
    try { saved = this.#store.load(); } catch { saved = null; }
    this.states = saved?.states && typeof saved.states === "object" && !Array.isArray(saved.states)
      ? saved.states
      : Object.create(null);
  }
  loadState(threadId) {
    return Object.prototype.hasOwnProperty.call(this.states, threadId) ? this.states[threadId] : null;
  }
  saveState(threadId, snapshot) {
    this.states[threadId] = snapshot;
    this.#store.save({ states: this.states });
    return snapshot;
  }
}

/** 案件索引持久化：[{caseId, threadId, kind, submittedBy, createdAtUtc, summary}]。 */
export function loadCaseIndex(filePath) {
  try {
    const parsed = new JsonCheckpointFile(filePath, { version: CASE_STORE_VERSION, versionKey: "caseIndexVersion" }).load();
    return Array.isArray(parsed?.cases) ? parsed.cases : [];
  } catch {
    return [];
  }
}

export function saveCaseIndex(filePath, cases) {
  new JsonCheckpointFile(filePath, { version: CASE_STORE_VERSION, versionKey: "caseIndexVersion" }).save({ cases });
}

export function nextCaseSeq(cases) {
  let max = 0;
  for (const entry of cases) {
    const match = /^case-(\d+)$/.exec(entry.caseId ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
