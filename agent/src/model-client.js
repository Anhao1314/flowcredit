import { createModelGateway, ModelGatewayError } from "../core/model-gateway.js";

/** Credit compatibility adapter: plain JSON annotations, no domain tools. */
export function createModelClient(options = {}) {
  const gateway = createModelGateway({
    apiKey: options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY,
    baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL,
    model: options.model,
    timeoutMs: options.timeoutMs || 45_000,
    maxTokens: options.maxTokens || 2_400,
    temperature: 0,
    transport: options.transport
  });

  return Object.freeze({
    async chat(messages) {
      const { message, usage } = await gateway.chat({ messages });
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw new ModelGatewayError("MODEL_MALFORMED", "model response missing content");
      }
      return { content: message.content, usage };
    },
    model: gateway.model,
    baseUrl: gateway.baseUrl,
    configured: gateway.configured
  });
}
