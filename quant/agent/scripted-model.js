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

/**
 * 流式版脚本 transport：按场景顺序回放 SSE 帧（OpenAI 兼容 stream 增量形状）。
 * - 内容按 chunkSize 码点切片（确定性切分，无随机数）；
 * - tool_calls 用两帧（name 帧 + arguments 帧）+ finish_reason=tool_calls；
 * - step.usage 可选（模拟 stream_options.include_usage 的末尾 usage 帧）。
 * 响应体为 web ReadableStream——与真实 fetch Response.body 同构，client.chatStream 可直接读。
 */
export function createScriptedStreamTransport(scenario, { chunkSize = 7 } = {}) {
  if (!Array.isArray(scenario) || !scenario.length) throw new TypeError("scenario must be a non-empty array");
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new TypeError("chunkSize must be a positive integer");
  const encoder = new TextEncoder();
  let index = 0;
  return async function scriptedStreamFetch(_url, _init) {
    if (index >= scenario.length) {
      const error = new Error("scripted scenario exhausted");
      error.code = "SCRIPT_EXHAUSTED";
      throw error;
    }
    const step = scenario[index];
    index += 1;
    const events = [];
    if (step.tool_calls) {
      step.tool_calls.forEach((call, callIndex) => {
        events.push({ delta: { role: "assistant", tool_calls: [{ index: callIndex, id: call.id ?? `call-${callIndex + 1}`, type: "function", function: { name: call.function?.name ?? "", arguments: "" } }] } });
        events.push({ delta: { tool_calls: [{ index: callIndex, function: { arguments: call.function?.arguments ?? "" } }] } });
      });
      events.push({ delta: {}, finish_reason: "tool_calls" });
    } else {
      const chars = Array.from(step.content ?? "");
      for (let i = 0; i < chars.length; i += chunkSize) {
        events.push({ delta: { content: chars.slice(i, i + chunkSize).join("") } });
      }
      events.push({ delta: {}, finish_reason: "stop" });
    }
    let text = "";
    for (const event of events) text += `data: ${JSON.stringify({ choices: [event] })}\n\n`;
    if (step.usage) text += `data: ${JSON.stringify({ choices: [], usage: step.usage })}\n\n`;
    text += "data: [DONE]\n\n";
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        }
      })
    };
  };
}
