/*
 * agent/src/knowledge/compute-graph.js — 算力知识图谱加载器 v0.1（纯确定性，零网络）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 只校验与查询，不生成知识：图内容（节点/边/链/事实）由人工评审维护，
 *      事实必须带 source 引用——无出处不入图，本文件不产出任何"知识"。
 *   2. 完整性是硬门禁：边必须引用已存在的节点；链必须由已存在的节点组成；
 *      风险节点必须带接缝（front/back/core）；非法图在加载即失败。
 *   3. 零网络、零时钟、零推断；不评估、不打分——本图谱是领域底图，
 *      不是评估输入（评估数字永远来自确定性工具）。
 *   4. 扩展规则（graph.meta.extensionRule）：新增节点/边/事实 = 版本升级 + 人工评审。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPUTE_KG_VERSION = "flowcredit.compute_kg/v0.1";
export const DEFAULT_COMPUTE_GRAPH_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge", "compute-graph.json");
export const KG_SEAMS = Object.freeze(["front", "back", "core"]);

function kgError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireString(value, field, where) {
  if (typeof value !== "string" || !value.trim()) throw kgError("KG_INVALID", `${where}: ${field} must be a non-empty string`);
  return value;
}

/** 解析并校验知识图谱；非法抛带 code 的错误。 */
export function loadComputeGraph(text) {
  if (typeof text !== "string" || !text.trim()) throw kgError("KG_EMPTY", "knowledge graph text is required");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw kgError("KG_INVALID_JSON", "knowledge graph must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw kgError("KG_INVALID", "knowledge graph must be a JSON object");
  if (parsed.version !== COMPUTE_KG_VERSION) throw kgError("KG_VERSION_UNSUPPORTED", `version must be "${COMPUTE_KG_VERSION}"`);
  if (!Array.isArray(parsed.nodeTypes) || parsed.nodeTypes.length < 3) throw kgError("KG_INVALID", "nodeTypes[] is required");
  if (!Array.isArray(parsed.edgeTypes) || parsed.edgeTypes.length < 3) throw kgError("KG_INVALID", "edgeTypes[] is required");
  if (!Array.isArray(parsed.nodes) || !parsed.nodes.length) throw kgError("KG_INVALID", "nodes[] must be non-empty");

  const ids = new Set();
  for (const node of parsed.nodes) {
    requireString(node?.id, "id", "node");
    if (ids.has(node.id)) throw kgError("KG_INVALID", `duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!parsed.nodeTypes.includes(node.type)) throw kgError("KG_INVALID", `node ${node.id}: unknown type "${node.type}"`);
    requireString(node.label, "label", `node ${node.id}`);
    requireString(node.summary, "summary", `node ${node.id}`);
    if (node.type === "risk") {
      if (!KG_SEAMS.includes(node.seam)) throw kgError("KG_INVALID", `risk ${node.id}: seam must be one of ${KG_SEAMS.join("/")}`);
    }
    for (const fact of node.facts ?? []) {
      requireString(fact?.text, "text", `fact on ${node.id}`);
      requireString(fact?.source, "source", `fact on ${node.id}`);
    }
  }

  const edges = [];
  for (const edge of parsed.edges ?? []) {
    requireString(edge?.from, "from", "edge");
    requireString(edge?.to, "to", "edge");
    if (!parsed.edgeTypes.includes(edge.type)) throw kgError("KG_INVALID", `edge ${edge.from}->${edge.to}: unknown type "${edge.type}"`);
    requireString(edge.label, "label", `edge ${edge.from}->${edge.to}`);
    if (!ids.has(edge.from)) throw kgError("KG_INVALID", `edge references unknown node: ${edge.from}`);
    if (!ids.has(edge.to)) throw kgError("KG_INVALID", `edge references unknown node: ${edge.to}`);
    edges.push(edge);
  }

  const chains = [];
  for (const chain of parsed.chains ?? []) {
    requireString(chain?.name, "name", "chain");
    requireString(chain?.label, "label", `chain ${chain.name}`);
    if (!Array.isArray(chain.steps) || chain.steps.length < 2) throw kgError("KG_INVALID", `chain ${chain.name}: steps must have ≥2 nodes`);
    for (const step of chain.steps) {
      if (!ids.has(step)) throw kgError("KG_INVALID", `chain ${chain.name}: unknown node ${step}`);
    }
    chains.push(chain);
  }

  return { version: parsed.version, meta: parsed.meta ?? {}, nodeTypes: parsed.nodeTypes, edgeTypes: parsed.edgeTypes, nodes: parsed.nodes, edges, chains };
}

/** 从文件加载；缺失 → null（诚实未配置）；非法 → 抛错。 */
export function loadComputeGraphFile(path = DEFAULT_COMPUTE_GRAPH_FILE) {
  if (!path || !existsSync(path)) return null;
  return loadComputeGraph(readFileSync(path, "utf8"));
}

/** 接缝视图：front（变现面）/ back（支撑面）/ core（计量本体）的风险分组。 */
export function seamMap(graph) {
  const map = { front: [], back: [], core: [] };
  for (const node of graph.nodes) {
    if (node.type === "risk" && KG_SEAMS.includes(node.seam)) map[node.seam].push(node.id);
  }
  return map;
}

/** 邻接查询：出入边。 */
export function neighborsOf(graph, id) {
  return {
    out: graph.edges.filter(edge => edge.from === id),
    in: graph.edges.filter(edge => edge.to === id)
  };
}

export function chainByName(graph, name) {
  return graph.chains.find(chain => chain.name === name) ?? null;
}

export function graphStats(graph) {
  const byType = {};
  for (const node of graph.nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const facts = graph.nodes.reduce((sum, node) => sum + (node.facts?.length ?? 0), 0);
  return { nodes: graph.nodes.length, edges: graph.edges.length, chains: graph.chains.length, facts, byType };
}
