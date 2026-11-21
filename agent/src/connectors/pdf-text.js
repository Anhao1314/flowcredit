/*
 * src/connectors/pdf-text.js — PDF 文本提取器 v0.2.0（pdfjs-dist 引擎，确定性、质量披露）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 提取结果是"文本摘录"，不是结构化报表：数字必须由调用方（或人工）对照原文
 *      使用；本模块不解释任何数字的含义。
 *   2. 加密 PDF fail-closed；提取质量以统计披露（pages/chars/cjkRatio）——不承诺完整。
 *   3. 引擎 = pdfjs-dist（2026-11-21 人工评审引入：v0.1 纯 JS 启发式在多字体 CMap
 *      文档上产生乱码，探针证据在案）。同输入 → 同输出（pdf.js 逐页文本提取确定性）。
 *   4. 零网络、零时钟；不评估、不打分——本模块只产出文本。
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const CMAP_DIR = join(dirname(require_.resolve("pdfjs-dist/package.json")), "cmaps");

/** fs 直读包内 .bcmap（pdf.js 的 fetch 层不支持 file:// URL）。 */
class LocalCMapReaderFactory {
  constructor({ baseUrl = CMAP_DIR } = {}) { this.baseUrl = baseUrl; }
  async fetch({ name }) {
    const bytes = readFileSync(join(this.baseUrl, name + ".bcmap"));
    return { cMapData: new Uint8Array(bytes), compressionType: 1 };
  }
}

export const PDF_TEXT_VERSION = "pdf-text/v0.2.0";

const MAX_PAGES = 400;

/**
 * 提取 PDF 文本。输入 bytes（Uint8Array/Buffer）。
 * 输出 { text, version, stats: { pages, charsExtracted, cjkChars, cjkRatio }, warnings }。
 * 加密 PDF → fail-closed（PDF_ENCRYPTED）。
 */
export async function extractPdfText(bytes) {
  const data = Buffer.from(bytes ?? "");
  if (!data.length) throw pdfTextError("PDF_EMPTY", "pdf bytes are required");
  if (!data.toString("latin1", 0, 5).startsWith("%PDF")) throw pdfTextError("PDF_INVALID", "not a PDF (missing %PDF header)");
  if (data.toString("latin1").includes("/Encrypt")) throw pdfTextError("PDF_ENCRYPTED", "encrypted PDFs are not supported (fail-closed)");

  const doc = await getDocument({ data: new Uint8Array(data), useSystemFonts: false, isEvalSupported: false, CMapReaderFactory: LocalCMapReaderFactory }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const pagePieces = [];
  const warnings = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const line = content.items.map(item => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
    if (line.trim()) pagePieces.push(line.trim());
  }

  const text = pagePieces.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const stats = { pages: pageCount, charsExtracted: text.length, cjkChars: cjk, cjkRatio: text.length ? Math.round(cjk / text.length * 1000) / 1000 : 0 };
  if (doc.numPages > MAX_PAGES) warnings.push(`page cap ${MAX_PAGES} reached (${doc.numPages} total) — output truncated`);
  if (!text) warnings.push("no text extracted — the PDF may be image-based; OCR is a separate decision");
  else if (stats.cjkRatio === 0 && stats.charsExtracted > 200) warnings.push("no CJK characters decoded — Chinese text may be garbled; verify against the original document");
  return { text, version: PDF_TEXT_VERSION, stats, warnings };
}

function pdfTextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
