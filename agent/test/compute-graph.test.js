import assert from "node:assert/strict";
import test from "node:test";
import {
  loadComputeGraph, loadComputeGraphFile, seamMap, neighborsOf, chainByName, graphStats,
  queryComputeKnowledge, COMPUTE_KG_VERSION, DEFAULT_COMPUTE_GRAPH_FILE, KG_SEAMS
} from "../src/knowledge/compute-graph.js";

const graph = loadComputeGraphFile(DEFAULT_COMPUTE_GRAPH_FILE);

test("the committed compute knowledge graph loads with full referential integrity", () => {
  assert.ok(graph, "the committed compute-graph.json must exist");
  assert.equal(graph.version, COMPUTE_KG_VERSION);
  const stats = graphStats(graph);
  assert.ok(stats.nodes >= 40, `domain graph should be substantial, got ${stats.nodes}`);
  assert.ok(stats.edges >= 40);
  assert.ok(stats.facts >= 5, "factual claims carry sources");
  for (const type of ["layer", "resource", "actor", "instrument", "metric", "risk"]) {
    assert.ok(stats.byType[type] >= 1, `graph includes ${type} nodes`);
  }
  assert.deepEqual(KG_SEAMS, ["front", "back", "core"]);
});

test("seam map: front/back/core risks match the 前面/后面 design", () => {
  const map = seamMap(graph);
  for (const front of ["K_demand_break", "K_customer_concentration", "K_contract_expiry", "K_buyer_capital_burn"]) {
    assert.ok(map.front.includes(front), `front seam includes ${front}`);
  }
  for (const back of ["K_power_constraint", "K_chip_generation", "K_capital_wall", "K_collateral_collapse"]) {
    assert.ok(map.back.includes(back), `back seam includes ${back}`);
  }
  assert.deepEqual(map.core, ["K_fake_traffic"], "计量本体只有假流量一种风险");
});

test("the five named chains all resolve and the thesis chain runs token→TAI→CCI", () => {
  for (const name of ["physical", "commercial", "financial", "credit", "thesis"]) {
    const chain = chainByName(graph, name);
    assert.ok(chain, `chain ${name} exists`);
    for (const step of chain.steps) {
      assert.ok(graph.nodes.some(node => node.id === step), `chain ${name}: node ${step} exists`);
    }
  }
  assert.deepEqual(chainByName(graph, "thesis").steps, ["L4_neocloud", "M_token", "M_tai", "M_cci"]);
});

test("neighbor query: M_token sits between the physical chain and the credit thesis", () => {
  const { out, in: incoming } = neighborsOf(graph, "M_token");
  assert.ok(incoming.some(edge => edge.from === "L4_neocloud" && edge.type === "measured-as"));
  assert.ok(out.some(edge => edge.to === "M_revenue" && edge.type === "converts-to"));
  assert.ok(out.some(edge => edge.to === "M_tai" && edge.type === "evaluated-by"));
  assert.ok(incoming.some(edge => edge.from === "K_fake_traffic" && edge.type === "threatens"), "假流量威胁计量本体本身");
});

test("factual claims carry sources; key facts cite primary filings", () => {
  const offtake = graph.nodes.find(node => node.id === "I_offtake");
  assert.ok(offtake.facts[0].source.includes("424B4"));
  assert.match(offtake.facts[0].text, /900\.9/);
  const gpuLoan = graph.nodes.find(node => node.id === "I_gpu_loan");
  assert.ok(gpuLoan.facts.length >= 1);
});

test("malformed graphs fail with coded errors", () => {
  assert.throws(() => loadComputeGraph("{}"), { code: "KG_VERSION_UNSUPPORTED" });
  const base = JSON.stringify(loadComputeGraphFile(DEFAULT_COMPUTE_GRAPH_FILE));
  const dup = JSON.parse(base);
  dup.nodes.push({ ...dup.nodes[0] });
  assert.throws(() => loadComputeGraph(JSON.stringify(dup)), /duplicate node id/);
  const dangling = JSON.parse(base);
  dangling.edges.push({ from: "L1_power", type: "energizes", to: "NOPE", label: "x" });
  assert.throws(() => loadComputeGraph(JSON.stringify(dangling)), /unknown node: NOPE/);
  const riskless = JSON.parse(base);
  riskless.nodes.find(node => node.id === "K_demand_break").seam = "side";
  assert.throws(() => loadComputeGraph(JSON.stringify(riskless)), /seam must be one of/);
  const unsourced = JSON.parse(base);
  unsourced.nodes.find(node => node.id === "I_gpu_loan").facts[0].source = "";
  assert.throws(() => loadComputeGraph(JSON.stringify(unsourced)), /source must be a non-empty string/, "facts without evidence are rejected");
});

test("missing file is null (honest unconfigured)", () => {
  assert.equal(loadComputeGraphFile("/nonexistent/graph.json"), null);
});

test("queryComputeKnowledge: concept / chain / seam / overview paths", () => {
  const single = queryComputeKnowledge(graph, { concept: "I_offtake" });
  assert.equal(single.concept.id, "I_offtake");
  assert.equal(single.concept.type, "instrument");
  assert.ok(single.concept.facts[0].text.includes("900.9"));
  assert.ok(single.concept.related.out.some(edge => edge.to === "M_commitment_coverage"));

  const fuzzy = queryComputeKnowledge(graph, { concept: "承购" });
  assert.ok(fuzzy.concepts.length >= 1, "label substring matches 承购承诺");

  const chain = queryComputeKnowledge(graph, { chain: "credit" });
  assert.equal(chain.chains[0].steps[0].id, "A_enduser");
  assert.equal(chain.chains[0].steps.at(-1).id, "I_debt_service");

  const seam = queryComputeKnowledge(graph, { seam: "front" });
  assert.equal(seam.seam.risks.length, 4);

  const overview = queryComputeKnowledge(graph, { overview: true });
  assert.equal(overview.overview.stats.nodes, graph.nodes.length);
  assert.equal(overview.overview.chains.length, graph.chains.length);

  assert.throws(() => queryComputeKnowledge(graph, {}), { code: "KG_QUERY_EMPTY" });
  assert.throws(() => queryComputeKnowledge(graph, { seam: "side" }), { code: "KG_INVALID_SEAM" });
});
