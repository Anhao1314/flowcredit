/*
 * risk-tools.js — 业务风险 agent 的确定性工具集。
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 计算类工具纯确定性：零网络、零随机；时钟只经 nowMs 注入（CSV attestation 时间）。
 *      （2026-11-18 修订）新增唯一取数工具 lookup_public_company：只访问 SEC EDGAR
 *      白名单域名、只读、每项带来源与申报日，不写 drafts/sessions、不产生
 *      authoritative 字段；其余工具保持零网络。该工具返回 documented 事实，
 *      不是评估结论，也不能替代经营方数据。
 *   2. 权威字段（TAI/CCI/grade/decision）只来自 computeRiskV021；工具结果携带
 *      authoritative 子对象（inputFingerprint/assessmentFingerprint）供引用与产物卡。
 *   3. 参数白名单（assertArgs）：LLM 传入的未知键一律拒绝；用户文本是不可信数据。
 *   4. 模型永不能写入 draft 之外的任何状态；工具不写 sessions、不写文件。
 */
import { PRODUCT_VERSION_V03, INTAKE_SCHEMA_V03, sanitizeExtractedDraftV03, validateDraftV03, buildEvidenceCoverageV03, buildRequiredActionsV03 } from "./intake-v03.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021, computeCapitalStructure } from "./risk-core-v021.js";
import { extractNaturalLanguageDraft } from "./nl-draft-v01.js";
import { summarizeEvidenceStatus } from "./evidence-status.js";
import { buildMonthlyDraftFromCsv } from "./connectors/csv.js";
import { buildEvidencePack } from "./connectors/evidence-pack.js";
import { observationsForCompany } from "./research/panel.js";
import { buildPredictionReport } from "./research/predictions.js";
import { commitmentCoverageFrom } from "./connectors/sec-filings.js";
import { queryComputeKnowledge } from "./knowledge/compute-graph.js";
import { getPresetV021 } from "./presets.js";
import { addFinchIdentity, deterministicFingerprintPayload, finchAssessmentFingerprint, finchInputFingerprint } from "./finch-contract.js";
import { createCoreToolRegistry } from "../core/tool-registry.js";

const WHAT_IF_NUMERIC_FIELDS = Object.freeze([
  "inputTokensM", "outputTokensM", "validRatePct", "gpuHours", "revenueUsd", "computeSpendUsd",
  "repaymentRatePct", "overdue30Pct", "payingCustomers", "top5ConcentrationPct",
  "operatingHistoryDays", "dataCoveragePct",
  "totalDebtUsd", "cashAndCashEquivalentsUsd", "interestExpenseUsd"
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
    capitalStructure: result.capitalStructure
      ? { score: result.capitalStructure.score, cciCap: result.capitalStructure.cciCap, cciBeforeCap: result.capitalStructure.cciBeforeCap, capApplied: result.capitalStructure.capApplied }
      : null,
    inputFingerprint, assessmentFingerprint
  };
  return { ok: true, payload, validation, inputFingerprint, assessmentFingerprint };
}

/**
 * deps:
 *   connectors  connector registry（证据分级/attestation）
 *   nowMs       CSV attestation 时间注入（确定性测试可固定）
 */
/** SEC facts → 月度口径 draft 片段（仅供资本结构层；不补 token/GPU/回款/客户数据）。 */
function latestFact(facts, field, periodEnd = null) {
  const all = (facts || []).filter(fact => fact.field === field);
  const pool = periodEnd ? all.filter(fact => fact.periodEnd === periodEnd) : [];
  const use = pool.length ? pool : all;
  return use.slice().sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)) || String(b.filed || "").localeCompare(String(a.filed || "")))[0] || null;
}

function publicDraftFromLookup(lookup) {
  const revenue = latestFact(lookup.facts, "revenueUsd");
  if (!revenue) return null;
  const months = String(revenue.form) === "10-K" ? 12 : 3;
  const month = String(revenue.periodEnd).slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const periodEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const draft = {
    label: lookup.company.name,
    periodStart: `${month}-01`,
    periodEnd,
    revenueUsd: Math.round(revenue.value / months)
  };
  const gross = latestFact(lookup.facts, "grossProfitUsd", revenue.periodEnd);
  const cost = latestFact(lookup.facts, "costOfRevenueUsd", revenue.periodEnd);
  if (gross) draft.computeSpendUsd = Math.round((revenue.value - gross.value) / months);
  else if (cost) draft.computeSpendUsd = Math.round(cost.value / months);
  const debt = latestFact(lookup.facts, "debtUsd", revenue.periodEnd);
  const cash = latestFact(lookup.facts, "cashUsd", revenue.periodEnd);
  const interest = latestFact(lookup.facts, "interestExpenseUsd", revenue.periodEnd);
  const operating = latestFact(lookup.facts, "operatingIncomeUsd", revenue.periodEnd);
  const equity = latestFact(lookup.facts, "equityUsd", revenue.periodEnd);
  if (debt) draft.totalDebtUsd = debt.value;
  if (cash) draft.cashAndCashEquivalentsUsd = cash.value;
  if (interest) draft.interestExpenseUsd = Math.round(interest.value / months);
  if (operating) draft.operatingIncomeUsd = Math.round(operating.value / months);
  if (equity) draft.equityUsd = equity.value;
  return {
    draft,
    derived: {
      months,
      basis: `${revenue.form} ${revenue.periodEnd}`,
      monthlyRevenue: draft.revenueUsd,
      computeSpendSource: gross ? "revenue − gross profit" : cost ? "cost of revenue" : "not available",
      sources: lookup.sources
    }
  };
}

export function createRiskToolRegistry({ connectors, secEdgar = null, filings = null, priceFeed = null, research = null, predictionLedger = null, computeGraph = null, nowMs = () => new Date().toISOString() } = {}) {
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
      description: "Deterministic sensitivity: re-run the assessment with numeric field overrides applied on top of the draft. Returns baseline vs after (TAI/CCI/riskGrade/decisionStatus) and deltas. Overrides accept only scalar numeric intake fields. If the full draft is not in hand, rebuild it first via assess_prompt/extract_from_text on the earlier user text; never retype arrays or figures from memory.",
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
          evidenceStrength: payload.evidenceStrength ?? null,
          capitalStructure: payload.capitalStructure
            ? { score: payload.capitalStructure.score, cciCap: payload.capitalStructure.cciCap, cciBeforeCap: payload.capitalStructure.cciBeforeCap, capApplied: payload.capitalStructure.capApplied }
            : null
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
        return {
          draft: extraction.draft, matchedFields: extraction.matchedFields,
          warnings: extraction.warnings,
          grounding: { note: "parser v0.3 is grounded by construction: only fields literally stated in the text are emitted" },
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
      name: "attach_evidence",
      description: "Attach a structured evidence pack (JSON: {version:'evidence-pack/v0.1', asOf, sourceDomain, coveragePct?, fields:{...}}) to a draft. The pack is sha256-hashed and documented-tier evidence is attached ONLY for whitelisted fields whose values match the declared draft. Mismatched fields are rejected and listed; declared values are never overwritten by evidence, and an uploaded pack never becomes independently verified. After attaching, call assess_draft on the returned draft.",
      parameters: {
        draft: { type: "object", required: true },
        pack: { type: "string", required: true, description: "Raw evidence-pack JSON text supplied by the user" }
      },
      execute(args) {
        assertArgs(args, ["draft", "pack"]);
        const clock = Date.parse(nowMs());
        try {
          const built = buildEvidencePack({
            draft: args.draft,
            packText: String(args.pack),
            nowMs: Number.isFinite(clock) ? clock : Date.now()
          });
          return {
            attached: true,
            digest: built.digest,
            sourceDomain: built.sourceDomain,
            attachedFields: built.attached,
            mismatched: built.mismatched,
            ignored: built.ignored,
            draft: built.draft,
            evidenceStatus: summarizeEvidenceStatus(built.draft.evidence, { connectors }),
            note: "Evidence packs are documented tier (uploaded document), not independent verification. Mismatched fields were NOT attested; declared values were not overwritten.",
            authoritative: null
          };
        } catch (error) {
          return {
            attached: false, code: error.code || "EVIDENCE_PACK_FAILED",
            message: String(error.message || error), authoritative: null
          };
        }
      }
    },
    {
      name: "assess_prompt",
      description: "One-shot: extract the whitelisted draft from the user's raw text (JSON or prose), ground it, and run the authoritative assessment. The text is injected server-side with the user's raw prompt — never retype it. PREFER THIS whenever the user prompt already contains the facts, regardless of length; do not pre-extract or pre-validate. The server merges a carried session draft automatically for follow-up turns; do not retype earlier fields.",
      parameters: { text: { type: "string" } },
      execute(args) {
        // carryDraft 由服务端注入（会话草稿续传）；模型传的同名键会在注入时被覆盖。
        assertArgs(args, ["text", "carryDraft"]);
        const text = typeof args.text === "string" ? args.text : "";
        if (!text.trim() || text.length > INTAKE_SCHEMA_V03.maxTextLength) throw new TypeError(`text must contain 1 to ${INTAKE_SCHEMA_V03.maxTextLength} characters`);
        // 解析器 v0.4 是按构造 grounded 的（只映射文本明示字段，含推导月份行）；
        // 不再做二次 grounding——那会把推导型字段（如 "3月"+年份锚点的月度行）误删。
        const extraction = extractNaturalLanguageDraft(text);
        const warnings = [...extraction.warnings];
        // 会话草稿续传（agent 循环）：上一轮已评估字段作为基座，本轮文本字段覆盖。
        // carryDraft 由服务端注入（会话存储），模型无权构造或改写。
        const merged = args.carryDraft && typeof args.carryDraft === "object" && !Array.isArray(args.carryDraft)
          ? { ...args.carryDraft, ...extraction.draft }
          : extraction.draft;
        const outcome = assessDraftPure(merged, { connectors });
        if (!outcome.ok) {
          return {
            assessed: false, extracted: extraction.draft, merged, matchedFields: extraction.matchedFields, warnings,
            validation: {
              valid: false, errors: outcome.validation.errors, warnings: outcome.validation.warnings,
              missingByGroup: outcome.validation.missingByGroup, missingInputs: outcome.validation.missingInputs
            },
            authoritative: null
          };
        }
        return {
          assessed: true, extracted: extraction.draft, merged, matchedFields: extraction.matchedFields, warnings,
          ...outcome.payload,
          authoritative: outcome.payload.authoritative
        };
      }
    },
    {
      name: "lookup_public_company",
      description: "Read-only lookup of a US-listed company's public financial facts from SEC EDGAR: revenue, gross profit, operating income, net income, cash and debt, up to 4 filed periods, each with form (10-Q/10-K) and filing date. Use this when the user names a public company or ticker and asks for its public financials — never invent those numbers. Returns documented facts only; token activity, GPU hours, repayment and customer concentration are NOT available from this source, so a full TAI/CCI assessment still requires operator-provided data.",
      parameters: { query: { type: "string", required: true, description: "Company name or ticker, e.g. CoreWeave or CRWV" } },
      async execute(args) {
        assertArgs(args, ["query"]);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) throw new TypeError("query must be a company name or ticker (1-120 chars)");
        if (!secEdgar) return { ok: false, code: "SEC_CONNECTOR_UNAVAILABLE", message: "public-company lookup is not configured on this server" };
        try {
          return await secEdgar.lookupPublicCompany({ query: args.query.trim() });
        } catch (error) {
          return {
            ok: false, code: error.code || "SEC_LOOKUP_FAILED", message: String(error.message || error),
            ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {})
          };
        }
      }
    },
    {
      name: "assess_public_company",
      description: "Fetch a US-listed company's SEC EDGAR facts and compute the capital-structure overlay (solvency score and CCI cap) from filed revenue, cost of revenue, debt, cash and interest. Returns the monthly-equivalent draft fragment plus the operator fields still required for a full TAI/CCI assessment. Never fabricates token/GPU/repayment/customer data.",
      parameters: { query: { type: "string", required: true, description: "Company name or ticker, e.g. CoreWeave or CRWV" } },
      async execute(args) {
        assertArgs(args, ["query"]);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) throw new TypeError("query must be a company name or ticker (1-120 chars)");
        if (!secEdgar) return { ok: false, code: "SEC_CONNECTOR_UNAVAILABLE", message: "public-company lookup is not configured on this server" };
        try {
          const lookup = await secEdgar.lookupPublicCompany({ query: args.query.trim() });
          const built = publicDraftFromLookup(lookup);
          if (!built) return { ok: false, code: "SEC_REVENUE_NOT_FOUND", message: "SEC facts did not contain a revenue concept" };
          const capital = computeCapitalStructure(built.draft);
          const validation = validateDraftV03({ ...built.draft });
          return {
            ok: true,
            company: lookup.company,
            draft: built.draft,
            derived: built.derived,
            capitalStructure: capital ? { score: capital.score, cciCap: capital.cap, ...capital.details } : null,
            missingInputs: validation.missingInputs,
            sources: lookup.sources,
            facts: lookup.facts,
            note: "Capital-structure overlay computed from SEC-filed figures (quarterly ÷ months for the monthly-equivalent draft). CCI requires operator-provided token/GPU/repayment/customer data; nothing is fabricated."
          };
        } catch (error) {
          return {
            ok: false, code: error.code || "SEC_LOOKUP_FAILED", message: String(error.message || error),
            ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {})
          };
        }
      }
    },
    {
      name: "fetch_public_commitments",
      description: "Read the latest 10-K/10-Q/S-1/424B4 filing of a US-listed company and extract compute/lease COMMITTED SPEND (aggregate and next-12-months), total liquidity, and SHARES OUTSTANDING (per class plus the filing's own combined total) with frozen deterministic patterns — off-balance-sheet and cap-table figures XBRL does not carry. When the price feed is configured it also reports market cap = share count × latest close. Returns values WITH the original filing sentences (snippets) for human verification; extraction is documented tier, weaker than XBRL facts, and a null value means 'not found', never zero. Conservative commitment coverage = liquidity ÷ 12-month committed spend.",
      parameters: { query: { type: "string", required: true, description: "Company name or ticker, e.g. Anthropic or ANT" } },
      async execute(args) {
        assertArgs(args, ["query"]);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) throw new TypeError("query must be a company name or ticker (1-120 chars)");
        if (!filings) return { ok: false, code: "FILINGS_CONNECTOR_UNAVAILABLE", message: "filing text connector is not configured on this server" };
        let result;
        try {
          result = await filings.fetchPublicCommitments({ query: args.query.trim() });
        } catch (error) {
          return {
            ok: false, code: error.code || "FILINGS_FETCH_FAILED", message: String(error.message || error),
            ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {})
          };
        }
        // 市值组合：股本（申报文本，documented 级）× 最新收盘（价格源）；任一缺失如实披露，绝不编数。
        if (result.ok && result.commitments?.sharesOutstanding?.totalShares && priceFeed) {
          try {
            const price = await priceFeed.fetchDaily({ symbol: result.company.ticker });
            const row = price?.rows?.length ? price.rows[price.rows.length - 1] : null;
            if (row && Number.isFinite(row.close) && row.date) {
              result.marketData = {
                priceDate: row.date,
                closeUsd: row.close,
                sharesOutstanding: result.commitments.sharesOutstanding.totalShares,
                sharesSource: result.commitments.sharesOutstanding.totalSharesSource,
                marketCapUsd: Math.round(result.commitments.sharesOutstanding.totalShares * row.close),
                note: "market cap = filing-text share count × latest close. Structural DD additionally needs an equity-volatility window that a freshly listed name does not have yet."
              };
            } else {
              result.marketNote = "price feed returned no usable rows; market cap not computed";
            }
          } catch (error) {
            result.marketNote = `price feed failed (${error.code || "PRICE_FAILED"}) — market cap not computed`;
          }
        }
        return result;
      }
    },
    {
      name: "verify_credit_events",
      description: "The event-verification pipeline (machine proposes, human approves): scan a company's 8-K filings in a date window, fetch each primary document and deterministically verify bankruptcy/delisting/restructuring disclosures (Item 1.03/3.01 markers, RSA/debt-exchange keywords), extracting the event date and an original-text snippet. Verified candidates come with citations (accession + sha256) but are PROPOSALS — adding one to the credit-event label file requires human review; nothing is written automatically.",
      parameters: {
        query: { type: "string", required: true, description: "Company name or ticker, e.g. CORZ" },
        from: { type: "string", required: false, description: "Window start YYYY-MM-DD" },
        to: { type: "string", required: false, description: "Window end YYYY-MM-DD" },
        maxFilings: { type: "integer", required: false, description: "Maximum 8-Ks to verify, 1-20 (default 12)" }
      },
      async execute(args) {
        assertArgs(args, ["query", "from", "to", "maxFilings"]);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) throw new TypeError("query must be a company name or ticker (1-120 chars)");
        for (const key of ["from", "to"]) {
          if (args[key] !== undefined && (typeof args[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args[key]))) throw new TypeError(`${key} must be YYYY-MM-DD`);
        }
        if (args.maxFilings !== undefined && (!Number.isInteger(args.maxFilings) || args.maxFilings < 1 || args.maxFilings > 20)) throw new TypeError("maxFilings must be an integer within 1-20");
        if (!filings) return { ok: false, code: "FILINGS_CONNECTOR_UNAVAILABLE", message: "filing text connector is not configured on this server" };
        let listed;
        try {
          listed = await filings.listFilings({
            query: args.query.trim(), form: "8-K",
            ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}),
            ...(args.maxFilings ? { maxFilings: args.maxFilings } : {})
          });
        } catch (error) {
          return { ok: false, code: error.code || "FILINGS_FETCH_FAILED", message: String(error.message || error) };
        }
        const candidates = [];
        for (const filing of listed.filings) {
          if (!filing.primaryDocument) {
            candidates.push({ filed: filing.filed, accession: filing.accession, items: filing.items, verified: false, reason: "no primary document in the index" });
            continue;
          }
          try {
            const verified = await filings.verifyEventDocument({ cik: listed.company.cik, accession: filing.accession, primaryDocument: filing.primaryDocument });
            candidates.push({ filed: filing.filed, accession: filing.accession, items: filing.items, ...verified });
          } catch (error) {
            candidates.push({ filed: filing.filed, accession: filing.accession, items: filing.items, verified: false, reason: `${error.code || "FILING_FETCH_FAILED"}: ${String(error.message || error)}` });
          }
        }
        const verifiedCount = candidates.filter(candidate => candidate.verified).length;
        return {
          ok: true,
          company: listed.company,
          scanned: listed.filings.length,
          verifiedCount,
          candidates,
          note: "verified candidates are PROPOSALS with citations (accession + sha256) — human review is required before any is added to agent/research/credit-events.json; nothing is written automatically"
        };
      }
    },
    {
      name: "build_research_panel",
      description: "Build a point-in-time research panel of US-listed AI compute operators from SEC EDGAR: quarterly revenue, margins, debt, cash, interest, coverage and growth, each observation carrying periodEnd and filed date. When the market price feed is configured it also attaches market cap, Merton distance-to-default and forward 90d proxy labels (filed-aligned). Use this for calibration/factor research requests (panel, IC, scoring model). Returns a panelId for factor_report plus sample rows and coverage; research-only, never writes scores or grades.",
      parameters: {
        tickers: { type: "string", required: false, description: "Comma-separated tickers (max 14); defaults to the built-in compute-operator universe" },
        periods: { type: "integer", required: false, description: "Quarters per company, 4-24 (default 8); deeper windows reach historical distress episodes such as the 2022 mining winter" }
      },
      async execute(args) {
        assertArgs(args, ["tickers", "periods"]);
        if (!research) return { ok: false, code: "RESEARCH_UNAVAILABLE", message: "research service is not configured on this server" };
        let tickers;
        if (args.tickers !== undefined) {
          if (typeof args.tickers !== "string") throw new TypeError("tickers must be a comma-separated string");
          tickers = args.tickers.split(/[,\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
          if (!tickers.length || tickers.length > 14) throw new TypeError("tickers must contain 1-14 symbols");
        }
        let periods;
        if (args.periods !== undefined) {
          if (!Number.isInteger(args.periods) || args.periods < 4 || args.periods > 24) throw new TypeError("periods must be an integer within 4-24");
          periods = args.periods;
        }
        return await research.buildPanel({ ...(tickers ? { tickers } : {}), ...(periods ? { periods } : {}) });
      }
    },
    {
      name: "factor_report",
      description: "Summarize a research panel: factor coverage and descriptive statistics. Labels: explicit labels → labelStatus=available; forward 90d market-proxy labels (filed-aligned) → labelStatus=proxy-market; otherwise unavailable and no IC is reported. When labels exist it reports per-period Rank IC, ICIR and t-stat for each factor plus the Merton DD structural benchmark — judge factors by incremental IC versus DD, never as validated alpha.",
      parameters: { panelId: { type: "string", required: true, description: "panelId returned by build_research_panel" } },
      execute(args) {
        assertArgs(args, ["panelId"]);
        if (typeof args.panelId !== "string" || !args.panelId.trim()) throw new TypeError("panelId is required");
        if (!research) return { ok: false, code: "RESEARCH_UNAVAILABLE", message: "research service is not configured on this server" };
        return research.factorReport({ panelId: args.panelId.trim() });
      }
    },
    {
      name: "build_scoring_model",
      description: "Fit a RESEARCH-DRAFT scoring model from a built panel: per-period robust z-scores, shrinkage weights (direction from in-sample IC, magnitude shrunk toward equal weight), factor correlations and walk-forward holdout IC versus the Merton DD benchmark. Returns the frozen model JSON draft. It is NOT wired to the assessment engine — adoption requires human review and a version bump. Never present it as validated.",
      parameters: {
        panelId: { type: "string", required: true, description: "panelId returned by build_research_panel" },
        holdoutPeriods: { type: "integer", required: false, description: "Quarters held out for walk-forward validation, 1-4 (default 2)" }
      },
      execute(args) {
        assertArgs(args, ["panelId", "holdoutPeriods"]);
        if (typeof args.panelId !== "string" || !args.panelId.trim()) throw new TypeError("panelId is required");
        if (args.holdoutPeriods !== undefined && (!Number.isInteger(args.holdoutPeriods) || args.holdoutPeriods < 1 || args.holdoutPeriods > 4)) {
          throw new TypeError("holdoutPeriods must be an integer within 1-4");
        }
        if (!research) return { ok: false, code: "RESEARCH_UNAVAILABLE", message: "research service is not configured on this server" };
        return research.buildScoringModel({
          panelId: args.panelId.trim(),
          ...(args.holdoutPeriods !== undefined ? { holdoutPeriods: args.holdoutPeriods } : {})
        });
      }
    },
    {
      name: "replay_report",
      description: "Replay the frozen capital-structure distress gates across a research panel, point-in-time (filed-aligned): each scored observation is flagged if any distress gate fires, then compared against the panel's forward-90d market-proxy labels. Returns confusion matrix, recall/false-positive-rate/precision and per-company lead times. Labels are MARKET PROXIES, not credit events; this is a replay statistic, not proof of predictive validity. Never tune the flag rule here.",
      parameters: { panelId: { type: "string", required: true, description: "panelId returned by build_research_panel" } },
      execute(args) {
        assertArgs(args, ["panelId"]);
        if (typeof args.panelId !== "string" || !args.panelId.trim()) throw new TypeError("panelId is required");
        if (!research) return { ok: false, code: "RESEARCH_UNAVAILABLE", message: "research service is not configured on this server" };
        return research.replayReport({ panelId: args.panelId.trim() });
      }
    },
    {
      name: "check_predictions",
      description: "The automated referee: score the frozen prediction ledger against the latest point-in-time SEC data. Each prediction is graded pass / fail / pending / unverifiable with periodEnd+filed evidence and an evaluationFingerprint. FAILs are permanent records and must be reported as-is; UNVERIFIABLE means the required data source is not wired yet, never a pass. The ledger itself is never edited.",
      parameters: { ticker: { type: "string", required: false, description: "Optional ticker filter (e.g. ANT); default scores the whole ledger" } },
      async execute(args) {
        assertArgs(args, ["ticker"]);
        if (!predictionLedger) return { ok: false, code: "PREDICTIONS_UNCONFIGURED", message: "no prediction ledger is configured on this server" };
        if (args.ticker !== undefined && (typeof args.ticker !== "string" || !args.ticker.trim() || args.ticker.length > 20)) throw new TypeError("ticker must be a short symbol string");
        if (!secEdgar) return { ok: false, code: "SEC_CONNECTOR_UNAVAILABLE", message: "SEC connector is not configured on this server" };
        const filter = args.ticker ? args.ticker.trim().toUpperCase() : null;
        const wanted = [...new Set(predictionLedger.predictions
          .map(item => String(item.subject.ticker).toUpperCase())
          .filter(ticker => !filter || ticker === filter))];
        if (!wanted.length) return { ok: false, code: "NO_MATCHING_PREDICTIONS", message: `no predictions registered for ticker ${filter}` };
        const observationsByTicker = {};
        const dataNotes = [];
        const commitmentSummaries = {};
        const needCommitments = new Set(predictionLedger.predictions
          .filter(item => item.metric === "commitmentCoverage" && (!filter || String(item.subject.ticker).toUpperCase() === filter))
          .map(item => String(item.subject.ticker).toUpperCase()));
        for (const ticker of wanted) {
          try {
            const lookup = await secEdgar.lookupPublicCompany({ query: ticker, periods: 12 });
            observationsByTicker[ticker] = observationsForCompany(lookup);
            if (!observationsByTicker[ticker].length) dataNotes.push(`${ticker}: registrant found but no XBRL facts yet (no 10-Q/10-K filed)`);
          } catch (error) {
            observationsByTicker[ticker] = [];
            dataNotes.push(`${ticker}: ${error.code || "SEC_LOOKUP_FAILED"} — ${String(error.message || error)}`);
          }
          // commitmentCoverage 行来自申报文本抽取（documented 级），与 XBRL 观测合并供裁判使用。
          if (needCommitments.has(ticker)) {
            if (!filings) {
              dataNotes.push(`${ticker}: commitmentCoverage needs the filing-text connector, which is not configured`);
              continue;
            }
            try {
              const filingData = await filings.fetchPublicCommitments({ query: ticker });
              if (filingData.ok && filingData.commitments) {
                const coverage = commitmentCoverageFrom(filingData.commitments);
                commitmentSummaries[ticker] = {
                  form: filingData.filing?.form ?? null, filed: filingData.filing?.filed ?? null,
                  asOfDate: filingData.commitments.asOfDate ?? null,
                  aggregateCommittedSpendUsd: filingData.commitments.aggregateCommittedSpendUsd,
                  twelveMonthCommittedSpendUsd: filingData.commitments.twelveMonthCommittedSpendUsd,
                  liquidityUsd: filingData.commitments.liquidityUsd,
                  commitmentCoverageConservativeX: coverage
                };
                if (coverage !== null) {
                  const periodEnd = filingData.commitments.asOfDate || filingData.filing?.filed || null;
                  if (periodEnd) observationsByTicker[ticker] = [...(observationsByTicker[ticker] || []), { periodEnd, filed: filingData.filing?.filed ?? null, commitmentCoverage: coverage }];
                  else dataNotes.push(`${ticker}: commitments extracted but no as-of/filing date to anchor the observation`);
                } else {
                  dataNotes.push(`${ticker}: commitments not fully extractable from the filing (values missing — manual review required)`);
                }
              }
            } catch (error) {
              dataNotes.push(`${ticker}: commitments fetch failed (${error.code || "FILINGS_FETCH_FAILED"}) — ${String(error.message || error)}`);
            }
          }
        }
        const clock = Date.parse(nowMs());
        const report = buildPredictionReport(predictionLedger, observationsByTicker, Number.isFinite(clock) ? clock : Date.now());
        return { ok: true, ...report, ...(Object.keys(commitmentSummaries).length ? { commitments: commitmentSummaries } : {}), dataNotes };
      }
    },
    {
      name: "calibration_report",
      description: "Descriptive calibration table for the capital-structure overlay: group scored panel observations into CAP buckets (≤550 … 951-1000) and report the observed event rate per bucket, the base rate, in-sample Brier scores and a monotonicity red-flag check. Labels prefer explicit credit events over market proxies. These are sample statistics, not fitted default probabilities; no PD is produced. Small samples mean single-bucket rates are indicative at best.",
      parameters: { panelId: { type: "string", required: true, description: "panelId returned by build_research_panel" } },
      execute(args) {
        assertArgs(args, ["panelId"]);
        if (typeof args.panelId !== "string" || !args.panelId.trim()) throw new TypeError("panelId is required");
        if (!research) return { ok: false, code: "RESEARCH_UNAVAILABLE", message: "research service is not configured on this server" };
        return research.calibrationReport({ panelId: args.panelId.trim() });
      }
    },
    {
      name: "query_compute_knowledge",
      description: "Query the compute knowledge graph (domain base-map, deterministic): look up a concept by id/label substring (e.g. token, 承购, TAI) and get its definition, source-cited facts and related edges; resolve a named chain (physical/commercial/financial/credit/thesis); list seam risks (front/back/core: 算力变现面/支撑面/计量本体); or return the graph overview. Knowledge is a base-map, NOT evaluation input — numbers still come from the deterministic tools.",
      parameters: {
        concept: { type: "string", required: false, description: "Concept id or label substring, e.g. token, 承购, TAI" },
        chain: { type: "string", required: false, description: "Chain name or label substring: physical | commercial | financial | credit | thesis" },
        seam: { type: "string", required: false, enum: ["front", "back", "core"], description: "List seam risks: front (变现面) / back (支撑面) / core (计量本体)" },
        overview: { type: "boolean", required: false, description: "Return graph stats, chains and seam map" }
      },
      execute(args) {
        assertArgs(args, ["concept", "chain", "seam", "overview"]);
        if (!computeGraph) return { ok: false, code: "KNOWLEDGE_UNCONFIGURED", message: "compute knowledge graph is not configured on this server" };
        if (!args.concept && !args.chain && !args.seam && !args.overview) throw new TypeError("provide one of concept, chain, seam or overview");
        try {
          return queryComputeKnowledge(computeGraph, {
            ...(args.concept !== undefined ? { concept: String(args.concept) } : {}),
            ...(args.chain !== undefined ? { chain: String(args.chain) } : {}),
            ...(args.seam !== undefined ? { seam: args.seam } : {}),
            ...(args.overview !== undefined ? { overview: args.overview === true } : {})
          });
        } catch (error) {
          return { ok: false, code: error.code || "KG_QUERY_FAILED", message: String(error.message || error) };
        }
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
