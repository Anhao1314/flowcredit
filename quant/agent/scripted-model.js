/*
 * quant/agent/scripted-model.js — 冻结脚本模拟 LLM（离线治理测试专用）
 *
 * 不做什么（硬约束）：
 *   1. 无网络、无随机数、无时钟：按场景顺序回放冻结响应，同输入同输出。
 *   2. 不编造：场景耗尽即抛错（SCRIPT_EXHAUSTED），绝不自由发挥。
 *   3. 只模拟 OpenAI/DeepSeek chat.completion 的响应形状，不理解 quant 概念。
 */

/**
 * 输入：scenario（冻结数组，每项 { content } 或 { tool_calls }）。
 * 输出：fetch 同签名的 transport；响应为 chat.completion body 形状。
 */
export function createScriptedTransport(scenario) {
  if (!Array.isArray(scenario) || !scenario.length) throw new TypeError("scenario must be a non-empty array");
  let index = 0;
  return async function scriptedFetch(_url, _init) {
    if (index >= scenario.length) {
      const error = new Error("scripted scenario exhausted");
      error.code = "SCRIPT_EXHAUSTED";
      throw error;
    }
    const step = scenario[index];
    index += 1;
    const message = step.tool_calls
      ? { role: "assistant", content: step.content ?? null, tool_calls: step.tool_calls }
      : { role: "assistant", content: step.content };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message }] })
    };
  };
}
