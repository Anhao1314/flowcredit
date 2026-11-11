/*
 * quant/test/quant-console-markdown.test.js — 注记层 markdown 渲染器单测（纯函数、离线）
 *
 * 不做什么（硬约束）：
 *   1. 不触 DOM/浏览器：只测 quant/console/markdown.js 的纯函数（与 index.html 内联实现同源）。
 *   2. 安全面优先：模型输出是不可信文本——转义必须先于任何替换（XSS 用例锁死）。
 *   3. 不测视觉样式，只测产出 HTML 的结构。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUANT = join(HERE, "..");
const { formatInline, splitRow, buildTable, formatText } = await import(join(QUANT, "console", "markdown.js"));
const { computeConsolePayload } = await import(join(QUANT, "console", "payload.js"));

test("escape-first: raw HTML in model output can never reach innerHTML", () => {
  const html = formatText('<img src=x onerror=alert(1)> & <script>alert(1)</script>');
  assert.match(html, /&lt;img/, "尖括号必须被转义");
  assert.match(html, /&amp;/);
  assert.doesNotMatch(html, /<img|<script/);
});

test("inline: bold and inline code (existing bullet/heading semantics preserved)", () => {
  assert.equal(formatInline("**a** and `b c`"), "<b>a</b> and <code>b c</code>");
  const out = formatText("标题行\n- **要点** 一\n- 要点 二");
  assert.match(out, /<b>要点<\/b>/);
  assert.equal((out.match(/class="li"/g) || []).length, 2);
});

test("ordered list: arabic markers with . / 、 / ) separators", () => {
  const out = formatText("1. 第一条\n2、第二条\n3) 第三条");
  assert.equal((out.match(/class="oli"/g) || []).length, 3);
  assert.match(out, /<span class="n">2\.<\/span><span>第二条<\/span>/);
});

test("headings map to md-h1..md-h4", () => {
  const out = formatText("# H1\n## H2\n### H3\n#### H4");
  for (const level of [1, 2, 3, 4]) assert.match(out, new RegExp(`class="md-h${level}"`));
});

test("table: header+separator detection, bold in cells, short rows tolerated", () => {
  const out = formatText("| a | b |\n| --- | --- |\n| 1 | **x** |\n| only-one |");
  assert.equal((out.match(/<th>/g) || []).length, 2);
  assert.equal((out.match(/<td>/g) || []).length, 4);
  assert.match(out, /<td><b>x<\/b><\/td>/);
  assert.match(out, /<td><\/td>/);
});

test("table: non-separator second line is not treated as a table", () => {
  const out = formatText("| a | b |\n| 普通文字 |");
  assert.doesNotMatch(out, /<table>/);
  assert.match(out, /<div>/);
});

test("fenced code: content verbatim-escaped, language tag ignored, unclosed fence flushed", () => {
  const out = formatText("```js\nconst a = x < y && b > c;\n```\n尾行");
  assert.match(out, /class="md-code"/);
  assert.match(out, /const a = x &lt; y &amp;&amp; b &gt; c;/);
  assert.doesNotMatch(out, /js<\/code>/, "语言标注不得进入代码体");
  const unclosed = formatText("```\nline1\nline2");
  assert.equal((unclosed.match(/class="md-code"/g) || []).length, 1);
  assert.match(unclosed, /line1\nline2/);
});

test("splitRow/buildTable: edge trimming and row padding", () => {
  assert.deepEqual(splitRow("| a | b | "), ["a", "b"]);
  const table = buildTable(["h1", "h2"], [["v1"]]);
  assert.equal((table.match(/<td>/g) || []).length, 2);
});

test("determinism: same input → identical output string", () => {
  const sample = "# t\n- a `c`\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet i = 0;\n```";
  assert.equal(formatText(sample), formatText(sample));
});

test("payload: build without generatedAtUtc is deterministic and carries frozen data-as-of", async () => {
  // 隔离可变输入：node --test 并行跑各测试文件，共享 tmpdir 的审计目录会被其他
  // 用例并发写入——指向本测试独占的空目录，载荷才只由冻结产物决定。
  const sandbox = await mkdtemp(join(tmpdir(), "quant-payload-det-"));
  const a = await computeConsolePayload({ auditDir: sandbox, paperAuditDir: sandbox });
  const b = await computeConsolePayload({ auditDir: sandbox, paperAuditDir: sandbox });
  assert.equal(JSON.stringify(a) === JSON.stringify(b), true, "两次构建载荷必须逐字节一致（去时间戳）");
  assert.equal(a.generatedAtUtc, null);
  assert.equal(typeof a.datasets.v002.fetchedAtUtc, "string");
  assert.match(a.datasets.v002.fetchedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
  await rm(sandbox, { recursive: true, force: true });
});
