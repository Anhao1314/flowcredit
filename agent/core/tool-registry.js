/** A closed, composable registry for deterministic domain tools. */

export class ToolRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}

function validateDefinitions(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError("tool definitions must be an array");
  const names = new Set();
  for (const tool of definitions) {
    if (!tool || typeof tool.name !== "string" || !tool.name || typeof tool.description !== "string" || typeof tool.execute !== "function") {
      throw new TypeError("each tool requires name, description and execute");
    }
    if (names.has(tool.name)) throw new TypeError(`duplicate tool: ${tool.name}`);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new TypeError(`tool ${tool.name} requires a JSON Schema parameters object`);
    }
    names.add(tool.name);
  }
}

export function createCoreToolRegistry(definitions = []) {
  validateDefinitions(definitions);
  const tools = new Map(definitions.map(tool => [tool.name, tool]));
  const list = Object.freeze([...tools.values()]);

  return Object.freeze({
    list,
    get(name) {
      return tools.get(name) || null;
    },
    schemas: Object.freeze(list.map(tool => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))),
    async execute(name, args) {
      const tool = tools.get(name);
      if (!tool) throw new ToolRegistryError("TOOL_UNKNOWN", `Unknown tool: ${name}`);
      return tool.execute(args);
    },
    extend(extraDefinitions = []) {
      return createCoreToolRegistry([...list, ...extraDefinitions]);
    }
  });
}
