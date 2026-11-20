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

const nodeById = (graph, id) => graph.nodes.find(node => node.id === id) ?? null;

/**
 * 知识查询（纯确定性）：概念（id/标签/摘要子串）、链、接缝风险、总览。
 * 单一概念命中 → 返回完整记录 + 出入关系；多命中 → 返回候选列表提示收窄。
 * 至少提供一个查询维度，否则拒绝（不返回整图）。
 */
export function queryComputeKnowledge(graph, { concept = null, chain = null, seam = null, overview = false } = {}) {
  const result = { ok: true, version: graph.version };
  let matched = false;

  if (overview) {
    matched = true;
    result.overview = {
      stats: graphStats(graph),
      chains: graph.chains.map(item => ({ name: item.name, label: item.label, steps: item.steps })),
      seams: seamMap(graph)
    };
  }

  if (chain) {
    matched = true;
    const needle = String(chain).toLowerCase();
    const found = graph.chains.filter(item => item.name.toLowerCase().includes(needle) || item.label.includes(String(chain)));
    result.chains = found.map(item => ({
      name: item.name, label: item.label,
      steps: item.steps.map(stepId => {
        const node = nodeById(graph, stepId);
        return { id: stepId, label: node?.label ?? stepId, type: node?.type ?? null };
      })
    }));
  }

  if (seam) {
    matched = true;
    if (!KG_SEAMS.includes(seam)) throw kgError("KG_INVALID_SEAM", `seam must be one of ${KG_SEAMS.join("/")}`);
    result.seam = {
      seam,
      risks: graph.nodes
        .filter(node => node.type === "risk" && node.seam === seam)
        .map(node => ({ id: node.id, label: node.label, summary: node.summary, facts: node.facts ?? [] }))
    };
  }

  if (concept) {
    matched = true;
    const needle = String(concept).toLowerCase();
    const matches = graph.nodes.filter(node =>
      node.id.toLowerCase().includes(needle)
      || node.label.toLowerCase().includes(needle)
      || String(node.summary ?? "").includes(String(concept))
    );
    if (matches.length === 1) {
      const node = matches[0];
      const { out, in: incoming } = neighborsOf(graph, node.id);
      result.concept = {
        id: node.id, type: node.type, label: node.label, summary: node.summary,
        seam: node.seam ?? null, facts: node.facts ?? [],
        related: {
          out: out.map(edge => ({ type: edge.type, label: edge.label, to: edge.to, toLabel: nodeById(graph, edge.to)?.label ?? edge.to })),
          in: incoming.map(edge => ({ type: edge.type, label: edge.label, from: edge.from, fromLabel: nodeById(graph, edge.from)?.label ?? edge.from }))
        }
      };
    } else {
      result.concepts = matches.map(node => ({ id: node.id, type: node.type, label: node.label }));
      result.hint = matches.length > 1 ? "multiple matches — narrow the query or use an exact id" : "no concept matched — try overview";
    }
  }

  if (!matched) throw kgError("KG_QUERY_EMPTY", "provide concept, chain, seam or overview");
  return result;
}
