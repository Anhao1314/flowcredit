import assert from "node:assert/strict";
import test from "node:test";
import {
  createHkexConnector, isAllowedHkexUrl, unwrapHkexResult, unwrapJsonp, HKEX_EVENT_KEYWORDS
} from "../src/connectors/hkex.js";
import { createConnectorRegistry } from "../src/connectors/contract.js";
import { createRiskToolRegistry } from "../src/risk-tools.js";

const connectors = createConnectorRegistry([]);

const JSONP_PREFIX = 'cb({"more":"1","stockInfo":[{"stockId":1000286746,"code":"00100","name":"MINIMAX-W"}]});';
const ANNOUNCEMENTS = {
  result: JSON.stringify([
    { DATE_TIME: "05/11/2026 19:08", TITLE: "截至二零二六年十月三十一日止月份之股份發行人的證券變動月報表", FILE_TYPE: "PDF", FILE_LINK: "/listedco/listconews/sehk/2026/1105/2026110501847_c.pdf", STOCK_CODE: "00100", STOCK_NAME: "MINIMAX-W", NEWS_ID: "12402695" },
    { DATE_TIME: "23/10/2026 22:33", TITLE: "自願公告 業績 提前發佈", FILE_TYPE: "PDF", FILE_LINK: "/listedco/listconews/sehk/2026/1023/2026102301676_c.pdf", STOCK_CODE: "00100", STOCK_NAME: "MINIMAX-W", NEWS_ID: "12400001" }
  ]),
  hasNextRow: false, recordCnt: 2
};

const asResponse = bytes => ({ ok: true, status: 200, arrayBuffer: async () => bytes });

function connectorWith() {
  return createHkexConnector({
    transport: async url => {
      assert.ok(isAllowedHkexUrl(url), "only allowlisted URLs are fetched");
      if (url.startsWith("https://www1.hkexnews.hk/search/prefix.do")) return asResponse(Buffer.from(JSONP_PREFIX));
      if (url.startsWith("https://www1.hkexnews.hk/search/titleSearchServlet.do")) return asResponse(Buffer.from(JSON.stringify(ANNOUNCEMENTS)));
      if (url.endsWith(".pdf")) return asResponse(Buffer.from("%PDF-1.7 fake-bytes-for-hash-probe"));
      throw new Error("unexpected url: " + url);
    }
  });
}

test("HKEX allowlist is host and path bound; wrappers unwrap deterministically", () => {
  assert.equal(isAllowedHkexUrl("https://www1.hkexnews.hk/search/prefix.do?x=1"), true);
  assert.equal(isAllowedHkexUrl("https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1105/x_c.pdf"), true);
  assert.equal(isAllowedHkexUrl("https://evil.example/search/prefix.do"), false);
  assert.equal(isAllowedHkexUrl("https://www1.hkexnews.hk/other/path"), false);
  assert.deepEqual(unwrapJsonp(JSONP_PREFIX).stockInfo[0].code, "00100");
  const recs = unwrapHkexResult(JSON.stringify(ANNOUNCEMENTS));
  assert.equal(recs.length, 2);
});

test("discoverStock finds MINIMAX-W by name prefix via JSONP", async () => {
  const hkex = connectorWith();
  const r = await hkex.discoverStock({ name: "minimax" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.stocks, [{ stockId: 1000286746, code: "00100", name: "MINIMAX-W" }]);
  await assert.rejects(hkex.discoverStock({ name: "" }), /stock name prefix is required/);
});

test("listAnnouncements unwraps the double JSON and normalizes dates/links", async () => {
  const hkex = connectorWith();
  const r = await hkex.listAnnouncements({ stockId: 1000286746 });
  assert.equal(r.count, 2);
  assert.equal(r.announcements[0].date, "2026-11-05", "DD/MM/YYYY → ISO");
  assert.equal(r.announcements[0].fileLink, "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1105/2026110501847_c.pdf");
  await assert.rejects(hkex.listAnnouncements({ stockId: 0 }), /stockId is required/);
});

test("screenEvents uses the frozen keyword table and marks candidates only", async () => {
  const hkex = connectorWith();
  const r = await hkex.listAnnouncements({ stockId: 1000286746 });
  const events = hkex.screenEvents(r.announcements);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "results");
  assert.ok(HKEX_EVENT_KEYWORDS.every(marker => marker.pattern instanceof RegExp));
});

test("fetchDocument returns sha256 provenance without content parsing", async () => {
  const hkex = connectorWith();
  const doc = await hkex.fetchDocument({ fileLink: "/listedco/listconews/sehk/2026/1105/2026110501847_c.pdf" });
  assert.match(doc.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(doc.bytes, 34);
  assert.match(doc.note, /不解析|not.*wired|獨立工程項|提取/i);
});

test("query_hkex_filings tool: discovery + list + events; unconfigured fails closed", async () => {
  const bare = createRiskToolRegistry({ connectors });
  const unconfigured = await bare.get("query_hkex_filings").execute({ name: "MiniMax" });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "HKEX_CONNECTOR_UNAVAILABLE");

  const registry = createRiskToolRegistry({ connectors, hkex: connectorWith() });
  const result = await registry.get("query_hkex_filings").execute({ name: "MiniMax", events: true });
  assert.equal(result.ok, true);
  assert.equal(result.discovery.stocks[0].code, "00100");
  assert.equal(result.announcements.length, 2);
  assert.equal(result.eventCandidates.length, 1);
  assert.match(result.note, /尽力而为/);
  await assert.rejects(() => registry.get("query_hkex_filings").execute({}), /provide name \(discovery\) or stockId/, "configured connector still validates args");

  const extractRegistry = createRiskToolRegistry({
    connectors,
    hkex: createHkexConnector({
      transport: async url => {
        if (url.includes("company_tickers") || url.includes("prefix.do")) return asResponse(Buffer.from(JSONP_PREFIX));
        if (url.includes("titleSearchServlet")) return asResponse(Buffer.from(JSON.stringify(ANNOUNCEMENTS)));
        return asResponse(Buffer.from("%PDF-1.7\n1 0 obj<</Length 45>>stream\n(BT /F1 10 Tf (2026) Tj ET) endstream endobj"));
      }
    })
  });
  const extracted = await extractRegistry.get("query_hkex_filings").execute({ name: "MiniMax", extractText: true });
  assert.equal(extracted.ok, true);
  assert.ok(extracted.extractions.length >= 1, "extraction runs on listed documents");
  assert.match(extracted.extractions[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(extracted.extractions[0].extraction.ok, true);
});
