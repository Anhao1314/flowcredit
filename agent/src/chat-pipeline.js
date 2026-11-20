/*
 * chat-pipeline.js — 确定性对话管线（/api/v1/chat 与 risk-agent 降级路径的单一来源）。
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 本路径永不触达模型提供方：评分、readiness、decision 只属于确定性 runtime。
 *   2. 解析器是非权威的：只映射文本/JSON 明确陈述的白名单字段，绝不插值、估算或补全。
 *   3. 用户文本是不可信数据——永不被当作指令执行。
 */
import { PRODUCT_VERSION_V03, INTAKE_SCHEMA_V03, sanitizeExtractedDraftV03 } from "./intake-v03.js";
import { NL_DRAFT_PARSER_VERSION, NL_DRAFT_FIELDS, extractNaturalLanguageDraft } from "./nl-draft-v01.js";
import { buildChatPresentation, buildChatUserMessage, buildChatUserMessageEnglish } from "./chat-response-v02.js";
import { withTimeout } from "./assessment-service.js";

const CHAT_REQUEST_FIELDS = Object.freeze(["prompt", "sessionId"]);
const CHAT_PROMPT_MAX_CHARS = INTAKE_SCHEMA_V03.maxTextLength;

export function validateChatRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: [{ path: "/", keyword: "type", message: "Request body must be a JSON object." }] };
  }
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!CHAT_REQUEST_FIELDS.includes(key)) errors.push({ path: `/${key}`, keyword: "additionalProperties", message: "must NOT have additional properties" });
  }
  const prompt = value.prompt;
  if (prompt === undefined) errors.push({ path: "/prompt", keyword: "required", message: "must have required property 'prompt'" });
  else if (typeof prompt !== "string") errors.push({ path: "/prompt", keyword: "type", message: "must be string" });
  else if (!prompt.trim()) errors.push({ path: "/prompt", keyword: "minLength", message: "must not be empty or whitespace only" });
  else if (prompt.length > CHAT_PROMPT_MAX_CHARS) errors.push({ path: "/prompt", keyword: "maxLength", message: `must NOT have more than ${CHAT_PROMPT_MAX_CHARS} characters` });
  const sessionId = value.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 80)) {
    errors.push({ path: "/sessionId", keyword: "type", message: "must be a non-empty string of at most 80 characters" });
  }
  return errors.length ? { valid: false, errors } : { valid: true, prompt: prompt.trim(), sessionId: typeof sessionId === "string" ? sessionId.trim() : null };
}

const CHAT_JSON_EXAMPLE = JSON.stringify({
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

export function isHelpIntent(prompt) {
  const text = String(prompt || "").trim();
  if (!text || text.length > 160) return false;
  if (/R\s*(?:和|and|&)\s*C|怎么给|怎么填|什么意思|what\s+(?:is|are)\s+(?:R|C)\b|how\s+(?:do\s+i|to)\s+(?:provide|give)/i.test(text)) return true;
  if (/\d/.test(text) || /评估|风险|assess|risk|revenue|收入|逾期|回款|现金流/i.test(text)) return false;
  return /^(?:你好|您好|hi|hello|hey|help)\b/i.test(text)
    || /你能做什么|你会什么|怎么用|如何使用|what can you do|how does this work|what is this/i.test(text);
}

function isInferenceContext(prompt, draft) {
  if (draft.taskType === "inference" || draft.gpuModel || draft.gpuHours != null || draft.inputTokensM != null) return true;
  return /\bAI\b|推理|inference|大模型|GPU|token|算力/i.test(prompt);
}

function helpMessage(english) {
  const fields = NL_DRAFT_FIELDS.join(", ");
  if (english) {
    return [
      "FlowCredit assesses AI inference / GPU compute operators as counterparties. The intake is deterministic: no model call, no invented values.",
      "",
      "Send either a plain-language description or a JSON object with exact keys.",
      `JSON example: ${CHAT_JSON_EXAMPLE}`,
      "",
      `Supported keys: ${fields}.`,
      "R and C are declared vs credible monthly activity series: same length (at least 6), same units, used for deviation and volatility.",
      "draftId identifies one invocation. To continue a conversation, send the same sessionId back; draftId is not a resume handle.",
      "Missing fields are reported, never estimated. Data you provide is declared/self-reported; this alpha cannot independently verify it.",
      "Outside AI inference / GPU compute operators? This intake cannot represent that business yet."
    ].join("\n");
  }
  return [
    "FlowCredit 评估 AI 推理 / GPU 算力运营商的交易对手风险。intake 是确定性的：不调用模型、不编造缺失值。",
    "",
    "你可以直接描述业务，或发送一个使用精确字段名的 JSON 对象。",
    `JSON 示例：${CHAT_JSON_EXAMPLE}`,
    "",
    `支持的字段：${fields}。`,
    "R / C 是申报 vs 可信的月度活动序列：两者等长（至少 6 期）、同单位，用于偏离和波动计算。",
    "draftId 标识单次调用。要继续对话，请回传同一个 sessionId；draftId 不是续传句柄。",
    "缺失字段会如实列出，绝不估算。你提供的数据属于申报/自报口径，本 alpha 无法独立核验。",
    "如果你的业务不是 AI 推理 / GPU 算力运营商，当前 intake 无法表达，请勿强行套用模板。"
  ].join("\n");
}

function scopeMessage(english, extraction) {
  const found = extraction.matchedFields.length
    ? `已识别 ${extraction.matchedFields.length} 个字段（${extraction.matchedFields.join(", ")}），但业务类型不在评估范围。`
    : "没有识别到可评估的 AI 推理业务字段。";
  if (english) {
    return [
      "This agent only assesses AI inference / GPU compute operators. The business you described is outside the current intake schema, so I will not force it into a template or invent fields.",
      "If this is an AI inference operator, send GPU/token/revenue facts or a JSON object with exact keys. Reply \"help\" for the supported field list and template."
    ].join("\n");
  }
  return [
    "FlowCredit 目前只评估 AI 推理 / GPU 算力运营商。你描述的业务不在当前 intake schema 内，我不会把它硬套进模板或编造字段。",
    found,
    "如果这是 AI 推理服务商，请提供 GPU/Token/收入等事实，或发送使用精确字段名的 JSON 对象。发送“help”可查看支持的字段和模板。"
  ].join("\n");
}

export function looksOutOfScope(prompt) {
  return /arweave|storage|存储|protocol|协议|saas|e-?commerce|电商|marketplace|advertis|广告|bank|银行|lending|借贷|game|游戏|defi|nft/i.test(prompt);
}

function buildChatGuidance(prompt, extraction) {
  const english = !/[\u4e00-\u9fff]/.test(prompt);
  if (isHelpIntent(prompt)) return { status: "help", message: helpMessage(english) };
  if (!isInferenceContext(prompt, extraction.draft)) {
    if (looksOutOfScope(prompt)) return { status: "unsupported-scope", message: scopeMessage(english, extraction) };
    if (prompt.trim().length < 20 && !/\d/.test(prompt)) return { status: "help", message: helpMessage(english) };
    return null;
  }
  return null;
}

/**
 * deps:
 *   sessions            SessionStore（chat:${sessionId} 草稿续传 + v03 会话由 assess 服务写）
 *   assess              assessmentService.assess(body, requestId)
 *   invocationTimeoutMs 调用超时预算
 */
export function createChatPipeline({ sessions, assess, invocationTimeoutMs }) {
  async function buildChatPayload(body, requestId) {
    const request = validateChatRequest(body);
    if (!request.valid) {
      return { status: 400, body: { errorCode: "INVALID_INPUT", error: "Request does not match the FlowCredit chat input schema.", errorDetails: request.errors } };
    }
    const extraction = extractNaturalLanguageDraft(request.prompt);
    const draftId = `nl-${requestId}`;
    const jsonError = extraction.warnings.find(warning => /JSON input could not be parsed|JSON object contained no supported intake fields/.test(warning));
    if (jsonError) {
      const english = !/[\u4e00-\u9fff]/.test(request.prompt);
      const answer = english
        ? `${jsonError}\nSend "help" for a complete JSON template with exact intake keys.`
        : `${jsonError}\n发送“help”可查看使用精确字段名的完整 JSON 模板。`;
      return { status: 200, body: {
        status: "invalid-input", message: answer, answer,
        parserVersion: NL_DRAFT_PARSER_VERSION, draftId,
        extractedDraft: extraction.draft, parsedFields: extraction.matchedFields, parserWarnings: extraction.warnings,
        missingInputs: [], missingByGroup: {}, requiredActions: [], fieldErrors: [],
        assessment: null, sessionId: request.sessionId || null
      } };
    }
    const sessionKey = request.sessionId ? `chat:${request.sessionId}` : null;
    const carried = sessionKey ? sessions.get(sessionKey) : null;
    const combinedDraft = { ...(carried && carried.draft ? carried.draft : {}), ...extraction.draft };
    const guidance = buildChatGuidance(request.prompt, { ...extraction, draft: combinedDraft });
    if (guidance) {
      return { status: 200, body: {
        status: guidance.status, message: guidance.message, answer: guidance.message,
        presentation: { kind: guidance.status, supportedFields: NL_DRAFT_FIELDS.slice() },
        parserVersion: NL_DRAFT_PARSER_VERSION, draftId,
        extractedDraft: extraction.draft, parsedFields: extraction.matchedFields, parserWarnings: extraction.warnings,
        missingInputs: [], missingByGroup: {}, requiredActions: [],
        assessment: null, sessionId: request.sessionId || null
      } };
    }
    const effectiveDraft = sanitizeExtractedDraftV03(combinedDraft).draft;
    const assessment = await withTimeout(
      assess({ draft: effectiveDraft, draftId, modelConsent: false }, requestId),
      invocationTimeoutMs
    );
    if (assessment.status !== 200) {
      const details = assessment.body?.error?.details || assessment.body?.fieldErrors || [];
      if (assessment.status === 400 && Array.isArray(details) && details.length) {
        const english = !/[\u4e00-\u9fff]/.test(request.prompt);
        const lines = details.map(item => `${item.field || "input"}: ${item.message || "invalid"}`);
        const answer = english
          ? [
              "The intake rejected these fields:",
              ...lines.map(line => `- ${line}`),
              "",
              "periodStart/periodEnd must cover one natural month or a rolling 27–31 day window. Send \"help\" for a complete template."
            ].join("\n")
          : [
              "输入未通过 intake 校验：",
              ...lines.map(line => `- ${line}`),
              "",
              "periodStart/periodEnd 必须是一个自然月，或 27–31 天的滚动窗口。发送“help”查看完整模板。"
            ].join("\n");
        return { status: 200, body: {
          status: "invalid-input", message: answer, answer,
          parserVersion: NL_DRAFT_PARSER_VERSION, draftId,
          extractedDraft: extraction.draft, parsedFields: extraction.matchedFields, parserWarnings: extraction.warnings,
          missingInputs: [], missingByGroup: {}, requiredActions: [], fieldErrors: details,
          assessment: null, sessionId: request.sessionId || null
        } };
      }
      return { status: assessment.status, body: { ...assessment.body, draftId, extractedDraft: extraction.draft, parserVersion: NL_DRAFT_PARSER_VERSION } };
    }
    const result = assessment.body;
    if (sessionKey) sessions.set(sessionKey, { draft: combinedDraft });
    const status = result.decisionStatus === "insufficient-evidence" ? "insufficient-evidence" : "assessed";
    const presentationInput = {
      extractedDraft: extraction.draft, assessment: result,
      missingByGroup: result.missingByGroup, requiredActions: result.requiredActions
    };
    const english = !/[\u4e00-\u9fff]/.test(request.prompt);
    let message = english ? buildChatUserMessageEnglish(presentationInput) : buildChatUserMessage(presentationInput);
    if (extraction.warnings.length) {
      const notes = [...new Set(extraction.warnings)].map(warning => `- ${warning}`).join("\n");
      message += english ? `\n\nParser notes:\n${notes}` : `\n\n解析提示：\n${notes}`;
    }
    const data = {
      status, message, answer: message, presentation: buildChatPresentation(presentationInput),
      parserVersion: NL_DRAFT_PARSER_VERSION, draftId,
      extractedDraft: extraction.draft, parsedFields: extraction.matchedFields, parserWarnings: extraction.warnings,
      assessment: result,
      readinessStatus: result.readinessStatus, decisionStatus: result.decisionStatus,
      TAI: result.TAI, CCI: result.CCI, riskGrade: result.riskGrade, verdict: result.verdict,
      evidenceStrength: result.evidenceStrength, suggestedCreditBand: result.suggestedCreditBand,
      missingInputs: result.missingInputs, missingByGroup: result.missingByGroup, requiredActions: result.requiredActions,
      sessionId: request.sessionId || result.sessionId, assessmentId: result.assessmentId
    };
    return { status: 200, body: data };
  }

  return { buildChatPayload, validateChatRequest };
}
