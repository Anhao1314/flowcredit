/*
 * quant/console/markdown.js — 注记层文本的最小 markdown 渲染器（纯函数、零依赖、可单测）
 *
 * 不做什么（硬约束，违反即架构破坏；本文件任何后续修改不得删除或弱化本段）：
 *   1. 先整体 HTML 转义再做任何替换——模型输出是不可信文本，绝不产生注入面
 *      （所有块级/行内规则都作用在已转义文本上，innerHTML 只接收本模块输出）。
 *   2. 只支持块级：围栏代码/管道表格/标题/有序无序列表；行内：粗体/行内代码。
 *      不处理嵌套结构（表格内代码块等）——够用即止，不引入外部渲染库。
 *   3. 纯函数：同输入 → 同输出字符串；不读 DOM/时钟/env，Node 可直接单测。
 *      build.js 会剥离 export 前缀后内联进 index.html，浏览器与 Node 共用同一实现。
 */

const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 有序列表起点：西文 "1. / 1) " 需空格；中文 "1、" 顿号后可无空格（避免误吞 "3.5% 这类行）。
const ORDERED_EN = /^\s*\d+[.)]\s+/;
const ORDERED_CN = /^\s*\d+、/;
const isOrdered = line => ORDERED_EN.test(line) || ORDERED_CN.test(line);
const orderedParts = line => ORDERED_EN.test(line) ? line.match(/^\s*(\d+)[.)]\s+(.*)$/) : line.match(/^\s*(\d+)、\s*(.*)$/);

export function formatInline(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

export function buildTable(header, rows) {
  let html = '<div class="md-table-wrap"><table><thead><tr>';
  for (const cell of header) html += `<th>${formatInline(cell)}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += "<tr>";
    for (let i = 0; i < header.length; i++) html += `<td>${formatInline(row[i] || "")}</td>`;
    html += "</tr>";
  }
  return html + "</tbody></table></div>";
}

export function formatText(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { // 围栏开关（语言标注忽略）
      if (!inCode) { inCode = true; codeBuf = []; }
      else { out.push('<div class="md-code"><code>' + codeBuf.join("\n") + "</code></div>"); inCode = false; }
      i += 1;
      continue;
    }
    if (inCode) { codeBuf.push(line); i += 1; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) { // 表头+分隔行
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(buildTable(header, rows));
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) { out.push(`<div class="md-h${heading[1].length}">${formatInline(heading[2])}</div>`); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      out.push('<div class="md-ul">');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const item = lines[i].match(/^\s*[-*]\s+(.*)$/);
        out.push(`<div class="li"><span>${formatInline(item[1])}</span></div>`);
        i += 1;
      }
      out.push("</div>");
      continue;
    }
    if (isOrdered(line)) {
      out.push('<div class="md-ol">');
      while (i < lines.length && isOrdered(lines[i])) {
        const numbered = orderedParts(lines[i]);
        out.push(`<div class="oli"><span class="n">${numbered[1]}.</span><span>${formatInline(numbered[2])}</span></div>`);
        i += 1;
      }
      out.push("</div>");
      continue;
    }
    if (line.trim() === "") { out.push('<div style="height:6px"></div>'); i += 1; continue; }
    out.push(`<div>${formatInline(line)}</div>`);
    i += 1;
  }
  if (inCode && codeBuf.length) out.push('<div class="md-code"><code>' + codeBuf.join("\n") + "</code></div>");
  return out.join("");
}
