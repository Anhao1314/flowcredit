import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { extractPdfText, PDF_TEXT_VERSION } from "../src/connectors/pdf-text.js";

/** 构造最小合成 PDF：catalog/pages/page 结构齐全（pdf.js 需要真实页面树）。 */
function miniPdf(contentText, { encrypt = false } = {}) {
  const content = `BT /F1 10 Tf (${contentText}) Tj ET`;
  const flate = deflateSync(Buffer.from(content, "latin1"));
  const enc = encrypt ? "/Encrypt 99 0 R" : "";
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${flate.length}/Filter/FlateDecode>>stream\n${flate.toString("latin1")}\nendstream endobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj"
  ];
  return Buffer.from(
    `%PDF-1.7\n${objects.join("\n")}\n${enc}\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n`,
    "latin1"
  );
}

test("pdf-text extracts latin text from a FlateDecode stream", async () => {
  const result = await extractPdfText(miniPdf("(Revenue 1,000,000 USD) Tj"));
  assert.equal(result.version, PDF_TEXT_VERSION);
  assert.match(result.text, /Revenue 1,000,000 USD/);
  assert.equal(result.stats.pages, 1);
  assert.ok(result.stats.charsExtracted > 0);
  assert.deepEqual(result.warnings, []);
});

test("pdf-text fails closed on encrypted and non-PDF input", async () => {
  await assert.rejects(extractPdfText(miniPdf("(x) Tj", { encrypt: true })), { code: "PDF_ENCRYPTED" });
  await assert.rejects(extractPdfText(Buffer.from("not a pdf")), { code: "PDF_INVALID" });
  await assert.rejects(extractPdfText(Buffer.alloc(0)), { code: "PDF_EMPTY" });
});

test("pdf-text discloses quality when nothing extractable (image-based case)", async () => {
  // 无文本算子的流 → 空文本 + 警告（fail-closed 披露，不编造）
  const result = await extractPdfText(miniPdf(" "));
  assert.equal(result.text.trim(), "", "whitespace-only text is disclosed as empty");
  assert.ok(result.warnings.some(w => /no text extracted/.test(w)));
});
