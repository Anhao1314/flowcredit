/*
 * quant/agent/workflow/case-store.js — 案件档案持久化 v0.1.0（W4）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. JsonFileSaver：LangGraph 检查点的文件持久化（继承 MemorySaver 的全部语义，
 *      仅把 storage/writes 落盘/回载）——案件跨进程重启可恢复（签字门不断）。
 *      生产部署可替换为官方 PostgresSaver（工厂参数化，本层零改动）。
 *   2. 存储文件含序列化检查点（哈希/指标/版本），不含明文密钥——目录权限 0700。
 *   3. 案件索引（index.json）持久化：重启后案件列表/序号不丢。
 *   4. 写入即落盘（write-through）；损坏文件静默降级为空库（fail-open 仅限读侧，
 *      写侧失败原样抛出）。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

export const CASE_STORE_VERSION = "quant-case-store/v0.1.0";

/** 继承 MemorySaver 的语义（storage/writes 双对象），落盘到单个 JSON 文件。 */
export class JsonFileSaver extends MemorySaver {
  #filePath;
  constructor(filePath) {
    super();
    this.#filePath = filePath;
    if (existsSync(filePath)) {
      try {
        const saved = JSON.parse(readFileSync(filePath, "utf8"), (_key, value) => (value && typeof value === "object" && typeof value.__uint8array__ === "string" ? new Uint8Array(Buffer.from(value.__uint8array__, "base64")) : value));
        if (saved?.caseStoreVersion !== CASE_STORE_VERSION) throw new TypeError("case store version mismatch");
        this.storage = saved.storage ?? Object.create(null);
        this.writes = saved.writes ?? Object.create(null);
      } catch (error) {
        // fail-closed：损坏/版本不符的档案库绝不静默降级为空——必须人工处理
        throw new TypeError(`case store unreadable: ${String(error?.message || error)}`);
      }
    }
  }
  #flush() {
    mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    // 检查点值可能含二进制序列化产物（Uint8Array）——JSON 需要 base64 编解码才能往返
    const binaryToBase64 = (_key, value) => (value instanceof Uint8Array ? { __uint8array__: Buffer.from(value).toString("base64") } : value);
    writeFileSync(this.#filePath, JSON.stringify({ caseStoreVersion: CASE_STORE_VERSION, storage: this.storage, writes: this.writes }, binaryToBase64));
  }
  #revive(value) {
    return value && typeof value === "object" && typeof value.__uint8array__ === "string"
      ? new Uint8Array(Buffer.from(value.__uint8array__, "base64"))
      : value;
  }
  async put(config, checkpoint, metadata) {
    const result = await super.put(config, checkpoint, metadata);
    this.#flush();
    return result;
  }
  async putWrites(config, writes, taskId, taskPath) {
    await super.putWrites(config, writes, taskId, taskPath);
    this.#flush();
  }
}

/** 案件索引持久化：[{caseId, threadId, kind, submittedBy, createdAtUtc, summary}]。 */
export function loadCaseIndex(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.caseIndexVersion !== CASE_STORE_VERSION || !Array.isArray(parsed.cases)) return [];
    return parsed.cases;
  } catch {
    return [];
  }
}

export function saveCaseIndex(filePath, cases) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify({ caseIndexVersion: CASE_STORE_VERSION, cases }) + "\n", "utf8");
}

export function nextCaseSeq(cases) {
  let max = 0;
  for (const entry of cases) {
    const match = /^case-(\d+)$/.exec(entry.caseId ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
