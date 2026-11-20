import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDeterministicIntent, isToolAllowed, allowedFamiliesFor, intentFromTools,
  RISK_INTENT_VERSION, RISK_INTENTS, TOOL_FAMILIES
} from "../src/risk-intents.js";
import { SessionStore } from "../src/session-store.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { HarnessBrain } from "../src/harness.js";
import { createAssessmentService } from "../src/assessment-service.js";
import { createChatPipeline } from "../src/chat-pipeline.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";
import { createRiskAssistant } from "../src/risk-assistant.js";
import { createRiskAuditLogger } from "../src/audit-risk.js";

const connectors = createConnectorRegistry([createCsvConnector()]);

test("deterministic intent classification covers the crisp cases and abstains otherwise", () => {
  const cases = [
    ['{"version":"evidence-pack/v0.1","asOf":"2026-08-31","sourceDomain":"billing","fields":{"repaymentRatePct":96}}', "evidence-pack"],
    ["period,input_tokens_m,valid_rate_pct,revenue_usd\n2026-03,64,96,100000\n2026-04,65,96,101000", "csv"],
    ['{"taskType":"inference","gpuModel":"h100-equivalent","revenueUsd":100000}', "facts"],
    ["回款率如果是 90% 会怎样？", "what-if"],
    ["你好", "small-talk"],
    ["你能做什么？", "help"],
    ["帮我评估一个游戏公司的广告收入", "out-of-scope"],
    ["这家公司看起来不错", "unclear"],
    ['{"foo": 1}', "unclear"]
  ];
  for (const [prompt, expected] of cases) {
    const result = classifyDeterministicIntent(prompt);
    assert.equal(result.intent, expected, `prompt: ${prompt}`);
    assert.equal(result.confidence, expected === "unclear" ? "abstain" : "deterministic");
  }
  assert.equal(RISK_INTENT_VERSION, "flowcredit.risk_intents/v0.1.0");
  assert.deepEqual(RISK_INTENTS.length, 8);
});

test("tool-family matrix: deterministic intents block cross-domain tools, unclear does not", () => {
  assert.equal(isToolAllowed("csv", "import_csv"), true);
  assert.equal(isToolAllowed("csv", "assess_draft"), true);
  assert.equal(isToolAllowed("csv", "build_research_panel"), false, "assessment intent cannot drift into research");
  assert.equal(isToolAllowed("facts", "what_if"), true);
  assert.equal(isToolAllowed("evidence-pack", "attach_evidence"), true);
  assert.equal(isToolAllowed("help", "assess_prompt"), false, "help must not touch tools");
  assert.equal(isToolAllowed("out-of-scope", "lookup_public_company"), false);
  assert.equal(isToolAllowed("unclear", "build_research_panel"), true, "unclear leaves routing to the model");
  assert.equal(isToolAllowed("csv", "no_such_tool"), false);
  assert.deepEqual(allowedFamiliesFor("csv"), ["assessment", "knowledge"], "评估流程中知识查询随时可用");
  assert.equal(allowedFamiliesFor("unclear"), null);
  assert.equal(TOOL_FAMILIES.check_predictions, "predictions");
  assert.equal(TOOL_FAMILIES.calibration_report, "research");
  assert.equal(TOOL_FAMILIES.query_compute_knowledge, "knowledge");
  assert.equal(isToolAllowed("facts", "query_compute_knowledge"), true, "评估流程中可随时问领域知识");
  assert.equal(isToolAllowed("help", "query_compute_knowledge"), false);
});

test("post-hoc intent attribution from tool calls", () => {
  assert.equal(intentFromTools([{ name: "assess_draft" }]), "assessment");
  assert.equal(intentFromTools([{ name: "build_research_panel" }, { name: "calibration_report" }]), "research");
  assert.equal(intentFromTools([{ name: "check_predictions" }]), "predictions");
  assert.equal(intentFromTools([{ name: "lookup_public_company" }]), "public-data");
  assert.equal(intentFromTools([]), "none");
});

const CSV = [
  "period,input_tokens_m,output_tokens_m,valid_rate_pct,gpu_model,gpu_hours,revenue_usd,compute_spend_usd,repayment_rate_pct,overdue_30_pct,paying_customers,top5_concentration_pct,data_coverage_pct",
  "2026-03,64,16,96.5,h100-equivalent,4200,100000,58000,94.3,3,168,36,100",
  "2026-04,65,16,96.5,h100-equivalent,4200,101000,58000,94.3,3,168,36,100",
  "2026-05,66,16,96.5,h100-equivalent,4200,102000,58000,94.3,3,168,36,100",
  "2026-06,67,16,96.5,h100-equivalent,4200,103000,58000,94.3,3,168,36,100"
].join("\n");

function buildAssistant(scenarios) {
  const sessions = new SessionStore();
  const service = createAssessmentService({ brain: new HarnessBrain({}), connectors, sessions, invocationTimeoutMs: 30_000 });
  const pipeline = createChatPipeline({ sessions, connectors, invocationTimeoutMs: 30_000, assess: (b, r) => service.assess(b, r) });
  let index = 0;
  const client = {
    chat: async () => {
      const step = scenarios[Math.min(index, scenarios.length - 1)];
      index += 1;
      return { message: step.message, usage: null, finishReason: step.finishReason ?? null };
    },
    chatStream: async () => { throw new Error("not used"); },
    model: "scripted-model",
    baseUrl: "scripted://local",
    configured: () => true
  };
  const audit = createRiskAuditLogger({ dir: mkdtempSync(join(tmpdir(), "fc-intent-audit-")), now: () => "2026-11-20T00:00:00.000Z" });
  const assistant = createRiskAssistant({
    client,
    registry: createRiskToolRegistry({ connectors }),
    audit,
    deterministicChat: ({ prompt, sessionId, requestId }) => pipeline.buildChatPayload({ prompt, ...(sessionId ? { sessionId } : {}) }, requestId)
  });
  return { assistant, auditDir: audit.dir };
}

test("agent loop: a cross-domain tool call is blocked with INTENT_TOOL_MISMATCH, then the allowed tool succeeds", async () => {
  const { assistant, auditDir } = buildAssistant([
    { message: { tool_calls: [{ id: "c1", function: { name: "build_research_panel", arguments: "{}" } }] } },
    { message: { tool_calls: [{ id: "c2", function: { name: "import_csv", arguments: JSON.stringify({ csv: CSV, label: "Acme" }) } }] } },
    { message: { content: "CSV 已导入并评估。" }, finishReason: "stop" }
  ]);
  const result = await assistant.askRisk({ prompt: CSV, modelConsent: true, sessionId: "intent-csv-1" });
  assert.equal(result.intent, "csv");
  assert.equal(result.intentSource, "deterministic");
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[0].error.code, "INTENT_TOOL_MISMATCH");
  assert.match(result.toolCalls[0].error.message, /outside the detected intent "csv"/);
  assert.equal(result.toolCalls[1].ok, true);
  assert.equal(result.toolCalls[1].name, "import_csv");
  const line = readFileSync(join(auditDir, "agent-audit.jsonl"), "utf8").trim().split("\n").at(-1);
  const event = JSON.parse(line);
  assert.equal(event.intent, "csv");
  assert.equal(event.intentSource, "deterministic");
  assert.ok(!line.includes("input_tokens_m"), "audit carries the label, never the prompt text");
  assert.ok(event.questionHash && event.questionHash.length === 16);
});

test("consent=false still labels the intent deterministically", async () => {
  const { assistant } = buildAssistant([]);
  const facts = JSON.stringify({ taskType: "inference", gpuModel: "h100-equivalent", periodStart: "2026-08-01", periodEnd: "2026-08-31", inputTokensM: 64, outputTokensM: 16, validRatePct: 94, gpuHours: 4200, revenueUsd: 100000, computeSpendUsd: 58000, repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36, operatingHistoryDays: 720, dataCoveragePct: 100, R: [64, 65, 63, 67, 68, 66, 70, 71], C: [62, 63, 62, 65, 66, 65, 68, 69] });
  const result = await assistant.askRisk({ prompt: facts, modelConsent: false });
  assert.equal(result.intent, "facts");
  assert.equal(result.intentSource, "deterministic");
  assert.equal(result.harnessStatus, "not-requested");
});

test("unclear prompts leave routing to the model and attribute the intent post-hoc", async () => {
  const { assistant } = buildAssistant([{ message: { tool_calls: [{ id: "c1", function: { name: "assess_draft", arguments: JSON.stringify({ draft: { taskType: "inference" } }) } }] } }, { message: { content: "无工具可用时的说明。" }, finishReason: "stop" }]);
  const result = await assistant.askRisk({ prompt: "这家公司看起来不错", modelConsent: true, sessionId: "intent-unclear-1" });
  assert.equal(result.intent, "assessment", "derived from the tool family actually used");
  assert.equal(result.intentSource, "derived");
  assert.equal(result.toolCalls[0].ok, true, "unclear intent must not block tools");
});
