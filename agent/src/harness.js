/*
 * agent/src/harness.js — 可选模型层（REST，无 DSH SDK）
 *
 * 不做什么（硬约束）：
 *   1. 模型只能产出注记（分析/解释/复核）；权威字段永远由确定性引擎计算。
 *      草稿抽取不走模型：自然语言解析是确定性 parser（nl-draft-v01.js），
 *      旧 /fc/ai/v0.3/extract 模型抽取面已在瘦身中删除。
 *   2. 不向模型发送内部权重字段（w_model/w_task 等），防止其被误当作可调参数。
 *   3. 无模型时整个服务照常运行：所有方法在未配置时抛 HARNESS_UNCONFIGURED，由上层降级。
 *   4. 并发上限 2；超出抛 HARNESS_BUSY（上层降级为确定性结果，不阻塞）。
 *   5. 不落盘、不重试循环（单次 JSON 解析失败重试一次，仍失败则抛错降级）。
 *
 * 历史：v0.4.0 之前本层使用 @deepseek-ai/dsh-sdk-client（含受限工具插件）。
 * 该 SDK 已落后且引入 4 个依赖，v0.5.0 起替换为 OpenAI 兼容 REST（model-client.js）。
 */

import { MODEL } from "./constants.js";
import { createModelClient } from "./model-client.js";

export function extractJson(text) {
  const value = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(value); } catch {}
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error("Harness returned invalid JSON");
}

export class HarnessBrain {
  constructor({ timeoutMs = 45_000, transport, apiKey, baseUrl, model } = {}) {
    this.client = createModelClient({ model: model || MODEL, timeoutMs, transport, apiKey, baseUrl });
    this.maxConcurrency = 2;
    this.active = 0;
  }

  async configured() {
    return this.client.configured();
  }

  async status() {
    const configured = await this.configured();
    return {
      configured,
      ready: configured,
      model: this.client.model,
      profile: "rest",
      provider: "openai-compatible",
      error: null
    };
  }

  async #run(prompt) {
    if (this.active >= this.maxConcurrency) {
      const error = new Error("Harness concurrency limit reached");
      error.code = "HARNESS_BUSY";
      throw error;
    }
    this.active += 1;
    try {
      const result = await this.client.chat([{ role: "user", content: prompt }]);
      return extractJson(result.content);
    } finally {
      this.active -= 1;
    }
  }

  async assessV021(normalizedInput, deterministic, requestId) {
    // 发送给模型的输入摘要：剔除内部权重/派生字段，只保留可解释的业务事实。
    const inputSummary = structuredClone(normalizedInput);
    delete inputSummary.anchorScores;
    delete inputSummary.efficiencyPeerUpper;
    delete inputSummary.efficiencyPeerMultiple;
    delete inputSummary.efficiencyExcessPct;
    delete inputSummary.modelWeight;
    delete inputSummary.taskWeight;
    delete inputSummary.w_model;
    delete inputSummary.w_task;

    const deterministicSummary = {
      decisionStatus: deterministic.decisionStatus,
      simulatedDecisionStatus: deterministic.simulatedDecisionStatus,
      verdict: deterministic.verdict,
      TAI: deterministic.TAI,
      tokenActivityBand: deterministic.tokenActivityBand,
      tokenMeteringStatus: deterministic.tokenMeteringStatus,
      CCI: deterministic.CCI,
      riskGrade: deterministic.riskGrade,
      PD_pct: null,
      expectedLoss: null,
      recommendedLimit: null,
      dimensionScores: deterministic.dimensionScores,
      tokenComponentScores: deterministic.tokenComponentScores,
      evidenceQuality: deterministic.evidenceQuality,
      vetoApplied: deterministic.vetoApplied
    };

    const analysisPrompt = `Return strict JSON only: {"evidenceNotes":[up to 3 strings, each <=80 chars],"tokenOpinions":{"reconciliation":"<=80 chars","validity":"<=80 chars","physical":"<=80 chars","commercial":"<=80 chars","continuity":"<=80 chars"},"creditOpinions":{"repayment":"<=80 chars","customer":"<=80 chars","economics":"<=80 chars","continuity":"<=80 chars"},"limitations":[up to 2 strings],"explanation":"<=250 chars"}. The deterministic FlowCredit v0.2.1 result is authoritative: explain it, never recompute or invent values. TAI is activity coherence, not revenue or creditworthiness. Never change deterministic fields or invent verification, PD, expected loss, a numeric limit, or approval. DETERMINISTIC=${JSON.stringify(deterministicSummary)} INPUT=${JSON.stringify(inputSummary)}`;
    let analysis;
    try { analysis = await this.#run(analysisPrompt); }
    catch (first) {
      if (first.code === "HARNESS_UNCONFIGURED" || first.code === "HARNESS_BUSY") throw first;
      analysis = await this.#run(`${analysisPrompt}\nYour prior response was invalid or empty. Return JSON only.`);
    }

    const reviewInput = {
      analysis,
      deterministic: {
        decisionStatus: deterministic.decisionStatus, simulatedDecisionStatus: deterministic.simulatedDecisionStatus,
        verdict: deterministic.verdict, TAI: deterministic.TAI, tokenActivityBand: deterministic.tokenActivityBand,
        tokenMeteringStatus: deterministic.tokenMeteringStatus, tokenMetrics: deterministic.tokenMetrics,
        tokenComponentScores: deterministic.tokenComponentScores, CCI: deterministic.CCI, riskGrade: deterministic.riskGrade,
        PD_pct: null, expectedLoss: null, recommendedLimit: null, dimensionScores: deterministic.dimensionScores,
        evidenceQuality: deterministic.evidenceQuality, vetoApplied: deterministic.vetoApplied
      }
    };
    const reviewPrompt = `Return strict JSON only: {"conflicts":[field names],"approved":true|false,"correctedExplanation":"<=200 chars"}. Check the v0.2.1 analysis against deterministic fields. Deterministic values always win. TAI must remain distinct from CCI. PD, expected loss, numeric limit, and automatic approval must remain absent. Do not compute anything; only review the supplied text. DATA=${JSON.stringify(reviewInput)}`;
    let review;
    try { review = await this.#run(reviewPrompt); }
    catch (first) {
      if (first.code === "HARNESS_UNCONFIGURED" || first.code === "HARNESS_BUSY") throw first;
      review = await this.#run(`${reviewPrompt}\nReturn JSON only.`);
    }
    return { analysis, review };
  }

  async close() {
    // REST 客户端无长连接/子进程需要关闭。
  }
}
