/*
 * assessment-service.js — 确定性风险评估服务（buildV03Assessment 的单一来源）。
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 不读环境、不建 HTTP、不持有模块级可变状态——全部依赖由 createAssessmentService 注入。
 *   2. 模型层（HarnessBrain）只在 useModel=true 时触达；失败永远降级为注记缺失，绝不阻塞确定性结果。
 *   3. 权威字段（TAI/CCI/grade/decision）只来自 computeRiskV021；模型输出只能出现在注记层。
 */
import { MODEL } from "./constants.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021 } from "./risk-core-v021.js";
import { PRODUCT_VERSION_V03, buildEvidenceCoverageV03, buildRequiredActionsV03, validateDraftV03 } from "./intake-v03.js";
import { summarizeEvidenceStatus } from "./evidence-status.js";
import { addFinchIdentity, deterministicFingerprintPayload, finchAssessmentFingerprint, finchInputFingerprint } from "./finch-contract.js";

import { withTimeout as raceTimeout } from "../core/http-util.js";

/** 超时竞速（消息措辞属于本服务的对外语义；实现共享 core/http-util）。 */
export function withTimeout(promise, timeoutMs, code = "INVOCATION_TIMEOUT") {
  return raceTimeout(promise, timeoutMs, code, code === "MODEL_TIMEOUT" ? "Model review timed out." : "Assessment invocation timed out.");
}

function factsForV021(data, result) {
  return [
    `F1 window=${data.periodStart ?? "missing"}..${data.periodEnd ?? "missing"}, normalizationProfile=${data.normalizationProfileId ?? "missing"}`,
    `F2 rawTokensM=${result.tokenMetrics.meteredRawTokensM ?? "not-computable"}, inputTokensM=${data.inputTokensM ?? "missing"}, outputTokensM=${data.outputTokensM ?? "missing"}`,
    `F3 normalizedTokensM=${result.tokenMetrics.normalizedTokensM ?? "not-computable"}`,
    `F4 validRatePct=${result.tokenMetrics.validRatePct ?? "not-computable"}, validNT_M=${result.tokenMetrics.validNT_M ?? "not-computable"}`,
    `F5 validEfficiency=${result.tokenMetrics.validEfficiency_NT_per_GPUh ?? "not-computable"}, peer=${data.peerProfileId ?? "missing"}`,
    `F6 revenuePerValidNTM=${result.tokenMetrics.revenuePerValidNTM ?? "not-computable"}, computeSpendPerValidNTM=${result.tokenMetrics.computeSpendPerValidNTM ?? "not-computable"}`,
    `F7 tokenVolatilityPct=${result.tokenMetrics.tokenVolatilityPct ?? "not-computable"}, tokenRevenueCorrelation=${result.tokenMetrics.tokenRevenueCorrelation ?? "not-computable"}`,
    `F8 TAI=${result.TAI ?? "not-computable"}, tokenActivityBand=${result.tokenActivityBand ?? "not-computable"}, meteringStatus=${result.tokenMeteringStatus}`,
    `F9 CCI=${result.CCI ?? "not-computable"}, riskGrade=${result.riskGrade ?? "not-computable"}`,
    `F10 repaymentRatePct=${data.repaymentRatePct ?? "missing"}, overdue30Pct=${data.overdue30Pct ?? "missing"}, payingCustomers=${data.payingCustomers ?? "missing"}, top5ConcentrationPct=${data.top5ConcentrationPct ?? "missing"}`,
    `F11 evidenceStrength=${result.evidenceStrength}, decisionStatus=${result.decisionStatus}, confirmedIntegrityEvents=${result.confirmedIntegrityEvents.length}`,
    "F12 TAI is activity coherence; PD, expected loss, numeric limit and automatic approval are not produced"
  ];
}

/**
 * 单一评估入口：/api/v1/assess、/api/v1/chat、risk-agent 工具共用同一实现。
 * deps:
 *   brain            HarnessBrain 实例（模型注记层，可为未配置）
 *   connectors       connector registry（证据分级用）
 *   sessions         SessionStore（v03 会话）
 *   invocationTimeoutMs  调用超时预算
 *   assessmentRunner 测试注入点（默认内部实现）
 */
export function createAssessmentService({ brain, connectors, sessions, invocationTimeoutMs, assessmentRunner, model = MODEL }) {
  async function assessV021WithOptionalBrain(input, requestId, requireModel = false, useModel = true, modelTimeoutMs = null) {
    const normalized = normalizeEvidenceV021(input);
    const result = computeRiskV021(normalized);
    let modelLayer = null;
    let harnessStatus = useModel ? "unconfigured" : "not-requested";
    if (!useModel) return { normalized, result, modelLayer, harnessStatus };
    try {
      modelLayer = modelTimeoutMs
        ? await withTimeout(brain.assessV021(normalized, result, requestId), modelTimeoutMs, "MODEL_TIMEOUT")
        : await brain.assessV021(normalized, result, requestId);
      harnessStatus = "ok";
    } catch (error) {
      if (requireModel) throw error;
      harnessStatus = error.code === "HARNESS_BUSY" ? "busy" : "unavailable";
    }
    return { normalized, result, modelLayer, harnessStatus };
  }

  async function assess(body, requestId) {
    if (!body.draft || typeof body.draft !== "object" || Array.isArray(body.draft)) return { status: 400, body: { error: "draft must be an object" } };
    const validation = validateDraftV03(body.draft);
    if (validation.errors.length) return {
      status: 400,
      body: {
        error: "Review the highlighted assessment fields", fieldErrors: validation.errors,
        missingByGroup: validation.missingByGroup, warnings: validation.warnings, ignoredInputs: validation.ignoredInputs
      }
    };

    const useModel = body.modelConsent === true;
    const modelBudgetMs = Math.max(1, invocationTimeoutMs - 250);
    const runner = assessmentRunner || assessV021WithOptionalBrain;
    const { normalized, result, modelLayer, harnessStatus } = await runner(validation.draft, requestId, false, useModel, modelBudgetMs);
    const evidenceCoverage = buildEvidenceCoverageV03(validation.draft);
    const requiredActions = buildRequiredActionsV03(validation, result, evidenceCoverage);
    // 证据分级：声明级 vs 独立验证（当前无连接器 → independentlyVerified 恒为 0）。
    // 说明：该字段不参与 assessmentFingerprint（与模型注记同理），保持 v0.2.1 确定性身份稳定。
    const evidenceStatus = summarizeEvidenceStatus(validation.draft.evidence, { connectors });
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length <= 80 ? body.sessionId : requestId;
    sessions.set(`v03:${sessionId}`, { version: "v0.3.1", input: normalized, assessment: result, modelLayer, facts: factsForV021(normalized, result) });

    const inputFingerprint = finchInputFingerprint(validation.draft);
    const assessmentFingerprint = finchAssessmentFingerprint(deterministicFingerprintPayload({ result, validation, evidenceCoverage, requiredActions }));
    const payload = addFinchIdentity({
      ...result, productVersion: PRODUCT_VERSION_V03, draftId: body.draftId || sessionId, model,
      modelAnalysis: modelLayer?.analysis || null, modelReview: modelLayer?.review || null,
      validation: { authoritative: "deterministic-v0.2.1", modelConflicts: modelLayer?.review?.conflicts || [], ignoredInputs: validation.ignoredInputs },
      readinessStatus: validation.readinessStatus, missingByGroup: validation.missingByGroup,
      evidenceCoverage, requiredActions, evidenceStatus, harnessStatus, sessionId
    }, inputFingerprint, assessmentFingerprint);
    return { status: 200, body: payload };
  }

  return { assess, assessV021WithOptionalBrain };
}
