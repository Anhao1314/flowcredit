/*
 * quant/agent/mcp-server.js — 质检能力 MCP Server v0.1.0（W3：B2B 分发渠道）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只暴露确定性质检工具（验货/裁决/门禁查询）——下单/交易/写权威字段类工具
 *      永不出现在工具清单（治理测试锁定：工具名白名单断言）。
 *   2. 零网络、零密钥、零时钟依赖：全部工具基于冻结数据 + 纯函数——任何 agent
 *      可安全接入，无泄露面。传输 = stdio（换行分隔 JSON-RPC 2.0，MCP 2025-06-18 规范）。
 *   3. JSON-RPC 帧手工实现（零依赖哲学）：initialize/tools/list/tools/call/ping；
 *      解析失败/未知方法按规范返回错误码；stdout 只写协议帧，日志走 stderr。
 *   4. 工具实现复用主线：registry（封闭注册表）+ adjudicateCandidates + verifyText——
 *      与控制台/CLI 同源，不做第二套实现。
 *   5. 模型无关、框架无关：本 server 不调用任何 LLM——LLM 在客户端侧。
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createToolRegistry } from "./tools.js";
import { verifyText } from "./workflow/verify-claims.js";
import { adjudicateCandidates } from "../proposals/adjudicate.js";
import { validateCandidate } from "../proposals/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "flowcredit-inspection-mcp", version: "quant-mcp/v0.1.0" };

/** 构建工具清单与处理器（注入 registry/dataset 以便测试）。 */
export function buildMcpTools({ dataset, trials, adjudicationDataset, costRate } = {}) {
  const registry = createToolRegistry({ dataset, trials });
  const tools = [
    {
      name: "assess_frozen_dataset",
      description: "Run the full deterministic pipeline on the frozen snapshot: signal components, guard status, decision, fingerprints. Use when asked about overall dataset verdict.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => registry.get("assess_frozen_dataset").execute({})
    },
    {
      name: "guard_check",
      description: "Risk guard re-check: drawdown vs frozen 25% limit, breach codes, decision status. Use when asked why trading is halted/blocked.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => registry.get("guard_check").execute({})
    },
    {
      name: "trial_metrics",
      description: "All six registered trials with net-of-cost metrics (pp-Sharpe/OOS/turnover/MaxDD) + the deterministic selection with DSR. Call ONCE — it returns everything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => registry.get("trial_metrics").execute({})
    },
    {
      name: "data_quality",
      description: "Data quality gate re-check: rows, span, max daily move, findings. Use when asked about data trustworthiness.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => registry.get("data_quality").execute({})
    },
    {
      name: "signal_components",
      description: "Three signal components (momentum/trend/stability) breakdown for the frozen snapshot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => registry.get("signal_components").execute({})
    },
    {
      name: "verify_claims",
      description: "The claim verifier: paste AI-generated research text; every keyword-anchored numeric claim (drawdown %, signalScore, DSR, pp-Sharpe, rows) is re-computed against deterministic tools and flagged match/mismatch/unverifiable. Use to check whether an AI report's numbers are trustworthy.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "AI-generated research artifact text to inspect" } }, required: ["text"], additionalProperties: false },
      execute: args => verifyText(String(args.text), {
        signalScore: registry.get("assess_frozen_dataset").execute({}).authoritative.signalScore,
        maxDrawdownPct: registry.get("assess_frozen_dataset").execute({}).authoritative.signals.maxDrawdownPct,
        dsr: registry.get("trial_metrics").execute({}).selected.dsr,
        sharpePerPeriod: registry.get("trial_metrics").execute({}).selected.sharpePerPeriod,
        rows: registry.get("data_quality").execute({}).stats.rows
      })
    },
    {
      name: "adjudicate_candidate",
      description: "Deterministic adjudication of ONE strategy candidate (family + params) against the 2y BTC snapshot with calibrated cost: returns net metrics + pool DSR. Read-only review material — never registers or promotes anything.",
      inputSchema: {
        type: "object",
        properties: { family: { type: "string" }, params: { type: "object" }, rationale: { type: "string" } },
        required: ["family", "params"], additionalProperties: false
      },
      execute: args => {
        const validated = validateCandidate({ family: args.family, params: args.params, rationale: args.rationale });
        if (!validated.ok) throw new TypeError(validated.error);
        return adjudicateCandidates({ dataset: adjudicationDataset, candidates: [validated.candidate], costRate });
      }
    }
  ];
  return { tools, registry };
}

/** JSON-RPC 请求分发（确定性、纯帧级——供 stdio 循环与测试共用）。 */
export function createMcpDispatcher({ tools, protocolVersion = MCP_PROTOCOL_VERSION, serverInfo = MCP_SERVER_INFO } = {}) {
  const toolByName = new Map(tools.map(tool => [tool.name, tool]));
  return function dispatch(message) {
    let parsed;
    try { parsed = JSON.parse(message); } catch { return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      return { jsonrpc: "2.0", id: parsed?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    const { id, method, params = {} } = parsed;
    const respond = result => (id === undefined || id === null ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, text) => (id === undefined || id === null ? null : { jsonrpc: "2.0", id, error: { code, message: text } });

    if (method === "initialize") {
      return respond({ protocolVersion: params.protocolVersion ?? protocolVersion, capabilities: { tools: {} }, serverInfo });
    }
    if (method === "notifications/initialized") return null; // 通知：无响应
    if (method === "ping") return respond({});
    if (method === "tools/list") {
      return respond({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === "tools/call") {
      const tool = toolByName.get(params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        const result = tool.execute(params.arguments ?? {});
        return respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
      } catch (error) {
        return respond({ content: [{ type: "text", text: String(error?.message || error) }], isError: true });
      }
    }
    return fail(-32601, `Method not found: ${method}`);
  };
}

/** 构建 stdio server（可注入流以便测试）。 */
export function createMcpServer(options = {}) {
  const { tools: built } = buildMcpTools(options);
  const dispatch = createMcpDispatcher({ tools: built });
  const { input = process.stdin, output = process.stdout } = options;
  return {
    serverInfo: MCP_SERVER_INFO,
    tools: built,
    start() {
      const rl = createInterface({ input, terminal: false });
      rl.on("line", line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const response = dispatch(trimmed);
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
      return rl;
    }
  };
}

/** 独立运行：npm run mcp */
if (process.argv[1] && process.argv[1].endsWith("mcp-server.js")) {
  const loadFrozen = path => JSON.parse(readFileSync(join(QUANT, "data", path), "utf8"));
  const datasetV002 = loadFrozen("dataset-v002.json");
  const trialsV002 = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
  const adjudicationDataset = loadFrozen("dataset-v003.json"); // 2y BTC：adjudicate_candidate 的裁决面
  let costRate;
  try {
    const calibration = JSON.parse(readFileSync(join(QUANT, "data", "cost-calibration.json"), "utf8"));
    costRate = calibration.perSymbol?.[adjudicationDataset.symbol]?.oneSideRate ?? undefined;
  } catch { costRate = undefined; }
  const server = createMcpServer({
    dataset: datasetV002, trials: trialsV002, adjudicationDataset, costRate,
    input: process.stdin, output: process.stdout
  });
  server.start();
  process.stderr.write(`${MCP_SERVER_INFO.name} ${MCP_SERVER_INFO.version} ready on stdio (${MCP_PROTOCOL_VERSION}) · tools: ${server.tools.map(tool => tool.name).join(", ")}\n`);
}
