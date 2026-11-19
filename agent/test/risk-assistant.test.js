import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createCsvConnector } from "../src/connectors/csv.js";
import { HarnessBrain } from "../src/harness.js";
import { createAssessmentService } from "../src/assessment-service.js";
import { createChatPipeline } from "../src/chat-pipeline.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";
import { createRiskAssistant, MAX_STEPS_RISK, SYSTEM_PROMPT_RISK } from "../src/risk-assistant.js";
import { getPresetV021 } from "../src/presets.js";

const connectors = createConnectorRegistry([createCsvConnector()]);

const HEALTHY_CSV_NOTE = "synthetic fixture";

function buildPipeline() {
  const sessions = new SessionStore();
  const service = createAssessmentService({ brain: new HarnessBrain({}), connectors, sessions, invocationTimeoutMs: 30_000 });
  const pipeline = createChatPipeline({
    sessions, connectors, invocationTimeoutMs: 30_000,
    assess: (body, requestId) => service.assess(body, requestId)
  });
  return { sessions, pipeline };
}

/** Scripted model client: each entry is one model turn (tool_calls, content, delta or throw). */
function createScriptedClient(scenarios, { configured = true } = {}) {
  let index = 0;
  const calls = [];
  function nextTurn() {
    const step = scenarios[Math.min(index, scenarios.length - 1)];
    index += 1;
    return step;
  }
  const client = {
    calls,
    chat: async ({ messages, tools }) => {
      calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content ?? null, tool_calls: m.tool_calls ?? null })), toolCount: tools.length });
      const step = nextTurn();
      if (step.throw) throw step.throw;
      return { message: step.message, usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, finishReason: step.finishReason ?? null };
    },
    chatStream: async ({ messages, tools, onDelta, onThinking }) => {
      calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content ?? null })), toolCount: tools.length });
      const step = nextTurn();
      if (step.thinking && onThinking) onThinking(step.thinking);
      if (step.delta) onDelta(step.delta);
      if (step.throw) throw step.throw;
      return { message: step.message, usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, finishReason: step.finishReason ?? null, reasoning: step.thinking ?? "" };
    },
    model: "scripted-model",
    baseUrl: "scripted://local",
    configured: () => configured
  };
  return client;
}

function createMemoryAudit() {
  const events = [];
  return { events, nowMs: () => Date.now(), write(event) { events.push(event); return true; } };
}

function buildAssistant(scenarios, { configured = true, secEdgar = null } = {}) {
  const { sessions, pipeline } = buildPipeline();
  const audit = createMemoryAudit();
  const client = createScriptedClient(scenarios, { configured });
  const assistant = createRiskAssistant({
    client,
    registry: createRiskToolRegistry({ connectors, secEdgar }),
    audit,
    deterministicChat: ({ prompt, sessionId, requestId }) =>
      pipeline.buildChatPayload({ prompt, ...(sessionId ? { sessionId } : {}) }, requestId)
  });
  return { assistant, client, audit, sessions, pipeline };
}

const OFFICIAL_CN = "请帮我评估一家 AI 推理服务商的交易对手风险。这家公司主要使用 H100 GPU，最近一个月 GPU 使用量约 4200 小时，月收入约 10 万美元，算力支出约 5.8 万美元。历史还款率约 96%，30 天以上逾期率约 2%，目前有 168 个付费客户，前 5 大客户贡献约 36% 的收入。";

test("consent gate: without modelConsent the deterministic pipeline answers and emits tool cards", async () => {
  const { assistant, audit } = buildAssistant([]);
  const result = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: false });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "not-requested");
  assert.equal(result.authority, "deterministic-tools");
  assert.match(result.answer, /初步风险评估/);
  assert.deepEqual(result.toolCalls.map(call => call.name), ["extract_from_text", "assess_draft"]);
  assert.equal(result.toolCalls[1].result.TAI, null, "nine fields alone cannot compute TAI");
  assert.equal(result.citations.length, 1, "the pipeline assessment carries its own fingerprint");
  assert.match(result.citations[0].assessmentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].harnessStatus, "not-requested");
});

test("consent gate: the deterministic answer equals the /api/v1/chat answer", async () => {
  const { assistant, pipeline } = buildAssistant([]);
  const agentResult = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: false });
  const chat = await pipeline.buildChatPayload({ prompt: OFFICIAL_CN }, "fc-equal000000001");
  assert.equal(agentResult.answer, chat.body.answer);
});

test("unconfigured client degrades to the deterministic pipeline without touching the transport", async () => {
  const { assistant, client } = buildAssistant([], { configured: false });
  const result = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: true });
  assert.equal(result.harnessStatus, "unconfigured");
  assert.equal(result.code, "HARNESS_UNCONFIGURED");
  assert.equal(result.authority, "deterministic-tools");
  assert.equal(client.calls.length, 0);
});

test("agent loop: scripted model runs assess_draft then explains; citations carry the fingerprint", async () => {
  const toolCallTurn = {
    message: { tool_calls: [{ id: "c1", function: { name: "assess_draft", arguments: JSON.stringify({ draft: getPresetV021("healthy") }) } }] }
  };
  const finalTurn = { message: { content: "The healthy fixture assesses to Grade A with TAI 93.8 and CCI 929." } };
  const { assistant } = buildAssistant([toolCallTurn, finalTurn]);
  const result = await assistant.askRisk({ prompt: "评估这个 healthy 示例", modelConsent: true, sessionId: "sess-loop-1" });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "ok");
  assert.equal(result.steps, 1, "steps counts tool rounds; the final answer closes the loop");
  assert.equal(result.toolCalls[0].name, "assess_draft");
  assert.equal(result.toolCalls[0].result.authoritative.CCI, 929);
  assert.equal(result.citations.length, 1);
  assert.match(result.citations[0].assessmentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.citations[0].tool, "assess_draft");
  assert.match(result.answer, /Grade A/);
});

test("session memory: the follow-up prompt includes prior turns, never tool payloads", async () => {
  const first = [
    { message: { tool_calls: [{ id: "c1", function: { name: "assess_draft", arguments: JSON.stringify({ draft: getPresetV021("healthy") }) } }] } },
    { message: { content: "Grade A answer" } }
  ];
  const second = [{ message: { content: "Follow-up answer" } }];
  const { assistant, client } = buildAssistant([...first, ...second]);
  await assistant.askRisk({ prompt: "评估 healthy 示例", modelConsent: true, sessionId: "sess-mem-1" });
  const before = client.calls.length;
  await assistant.askRisk({ prompt: "换个角度再解释一次", modelConsent: true, sessionId: "sess-mem-1" });
  const messages = client.calls[before].messages;
  assert.equal(messages[0].role, "system");
  assert.ok(messages.some(message => message.role === "assistant" && message.content === "Grade A answer"));
  assert.ok(!messages.some(message => JSON.stringify(message).includes("assessmentFingerprint")), "tool payloads never enter memory");
});

test("unknown tool is refused and the loop continues to a final answer", async () => {
  const scenarios = [
    { message: { tool_calls: [{ id: "c1", function: { name: "place_order", arguments: "{}" } }] } },
    { message: { content: "I cannot do that; only deterministic tools are available." } }
  ];
  const { assistant } = buildAssistant(scenarios);
  const result = await assistant.askRisk({ prompt: "帮我下单", modelConsent: true });
  assert.equal(result.ok, true);
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[0].error.code, "TOOL_NOT_IN_REGISTRY");
  assert.match(result.answer, /only deterministic tools/);
});

test("model failure degrades to the deterministic pipeline answer with partial tool trail", async () => {
  const boom = Object.assign(new Error("upstream 500"), { code: "MODEL_HTTP_ERROR" });
  const toolCallTurn = {
    message: { tool_calls: [{ id: "c1", function: { name: "extract_from_text", arguments: JSON.stringify({ text: "月收入 100000 美元" }) } }] }
  };
  const { assistant } = buildAssistant([toolCallTurn, { throw: boom }, { throw: boom }]);
  const result = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: true });
  assert.equal(result.ok, true);
  assert.equal(result.harnessStatus, "unavailable");
  assert.equal(result.code, "MODEL_HTTP_ERROR");
  assert.equal(result.toolCalls[0].name, "extract_from_text");
  assert.equal(result.toolCalls[1].name, "extract_from_text", "deterministic fallback appends the pipeline trail");
  assert.equal(result.toolCalls[1].result.matchedFields.length, 9);
});

test("empty model answer degrades to the deterministic pipeline", async () => {
  const { assistant } = buildAssistant([{ message: { content: "   " } }]);
  const result = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: true });
  assert.equal(result.harnessStatus, "unavailable");
  assert.equal(result.code, "MODEL_EMPTY_ANSWER");
  assert.match(result.answer, /初步风险评估/);
});

test("max steps truncation falls back after the frozen budget", async () => {
  const toolCallTurn = {
    message: { tool_calls: [{ id: "c", function: { name: "validate_draft", arguments: JSON.stringify({ draft: {} }) } }] }
  };
  const scenarios = Array.from({ length: MAX_STEPS_RISK + 1 }, () => toolCallTurn);
  const { assistant } = buildAssistant(scenarios);
  const result = await assistant.askRisk({ prompt: "反复校验", modelConsent: true });
  assert.equal(result.harnessStatus, "max-steps-reached");
  assert.equal(result.code, "MAX_STEPS_EXCEEDED");
  assert.equal(result.toolCalls.filter(call => call.name === "validate_draft").length, MAX_STEPS_RISK);
});

test("what_if reaches the loop and changes the numbers via the tool only", async () => {
  const scenarios = [
    { message: { tool_calls: [{ id: "c1", function: { name: "what_if", arguments: JSON.stringify({ draft: getPresetV021("healthy"), overrides: { repaymentRatePct: 90 } }) } }] } },
    { message: { content: "After the change, CCI is 914 instead of 929." } }
  ];
  const { assistant } = buildAssistant(scenarios);
  const result = await assistant.askRisk({ prompt: "如果回款率降到 90% 会怎样？", modelConsent: true });
  assert.equal(result.toolCalls[0].result.baseline.CCI, 929);
  assert.equal(result.toolCalls[0].result.after.CCI, 914);
  assert.equal(result.citations.length, 1);
});

test("assess_prompt args.text is overridden with the raw user prompt (echo fidelity is not trusted)", async () => {
  const fullPrompt = JSON.stringify({
    taskType: "inference", gpuModel: "h100-equivalent",
    periodStart: "2026-08-01", periodEnd: "2026-08-31",
    inputTokensM: 64, outputTokensM: 16, validRatePct: 94,
    gpuHours: 4200, revenueUsd: 100000, computeSpendUsd: 58000,
    repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36,
    operatingHistoryDays: 720, dataCoveragePct: 100,
    monthlySeries: [
      { period: "2026-03", rawTokensM: 72, validRatePct: 92, revenueUsd: 94000, computeSpendUsd: 55000 },
      { period: "2026-04", rawTokensM: 75, validRatePct: 93, revenueUsd: 96000, computeSpendUsd: 56000 },
      { period: "2026-05", rawTokensM: 77, validRatePct: 93, revenueUsd: 97000, computeSpendUsd: 56500 },
      { period: "2026-06", rawTokensM: 79, validRatePct: 94, revenueUsd: 99000, computeSpendUsd: 57500 },
      { period: "2026-07", rawTokensM: 81, validRatePct: 94, revenueUsd: 101000, computeSpendUsd: 59000 },
      { period: "2026-08", rawTokensM: 80, validRatePct: 94, revenueUsd: 100000, computeSpendUsd: 58000 }
    ],
    R: [64, 65, 63, 67, 68, 66, 70, 71],
    C: [62, 63, 62, 65, 66, 65, 68, 69]
  });
  const scenarios = [
    { message: { tool_calls: [{ id: "c1", function: { name: "assess_prompt", arguments: JSON.stringify({ text: '{"taskType":"inference"}' }) } }] } },
    { message: { content: "Assessment complete." } }
  ];
  const { assistant } = buildAssistant(scenarios);
  const result = await assistant.askRisk({ prompt: fullPrompt, modelConsent: true });
  const assess = result.toolCalls[0].result;
  assert.equal(assess.assessed, true);
  assert.equal(assess.matchedFields.length, 19, "server injected the FULL raw prompt; R/C arrays survive");
  assert.equal(assess.authoritative.CCI, 929);
  assert.equal(assess.authoritative.riskGrade, "A");
});

test("replay determinism: identical prompt + transport gives identical fingerprints and answer", async () => {
  function run() {
    const toolCallTurn = {
      message: { tool_calls: [{ id: "c1", function: { name: "assess_draft", arguments: JSON.stringify({ draft: getPresetV021("healthy") }) } }] }
    };
    const finalTurn = { message: { content: "Deterministic explanation" } };
    const { assistant } = buildAssistant([toolCallTurn, finalTurn]);
    return assistant.askRisk({ prompt: "评估 healthy", modelConsent: true });
  }
  const first = await run();
  const second = await run();
  assert.equal(first.answer, second.answer);
  assert.equal(first.citations[0].assessmentFingerprint, second.citations[0].assessmentFingerprint);
});

test("stream path emits delta/tool/done with identical authority semantics", async () => {
  const scenarios = [
    { delta: "Let me assess the fixture.", message: { tool_calls: [{ id: "c1", function: { name: "assess_draft", arguments: JSON.stringify({ draft: getPresetV021("healthy") }) } }] } },
    { message: { content: "Grade A" } }
  ];
  const { assistant } = buildAssistant(scenarios);
  const events = [];
  const result = await assistant.askRiskStream({ prompt: "评估 healthy", modelConsent: true, sessionId: "sess-stream-1", onEvent: event => events.push(event) });
  assert.deepEqual(events.map(event => event.type), ["thinking", "delta", "reset", "tool", "done"]);
  assert.equal(events[0].text.startsWith("[route] modelConsent=true"), true, "the deterministic route is disclosed first");
  assert.equal(events.at(-1).result.ok, true);
  assert.equal(result.toolCalls[0].result.authoritative.CCI, 929);
});

test("system prompt keeps the engineered routing, boundary and language rules", () => {
  for (const directive of [
    "call lookup_public_company FIRST with the name or ticker",
    "call assess_public_company (SEC facts → capital-structure overlay)",
    "call build_research_panel, then factor_report",
    "then build_scoring_model with that panelId",
    "never claim the weights are live",
    "RESEARCH OUTPUT stays compact",
        "下一步补充（最多 3 项）",
    "copy-paste example in the user's language","call assess_prompt ONCE with the raw user text",
    "Never pre-extract or pre-validate first",
    "never retype arrays or figures from memory",
    "validate_draft alone; do not run an assessment",
    "Never output PD, expected loss, credit limit or approval decisions",
    "If it contains ANY Chinese characters, reply in Chinese",
    "Pure-JSON input defaults to Chinese"
  ]) {
    assert.ok(SYSTEM_PROMPT_RISK.includes(directive), `system prompt lost directive: ${directive}`);
  }
});

test("invalid prompt is rejected before any gate", async () => {
  const { assistant, client } = buildAssistant([]);
  const result = await assistant.askRisk({ prompt: "   ", modelConsent: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_PROMPT");
  assert.equal(client.calls.length, 0);
});

test("finish_reason=length marks the answer as truncated with a visible note", async () => {
  const { assistant } = buildAssistant([
    { message: { role: "assistant", content: "半句结论（模型输出达到上限" }, finishReason: "length" }
  ]);
  const result = await assistant.askRisk({ prompt: OFFICIAL_CN, modelConsent: true });
  assert.equal(result.truncated, true);
  assert.match(result.answer, /已截断/);
  assert.match(result.answer, /半句结论/);
});

test("reasoning_content streams as thinking events and attaches to the result", async () => {
  const { assistant } = buildAssistant([
    { thinking: "先看杠杆与覆盖，再看集中度", message: { role: "assistant", content: "结论：观察。" }, finishReason: "stop" }
  ]);
  const events = [];
  const result = await assistant.askRiskStream({ prompt: OFFICIAL_CN, modelConsent: true, onEvent: e => events.push(e) });
  assert.match(result.reasoning, /\[route\] modelConsent=true/);
  assert.match(result.reasoning, /先看杠杆与覆盖，再看集中度/);
  assert.ok(events.some(e => e.type === "thinking" && e.text === "先看杠杆与覆盖，再看集中度"));
  assert.equal(events.filter(e => e.type === "done").length, 1);
  assert.equal(events[0].type, "thinking", "thinking precedes the answer stream");
});

test("async lookup_public_company tool runs inside the loop and its facts reach the answer", async () => {
  const secEdgar = {
    lookupPublicCompany: async ({ query }) => ({
      ok: true,
      company: { name: "CoreWeave, Inc.", ticker: "CRWV", cik: 1769628 },
      facts: [{ field: "revenueUsd", label: "Revenue", value: 3661000000, unit: "USD", periodEnd: "2026-09-30", form: "10-Q", filed: "2026-11-05", sourceUrl: "https://data.sec.gov/x" }],
      missing: ["Gross profit"],
      sources: [{ url: "https://data.sec.gov/x", retrievedAt: "2026-11-18T00:00:00.000Z", sha256: "a".repeat(64) }],
      note: "documented"
    })
  };
  const { assistant, client } = buildAssistant([
    { message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup_public_company", arguments: '{"query":"CRWV"}' } }] } },
    { message: { role: "assistant", content: "SEC 10-Q：季度收入 36.61 亿美元（2026-09-30 申报）。" }, finishReason: "stop" }
  ], { secEdgar });
  const result = await assistant.askRisk({ prompt: "CoreWeave 的公开收入是多少？", modelConsent: true });
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "lookup_public_company");
  assert.equal(result.toolCalls[0].result.company.ticker, "CRWV");
  assert.equal(result.toolCalls[0].result.facts[0].value, 3661000000);
  assert.match(result.answer, /36\.61/);
});

test("session draft carry merges follow-up supplements into the first-turn draft", async () => {
  const healthyText = JSON.stringify(getPresetV021("healthy"));
  const scenariosTurn1 = [
    { message: { tool_calls: [{ id: "c1", function: { name: "assess_prompt", arguments: JSON.stringify({ text: healthyText }) } }] } },
    { message: { content: "第一轮评估完成。" }, finishReason: "stop" }
  ];
  const scenariosTurn2 = [
    // 模型传了一个伪造的 carryDraft —— 服务端注入必须覆盖它
    { message: { tool_calls: [{ id: "c2", function: { name: "assess_prompt", arguments: JSON.stringify({ text: "补充：本月输入 token 64M、输出 token 16M、有效率 94%。", carryDraft: { label: "FAKE" } }) } }] } },
    { message: { content: "第二轮合并重评完成。" }, finishReason: "stop" }
  ];
  const { assistant } = buildAssistant([...scenariosTurn1, ...scenariosTurn2]);
  const sessionId = "sess-carry-1";
  const first = await assistant.askRisk({ prompt: healthyText, modelConsent: true, sessionId });
  assert.equal(first.toolCalls[0].result.authoritative.CCI, 929);

  const second = await assistant.askRisk({ prompt: "补充：本月输入 token 64M、输出 token 16M、有效率 94%。", modelConsent: true, sessionId });
  assert.equal(second.toolCalls[0].ok, true);
  assert.equal(second.toolCalls[0].result.authoritative.CCI, 929, "carried draft must survive the follow-up turn");
  assert.equal(second.toolCalls[0].result.merged.label, "Healthy Merchant", "server-carried draft wins over a model-fabricated carryDraft");
  assert.equal(second.toolCalls[0].result.merged.inputTokensM, 64, "new text fields override the carried draft");
});

test("attach_evidence persists the attested draft into the session for follow-up turns", async () => {
  const pack = JSON.stringify({
    version: "evidence-pack/v0.1", asOf: "2026-08-31T00:00:00Z",
    sourceDomain: "billing", coveragePct: 98,
    fields: { repaymentRatePct: 96, overdue30Pct: 2 }
  });
  const { assistant } = buildAssistant([
    { message: { tool_calls: [{ id: "c1", function: { name: "attach_evidence", arguments: JSON.stringify({ draft: getPresetV021("healthy"), pack }) } }] } },
    { message: { content: "证据已接入。" }, finishReason: "stop" },
    { message: { tool_calls: [{ id: "c2", function: { name: "assess_prompt", arguments: JSON.stringify({ text: "补充：本月输入 token 64M、输出 token 16M。" }) } }] } },
    { message: { content: "已合并重评。" }, finishReason: "stop" }
  ]);
  const sessionId = "sess-evidence-carry-1";
  const first = await assistant.askRisk({ prompt: "这是我们的账单导出证据包，请接入", modelConsent: true, sessionId });
  assert.equal(first.toolCalls[0].name, "attach_evidence");
  assert.equal(first.toolCalls[0].result.attached, true);

  const second = await assistant.askRisk({ prompt: "补充：本月输入 token 64M、输出 token 16M。", modelConsent: true, sessionId });
  const merged = second.toolCalls[0].result.merged;
  assert.equal(merged.repaymentRatePct, 96, "evidence-carried draft must survive into the follow-up turn");
  assert.equal(merged.inputTokensM, 64, "new text fields still override the carried draft");
  const attested = merged.evidence.filter(record => record.attestation?.connector === "evidence-pack-v1");
  assert.equal(attested.length, 2, "attested evidence must survive into the session draft");
});
