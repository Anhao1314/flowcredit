import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildChatPresentation, buildChatUserMessage } from "../src/chat-response-v02.js";

const draft = {
  taskType: "inference", gpuModel: "h100-equivalent", gpuHours: 4200, revenueUsd: 100000,
  computeSpendUsd: 58000, repaymentRatePct: 96, overdue30Pct: 2, payingCustomers: 168, top5ConcentrationPct: 36
};
const assessment = {
  dimensionScores: { customer: 89.9, repayment: 94.3 }, readinessStatus: "limited",
  decisionStatus: "insufficient-evidence", evidenceStrength: "low"
};
const missingByGroup = {
  Scope: ["periodStart", "periodEnd"], "Token activity": ["inputTokensM", "outputTokensM", "validRatePct"],
  "History and cross-check": ["monthlySeries", "dataCoveragePct", "R", "C"]
};
const requiredActions = [{ category: "evidence", fields: ["revenueUsd"], priority: 3 }];
const input = () => structuredClone({ extractedDraft: draft, assessment, missingByGroup, requiredActions });

test("official case becomes a Chinese report with only supplied facts and runtime scores", () => {
  const message = buildChatUserMessage(input());
  for (const value of ["FlowCredit 初步风险评估", "H100", "4,200", "100,000", "58,000", "96%", "2%", "168", "36%", "客户结构：89.9", "偿付表现：94.3", "暂不可计算", "Limited", "Low", "评估主体和评估周期", "Token 使用量和有效率", "历史经营、数据覆盖和交叉验证信息", "来源证据"]) {
    assert.ok(message.includes(value), `missing ${value}`);
  }
  assert.match(message, /信息或证据不足.*需要补充数据或证据/);
  assert.match(message, /不会自行补全或编造/);
  assert.match(message, /基于当前已提供、尚未充分核验的数据，可计算的局部维度：/);
  assert.match(message, /以上为局部计算值，不代表完整风险评级。/);
  assert.doesNotMatch(message, /monthlySeries|validRatePct|deepseek/i);
  assert.deepEqual(buildChatPresentation(input()).availableScores, assessment.dimensionScores);
});

test("verification qualification uses only the explicit low/insufficient context and leaves structured values unchanged", () => {
  for (const [evidenceStrength, decisionStatus, qualified] of [
    ["low", "insufficient-evidence", true],
    ["high", "insufficient-evidence", false],
    ["low", "enhanced-review", false],
    [undefined, undefined, false]
  ]) {
    const value = input();
    Object.assign(value.assessment, { evidenceStrength, decisionStatus });
    const before = structuredClone(value);
    const presentationBefore = buildChatPresentation(value);
    const message = buildChatUserMessage(value);
    assert.equal(message.includes("尚未充分核验"), qualified);
    assert.match(message, /局部维度/);
    assert.match(message, /不代表完整风险评级/);
    assert.match(message, /客户结构：89\.9/);
    assert.match(message, /偿付表现：94\.3/);
    assert.deepEqual(value, before);
    assert.deepEqual(buildChatPresentation(value), presentationBefore);
    assert.deepEqual(presentationBefore.availableScores, { customer: 89.9, repayment: 94.3 });
  }
});

test("missing extracted fields are omitted; real zero and decimal values are preserved", () => {
  const value = input();
  delete value.extractedDraft.gpuHours;
  assert.doesNotMatch(buildChatUserMessage(value), /GPU 使用量/);
  value.extractedDraft.gpuHours = 0;
  value.extractedDraft.revenueUsd = 123456.789;
  assert.match(buildChatUserMessage(value), /GPU 使用量：0 小时/);
  assert.match(buildChatUserMessage(value), /收入：123,456\.789 美元/);
  assert.doesNotMatch(buildChatUserMessage({}), /已识别|未知|undefined|null/);
});

test("missing and invalid dimensions are omitted, never replaced with zero", () => {
  const value = input();
  value.assessment.dimensionScores = { repayment: 94.3, customer: null, economics: NaN, continuity: Infinity };
  const message = buildChatUserMessage(value);
  assert.doesNotMatch(message, /客户结构|经营经济性|经营连续性/);
  assert.deepEqual(buildChatPresentation(value).availableScores, { repayment: 94.3 });
  value.assessment.dimensionScores = { customer: 0 };
  assert.match(buildChatUserMessage(value), /客户结构：0/);
});

test("complete and partial full scores display runtime originals without grading or rounding", () => {
  const value = { assessment: { TAI: 93.812, CCI: 929, riskGrade: "A", readinessStatus: "ready", decisionStatus: "enhanced-review" } };
  const message = buildChatUserMessage(value);
  assert.match(message, /TAI：93\.812/);
  assert.match(message, /CCI：929/);
  assert.match(message, /Risk Grade：A/);
  assert.doesNotMatch(message, /暂不可计算|授信通过|批准贷款/);
  assert.deepEqual(buildChatPresentation(value).fullScores, { TAI: 93.812, CCI: 929, riskGrade: "A" });
  delete value.assessment.CCI;
  assert.match(buildChatUserMessage(value), /暂不可计算/);
  assert.doesNotMatch(buildChatUserMessage(value), /CCI：/);
  assert.match(buildChatUserMessage({ assessment: { TAI: 0, CCI: 0, riskGrade: "E" } }), /CCI：0/);
});

test("computed scores do not override an insufficient-evidence decision", () => {
  const value = input();
  Object.assign(value.assessment, { TAI: 93.8, CCI: 929, riskGrade: "A" });
  assert.match(buildChatUserMessage(value), /信息或证据不足.*需要补充数据或证据/);
  assert.equal(buildChatPresentation(value).decisionStatus, "insufficient-evidence");
});

test("formatter never promotes draft scores, evidence or legacy model metadata", () => {
  const value = input();
  Object.assign(value.extractedDraft, { TAI: 99, CCI: 999, riskGrade: "A", evidence: [{ verified: true }], dimensionScores: { economics: 100 } });
  Object.assign(value.assessment, { TAI: null, CCI: NaN, riskGrade: null, model: "deepseek-v4-flash", harnessStatus: "not-requested" });
  const presentation = buildChatPresentation(value);
  assert.equal(Object.hasOwn(presentation, "fullScores"), false);
  assert.deepEqual(presentation.availableScores, assessment.dimensionScores);
  assert.equal(Object.hasOwn(presentation, "evidence"), false);
  assert.doesNotMatch(JSON.stringify(presentation), /deepseek|verified|economics|999/i);
  assert.doesNotMatch(buildChatUserMessage(value), /^- (?:TAI|CCI|Risk Grade)：|deepseek/im);
  // Missing actions cannot be manufactured from a low evidence label alone.
  assert.deepEqual(buildChatPresentation({ assessment: { evidenceStrength: "low" } }).nextSteps, []);
});

test("pure deterministic formatter leaves deeply frozen runtime inputs unchanged", () => {
  const value = input();
  const before = structuredClone(value);
  function freeze(object) { for (const child of Object.values(object)) if (child && typeof child === "object") freeze(child); return Object.freeze(object); }
  freeze(value);
  assert.equal(buildChatUserMessage(value), buildChatUserMessage(value));
  const presentation = buildChatPresentation(value);
  presentation.availableScores.customer = 1;
  assert.deepEqual(value, before);
});

test("presentation module has no runtime, parser, network or model dependencies", async () => {
  const source = await readFile(new URL("../src/chat-response-v02.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bimport\s|\brequire\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bprocess\./);
});
