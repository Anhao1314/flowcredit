/* Chat-only presentation. Reads existing parser/runtime output; never scores or enriches it.
 * Legacy assessment.model is intentionally not consumed. No I/O or model dependencies.
 */
const TITLE = "FlowCredit 初步风险评估";
const finite = value => typeof value === "number" && Number.isFinite(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const amount = value => {
  const [whole, fraction] = String(value).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
};
const FIELD_LABELS = {
  taskType: "业务类型", gpuModel: "GPU", gpuHours: "GPU 使用量", revenueUsd: "收入",
  computeSpendUsd: "算力支出", repaymentRatePct: "历史还款率", overdue30Pct: "30 天以上逾期率",
  payingCustomers: "付费客户", top5ConcentrationPct: "Top 5 客户收入占比"
};
const DIMENSION_LABELS = {
  customer: "客户结构", repayment: "偿付表现", tokenActivity: "Token 活跃度",
  economics: "经营经济性", continuity: "经营连续性"
};
const GROUP_LABELS = {
  Scope: "评估主体和评估周期",
  "Token activity": "Token 使用量和有效率（输入 Token、输出 Token 和有效率）",
  "Compute and business": "算力使用和经营数据",
  "Credit profile": "偿付表现和客户结构数据",
  "History and cross-check": "历史经营、数据覆盖和交叉验证信息（最近数月经营历史）",
  "Evidence action": "为已提供数据补充来源证据"
};
const ACTION_LABELS = {
  evidence: GROUP_LABELS["Evidence action"], "invalid-input": "修正 Runtime 指出的无效输入",
  "token-metering": "补充或复核 Token 计量信息", "credit-screen": "补充尚未完整的风险维度数据",
  integrity: "复核 Runtime 指出的数据一致性问题"
};
const STATE_LABELS = {
  limited: "Limited（有限）", ready: "Ready（就绪）", "not-ready": "Not ready（未就绪）",
  low: "Low（低）", medium: "Medium（中）", high: "High（高）",
  "insufficient-evidence": "信息或证据不足", "enhanced-review": "需要进一步复核",
  "manual-review": "需要人工复核"
};

function identifiedFacts(draft) {
  return Object.entries(FIELD_LABELS).flatMap(([key, label]) => {
    const value = draft[key];
    if (key === "taskType" || key === "gpuModel") {
      if (!text(value)) return [];
      const display = key === "taskType" && value === "inference" ? "AI 推理" :
        key === "gpuModel" && value === "h100-equivalent" ? "H100（等效类别）" : value;
      return [`${label}：${display}`];
    }
    if (!finite(value)) return [];
    const unit = key.endsWith("Usd") ? " 美元" : key.endsWith("Pct") ? "%" : key === "gpuHours" ? " 小时" : "";
    return [`${label}：${amount(value)}${unit}`];
  });
}

/** Additive display metadata only. Every score/status comes from assessment, never the draft. */
export function buildChatPresentation({ assessment = {}, missingByGroup = {}, requiredActions = [] } = {}) {
  const availableScores = Object.fromEntries(Object.entries(assessment.dimensionScores ?? {}).filter(([, value]) => finite(value)));
  const fullScores = {};
  for (const key of ["TAI", "CCI"]) if (finite(assessment[key])) fullScores[key] = assessment[key];
  if (text(assessment.riskGrade)) fullScores.riskGrade = assessment.riskGrade;
  const complete = Object.keys(fullScores).length === 3;
  const insufficient = !complete || assessment.decisionStatus === "insufficient-evidence";
  const nextSteps = [];
  for (const [group, fields] of Object.entries(missingByGroup)) {
    if (Array.isArray(fields) && fields.length) nextSteps.push(`补充：${GROUP_LABELS[group] ?? "其他 Runtime 指出的缺失数据（见结构化结果）"}`);
  }
  for (const action of requiredActions) {
    // missing-data actions are already represented by missingByGroup. Do not expose raw field
    // names as the sole explanation, or invent evidence from evidenceStrength alone.
    if (action.category === "missing-data") {
      if (!nextSteps.length) nextSteps.push("补充 Runtime 指出的缺失数据（见结构化结果）");
    } else if (ACTION_LABELS[action.category]) nextSteps.push(ACTION_LABELS[action.category]);
    else nextSteps.push("处理 Runtime 要求的补充或复核事项（见结构化结果）");
  }
  return {
    title: TITLE,
    ...(text(assessment.readinessStatus) ? { assessmentStatus: assessment.readinessStatus } : {}),
    ...(text(assessment.decisionStatus) ? { decisionStatus: assessment.decisionStatus } : {}),
    summary: insufficient ? "当前信息或证据不足以形成完整风险评级，需要补充数据或证据。" :
      "已展示 Runtime 返回的风险指标；请结合决策状态和证据强度复核。",
    ...(Object.keys(availableScores).length ? { availableScores } : {}),
    ...(Object.keys(fullScores).length ? { fullScores } : {}),
    ...(text(assessment.evidenceStrength) ? { evidenceStrength: assessment.evidenceStrength } : {}),
    nextSteps: [...new Set(nextSteps)]
  };
}

export function buildChatUserMessage({ extractedDraft = {}, assessment = {}, missingByGroup = {}, requiredActions = [] } = {}) {
  const presentation = buildChatPresentation({ assessment, missingByGroup, requiredActions });
  const sections = [TITLE];
  const facts = identifiedFacts(extractedDraft);
  if (facts.length) sections.push(`已识别（用户提供）：\n${facts.map(line => `- ${line}`).join("\n")}`);
  const dimensions = Object.entries(presentation.availableScores ?? {});
  if (dimensions.length) {
    const qualification = assessment.evidenceStrength === "low" && assessment.decisionStatus === "insufficient-evidence"
      ? "当前已提供、尚未充分核验的数据" : "当前已提供的数据";
    sections.push(`基于${qualification}，可计算的局部维度：\n${dimensions.map(([key, value]) => `- ${DIMENSION_LABELS[key] ?? key}：${value}`).join("\n")}\n\n以上为局部计算值，不代表完整风险评级。`);
  }
  const states = [];
  for (const [key, label] of [["assessmentStatus", "数据准备度"], ["evidenceStrength", "证据强度"], ["decisionStatus", "决策状态"]]) {
    if (presentation[key]) states.push(`${label}：${STATE_LABELS[presentation[key]] ?? presentation[key]}`);
  }
  const fullScores = Object.entries(presentation.fullScores ?? {});
  if (fullScores.length < 3) states.push("完整 TAI / CCI / Risk Grade：暂不可计算");
  for (const [key, value] of fullScores) states.push(`${key === "riskGrade" ? "Risk Grade" : key}：${value}`);
  sections.push(`当前状态：\n${states.map(line => `- ${line}`).join("\n")}`);
  if (presentation.nextSteps.length) sections.push(`建议优先补充或复核：\n${presentation.nextSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  sections.push(`${presentation.summary}\nFlowCredit 不会自行补全或编造缺失数据。`);
  sections.push("仅供风险评估参考，不构成授信批准、投资建议或法定审计意见。");
  return sections.join("\n\n");
}
