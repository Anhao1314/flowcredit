/*
 * quant/test/quant-mcp.test.js — 质检 MCP Server 治理测试（离线：JSON-RPC 帧级 + stdio 端到端）
 *
 * 不做什么（硬约束）：
 *   1. 不触网：MCP server 零网络零密钥；测试用注入流与帧级 dispatch。
 *   2. 治理面锁死：工具清单只含确定性质检能力——下单/交易/写权威字段类工具永不出现。
 *   3. 不用随机数/时钟。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { buildMcpTools, createMcpDispatcher, createMcpServer, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } = await import(join(QUANT, "agent", "mcp-server.js"));

const dataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v002.json"), "utf8"));
const trials = JSON.parse(readFileSync(join(QUANT, "eval", "trials-v002.json"), "utf8"));
const adjudicationDataset = JSON.parse(readFileSync(join(QUANT, "data", "dataset-v003.json"), "utf8"));
const COST_RATE = 0.00134735;

function makeDispatcher() {
  const { tools } = buildMcpTools({ dataset, trials, adjudicationDataset, costRate: COST_RATE });
  return createMcpDispatcher({ tools });
}

function frame(server, id, method, params) {
  return server(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
}

test("handshake: initialize echoes protocolVersion, advertises tools capability + serverInfo", () => {
  const dispatch = makeDispatcher();
  const response = frame(dispatch, 1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: "test-client", version: "0" } });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, MCP_SERVER_INFO.name);
});

test("notifications (no id) produce no response; initialized does not crash", () => {
  const dispatch = makeDispatcher();
  assert.equal(dispatch(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  assert.equal(frame(dispatch, undefined, "ping") ?? null, null, "无 id 的请求不产生响应帧");
});

test("tools/list: exactly the 7 inspection tools; governance whitelist (no order/trade surface)", () => {
  const dispatch = makeDispatcher();
  const response = frame(dispatch, 2, "tools/list");
  const names = response.result.tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), [
    "adjudicate_candidate", "assess_frozen_dataset", "data_quality", "guard_check",
    "signal_components", "trial_metrics", "verify_claims"
  ].sort());
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false, "封闭 schema：禁止未声明参数");
  }
  const joined = names.join("|");
  assert.doesNotMatch(joined, /order|trade|submit|place|execute/i, "下单/交易类工具绝不出现在质检 MCP 面");
});

test("tools/call verify_claims: wrong-number text → verdict fail with per-claim detail", () => {
  const dispatch = makeDispatcher();
  const response = frame(dispatch, 3, "tools/call", { name: "verify_claims", arguments: { text: "复核：最大回撤 12.34%，一切正常。" } });
  assert.equal(response.result.isError, false);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.verdict, "fail");
  assert.equal(payload.mismatchedClaims[0].claimed, 12.34);
  assert.equal(payload.mismatchedClaims[0].expected, 28.5426);
});

test("tools/call adjudicate_candidate: schema-validated; calibrated cost honestly reported", () => {
  const dispatch = makeDispatcher();
  const response = frame(dispatch, 4, "tools/call", {
    name: "adjudicate_candidate",
    arguments: { family: "sma-cross-hysteresis", params: { smaShort: 14, smaLong: 65, entryBandPct: 0.15, exitBandPct: -0.4 }, rationale: "MCP 测试候选" }
  });
  assert.equal(response.result.isError, false);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.best.family, "sma-cross-hysteresis");
  assert.equal(payload.costModel.effectiveSource, "calibrated");
  assert.equal(payload.costModel.effectiveOneSideRate, COST_RATE);
  assert.ok(payload.nTrials.nominal >= 7, "全池 = 注册 6 + 候选 1");
});

test("tools/call adjudicate_candidate: pathological params rejected via isError (fail-closed)", () => {
  const dispatch = makeDispatcher();
  const response = frame(dispatch, 5, "tools/call", { name: "adjudicate_candidate", arguments: { family: "sma-cross-hysteresis", params: { smaShort: 1, smaLong: 60, entryBandPct: 0.1, exitBandPct: -0.5 } } });
  assert.equal(response.result.isError, true, "病态参数必须走 isError 路径");
  assert.match(response.result.content[0].text, /smaShort/);
});

test("tools/call: unknown tool → -32602; unknown method → -32601; bad JSON → -32700", () => {
  const dispatch = makeDispatcher();
  const unknownTool = frame(dispatch, 6, "tools/call", { name: "place_order", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = frame(dispatch, 7, "resources/list");
  assert.equal(unknownMethod.error.code, -32601);
  const badJson = dispatch("{not-json");
  assert.equal(badJson.error.code, -32700);
});

test("stdio end-to-end: framed requests → newline-delimited responses on injected output", async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new PassThrough();
  output.on("data", chunk => chunks.push(chunk));
  const server = createMcpServer({ dataset, trials, adjudicationDataset, costRate: COST_RATE, input, output });
  server.start();
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await new Promise(resolve => setTimeout(resolve, 150));
  input.end();
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2, "通知不产生响应帧");
  const [init, list] = lines.map(line => JSON.parse(line));
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, MCP_SERVER_INFO.name);
  assert.equal(list.id, 2);
  assert.equal(list.result.tools.length, 7);
});
