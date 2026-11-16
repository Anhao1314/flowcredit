/*
 * risk-tools.js — 业务风险 agent 的确定性工具集。
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 全部工具纯确定性：零网络、零随机；时钟只经 nowMs 注入（CSV attestation 时间）。
 *   2. 权威字段（TAI/CCI/grade/decision）只来自 computeRiskV021；工具结果携带
 *      authoritative 子对象（inputFingerprint/assessmentFingerprint）供引用与产物卡。
 *   3. 参数白名单（assertArgs）：LLM 传入的未知键一律拒绝；用户文本是不可信数据。
 *   4. 模型永不能写入 draft 之外的任何状态；工具不写 sessions、不写文件。
 */
import { PRODUCT_VERSION_V03, INTAKE_SCHEMA_V03, sanitizeExtractedDraftV03, validateDraftV03, buildEvidenceCoverageV03, buildRequiredActionsV03 } from "./intake-v03.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021 } from "./risk-core-v021.js";
import { extractNaturalLanguageDraft } from "./nl-draft-v01.js";
import { groundExtractedDraft } from "./grounding.js";
import { summarizeEvidenceStatus } from "./evidence-status.js";
import { buildMonthlyDraftFromCsv } from "./connectors/csv.js";
import { getPresetV021 } from "./presets.js";
import { addFinchIdentity, deterministicFingerprintPayload, finchAssessmentFingerprint, finchInputFingerprint } from "./finch-contract.js";
import { createCoreToolRegistry } from "../core/tool-registry.js";

const WHAT_IF_NUMERIC_FIELDS = Object.freeze([
  "inputTokensM", "outputTokensM", "validRatePct", "gpuHours", "revenueUsd", "computeSpendUsd",
  "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct",
  "operatingHistoryDays", "dataCoveragePct"
]);
const PERCENT_FIELDS = new Set(["validRatePct", "repaymentRatePct", "overdue30Pct", "top5ConcentrationPct", "dataCoveragePct"]);

function assertArgs(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("tool args must be an object");
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown tool arg: ${key}`);
  }
}

/**
 * 确定性评估内核（与 assessment-service.assess 同一实现，但无 HTTP/session/brain 依赖）。
 * 返回 { ok, payload?, validation?, inputFingerprint?, assessmentFingerprint? }。
 */
function assessDraftPure(draft, { connectors }) {
  const cleaned = sanitizeExtractedDraftV03(draft);
  const validation = validateDraftV03(cleaned.draft);
  if (validation.errors.length) {
    return { ok: false, validation, ignoredInputs: cleaned.ignoredInputs };
  }
  const normalized = normalizeEvidenceV021(validation.draft);
  const result = computeRiskV021(normalized);
  const evidenceCoverage = buildEvidenceCoverageV03(validation.draft);
  const requiredActions = buildRequiredActionsV03(validation, result, evidenceCoverage);
  const evidenceStatus = summarizeEvidenceStatus(validation.draft.evidence, { connectors });
  const inputFingerprint = finchInputFingerprint(validation.draft);
  const assessmentFingerprint = finchAssessmentFingerprint(deterministicFingerprintPayload({ result, validation, evidenceCoverage, requiredActions }));
  const payload = addFinchIdentity({
    ...result, productVersion: PRODUCT_VERSION_V03, model: null,
    validation: { authoritative: "deterministic-v0.2.1", modelConflicts: [], ignoredInputs: validation.ignoredInputs },
    readinessStatus: validation.readinessStatus, missingByGroup: validation.missingByGroup,
    evidenceCoverage, requiredActions, evidenceStatus, harnessStatus: "not-requested", sessionId: null
  }, inputFingerprint, assessmentFingerprint);
  payload.authoritative = {
    TAI: result.TAI ?? null, CCI: result.CCI ?? null, riskGrade: result.riskGrade ?? null,
    decisionStatus: result.decisionStatus ?? null, readinessStatus: validation.readinessStatus,
    inputFingerprint, assessmentFingerprint
  };
  return { ok: true, payload, validation, inputFingerprint, assessmentFingerprint };
}

/**
 * deps:
 *   connectors  connector registry（证据分级/attestation）
 *   nowMs       CSV attestation 时间注入（确定性测试可固定）
 */
export function createRiskToolRegistry({ connectors, nowMs = () => new Date().toISOString() } = {}) {
  const tools = [
    {
      name: "assess_draft",
      description: "Authoritative deterministic assessment of an intake draft (validation → risk engine). Returns TAI/CCI/riskGrade/decisionStatus. Never estimates; invalid drafts return the validation errors instead.",
      parameters: { draft: { type: "object", required: true } },
      execute(args) {
        assertArgs(args, ["draft"]);
        const outcome = assessDraftPure(args.draft, { connectors });
        if (!outcome.ok) {
          return {
            assessed: false,
            validation: {
              valid: false, errors: outcome.validation.errors, warnings: outcome.validation.warnings,
              missingByGroup: outcome.validation.missingByGroup, missingInputs: outcome.validation.missingInputs,
              ignoredInputs: [...new Set([...(outcome.ignoredInputs || []), ...outcome.validation.ignoredInputs])]
            },
            authoritative: null
          };
        }
        return outcome.payload;
      }
    },
    {
      name: "what_if",
      description: "Deterministic sensitivity: re-run the assessment with numeric field overrides applied on top of the draft. Returns baseline vs after (TAI/CCI/riskGrade/decisionStatus) and deltas. Overrides accept only scalar numeric intake fields.",
      parameters: { draft: { type: "object", required: true }, overrides: { type: "object", required: true } },
      execute(args) {
        assertArgs(args, ["draft", "overrides"]);
        const overrides = args.overrides && typeof args.overrides === "object" && !Array.isArray(args.overrides) ? args.overrides : null;
        if (!overrides || !Object.keys(overrides).length) throw new TypeError("overrides must be a non-empty object");
        const applied = {};
        for (const [key, raw] of Object.entries(overrides)) {
          if (!WHAT_IF_NUMERIC_FIELDS.includes(key)) throw new TypeError(`what_if override field is not supported: ${key}`);
          const value = typeof raw === "string" ? Number(raw.replace(/[%$,\s]/g, "")) : raw;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`override ${key} must be a finite non-negative number`);
          if (PERCENT_FIELDS.has(key) && value > 100) throw new TypeError(`override ${key} must be within 0..100`);
          applied[key] = value;
        }
        const baseline = assessDraftPure(args.draft, { connectors });
        if (!baseline.ok) {
          return { assessed: false, reason: "baseline draft is invalid", validation: { errors: baseline.validation.errors, missingByGroup: baseline.validation.missingByGroup }, authoritative: null };
        }
        const after = assessDraftPure({ ...args.draft, ...applied }, { connectors });
        if (!after.ok) {
          return { assessed: false, reason: "overridden draft is invalid", validation: { errors: after.validation.errors }, authoritative: null };
        }
        const pick = payload => ({
          TAI: payload.TAI ?? null, CCI: payload.CCI ?? null, riskGrade: payload.riskGrade ?? null,
          decisionStatus: payload.decisionStatus ?? null, readinessStatus: payload.readinessStatus ?? null,
          evidenceStrength: payload.evidenceStrength ?? null
        });
        const before = pick(baseline.payload);
        const result = pick(after.payload);
        const delta = {};
        for (const key of ["TAI", "CCI"]) {
          if (typeof before[key] === "number" && typeof result[key] === "number") delta[key] = Math.round((result[key] - before[key]) * 10000) / 10000;
        }
        if (before.riskGrade !== result.riskGrade) delta.riskGrade = `${before.riskGrade} → ${result.riskGrade}`;
        return {
          assessed: true, overrides: applied, baseline: before, after: result,
          delta: Object.keys(delta).length ? delta : { note: "no change in TAI/CCI/riskGrade" },
          authoritative: after.payload.authoritative
        };
      }
    },
    {
      name: "validate_draft",
      description: "Validate an intake draft WITHOUT scoring: field errors, missing-by-group list, readiness. Use this to tell the user exactly what is missing before assessing.",
      parameters: { draft: { type: "object", required: true } },
      execute(args) {
        assertArgs(args, ["draft"]);
        const cleaned = sanitizeExtractedDraftV03(args.draft);
        const validation = validateDraftV03(cleaned.draft);
        return {
          valid: validation.valid, readinessStatus: validation.readinessStatus,
          errors: validation.errors, warnings: validation.warnings,
          missingByGroup: validation.missingByGroup, missingInputs: validation.missingInputs,
          ignoredInputs: [...new Set([...cleaned.ignoredInputs, ...validation.ignoredInputs])],
          authoritative: null
        };
      }
    },
    {
      name: "extract_from_text",
      description: "Deterministic whitelist extraction from user text (or embedded JSON). Fields that cannot be grounded in the source text are dropped. Returns the extracted draft, matched fields and warnings.",
      parameters: { text: { type: "string", required: true } },
      execute(args) {
        assertArgs(args, ["text"]);
        const text = typeof args.text === "string" ? args.text : "";
        if (!text.trim() || text.length > INTAKE_SCHEMA_V03.maxTextLength) throw new TypeError(`text must contain 1 to ${INTAKE_SCHEMA_V03.maxTextLength} characters`);
        const extraction = extractNaturalLanguageDraft(text);
        const grounded = groundExtractedDraft(text, extraction.draft);
        const matched = Object.keys(grounded.draft);
        return {
          draft: grounded.draft, matchedFields: matched,
          warnings: [...extraction.warnings, ...grounded.report.warnings],
          grounding: { groundedFields: grounded.report.groundedFields, ungroundedFields: grounded.report.ungroundedFields },
          authoritative: null
        };
      }
    },
    {
      name: "import_csv",
      description: "Import a monthly CSV (period, input/output tokens, valid rate, GPU model/hours, revenue, compute spend, repayment, overdue, customers, top5, coverage) into a complete intake draft with a sha256-attested evidence bundle.",
      parameters: { csv: { type: "string", required: true }, label: { type: "string", required: true } },
      execute(args) {
        assertArgs(args, ["csv", "label"]);
        const imported = buildMonthlyDraftFromCsv(String(args.csv), {
          label: String(args.label),
          verifiedAt: nowMs(),
          reference: "risk-agent:import_csv"
        });
        if (!imported.ok) return { imported: false, errors: imported.errors, authoritative: null };
        return {
          imported: true, draft: imported.draft, digest: imported.digest, warnings: imported.warnings,
          evidenceStatus: summarizeEvidenceStatus(imported.draft.evidence, { connectors }),
          authoritative: { inputFingerprint: imported.digest, assessmentFingerprint: imported.digest }
        };
      }
    },
    {
      name: "preset_draft",
      description: "Return one of the synthetic example drafts (healthy | watch | sybil) so the user can try a complete assessment. These are fixtures, not real companies.",
      parameters: { key: { type: "string", required: true, enum: ["healthy", "watch", "sybil"] } },
      execute(args) {
        assertArgs(args, ["key"]);
        if (!["healthy", "watch", "sybil"].includes(args.key)) throw new TypeError(`unknown preset key: ${args.key}`);
        return { key: args.key, draft: getPresetV021(args.key), note: "synthetic fixture with simulation evidence; not a real company", authoritative: null };
      }
    }
  ];

  const definitions = tools.map(tool => ({
    ...tool,
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(tool.parameters).map(([key, spec]) => [
        key,
        spec.enum
          ? { type: spec.type, ...(spec.enum ? { enum: spec.enum } : {}), ...(spec.description ? { description: spec.description } : {}) }
          : { type: spec.type, ...(spec.description ? { description: spec.description } : {}) }
      ])),
      required: Object.entries(tool.parameters).filter(([, spec]) => spec.required).map(([key]) => key),
      additionalProperties: false
    }
  }));

  return createCoreToolRegistry(definitions);
}

export { assessDraftPure };
