/**
 * Printable report rendering.
 *
 * Deliberately plain HTML + inline CSS instead of a PDF library: it needs no
 * dependency, the browser's own "Print → Save as PDF" produces the document, and
 * Bangla renders correctly with the system fonts on every platform.
 *
 * Every interpolated value is HTML-escaped, because product/customer names are
 * user input and a report is exactly the kind of place where an unescaped name
 * would become a script injection.
 */

export interface PrintTableRow {
  readonly cells: readonly (string | number | null | undefined)[];
  readonly emphasis?: boolean;
}

export interface PrintTable {
  readonly title: string;
  readonly titleBn?: string;
  readonly columns: readonly string[];
  rows: PrintTableRow[];
}

export interface PrintSummaryItem {
  readonly label: string;
  readonly labelBn?: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface PrintReportInput {
  readonly businessName: string;
  readonly reportTitle: string;
  readonly reportTitleBn: string;
  readonly periodLabel: string;
  readonly currency: string;
  readonly timezone: string;
  readonly tables: readonly PrintTable[];
  readonly summary?: readonly PrintSummaryItem[];
  readonly notes?: readonly string[];
  readonly generatedAt: string;
  /** Where the numbers came from, so a printed page is never ambiguous. */
  readonly basis?: string;
}

export interface SummaryItemLike {
  readonly label: string;
  readonly labelBn?: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderReportHtml(input: PrintReportInput): string {
  const summaryHtml =
    input.summary && input.summary.length > 0
      ? `<section class="summary">${input.summary
          .map(
            (item) =>
              `<div class="summary-item${item.emphasis ? ' emphasis' : ''}"><span class="label">${escapeHtml(item.label)}${
                item.labelBn ? `<br><span class="bn">${escapeHtml(item.labelBn)}</span>` : ''
              }</span><span class="value">${escapeHtml(item.value)}</span></div>`,
          )
          .join('')}</section>`
      : '';

  const tablesHtml = input.tables
    .filter((table) => table.rows.length > 0)
    .map(
      (table) => `
    <section class="table-block">
      <h2>${escapeHtml(table.title)}${table.titleBn ? ` <span class="bn">${escapeHtml(table.titleBn)}</span>` : ''}</h2>
      <table>
        <thead><tr>${table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
        <tbody>
          ${table.rows
            .map(
              (row) =>
                `<tr${row.emphasis ? ' class="emphasis"' : ''}>${row.cells
                  .map((cell, index) => `<td${index > 0 ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`)
                  .join('')}</tr>`,
            )
            .join('\n          ')}
        </tbody>
      </table>
    </section>`,
    )
    .join('');

  const emptyNotice = input.tables.every((table) => table.rows.length === 0) ? '<p class="empty">No rows for this period.</p>' : '';

  const notesHtml =
    input.notes && input.notes.length > 0
      ? `<section class="notes"><h2>Notes</h2><ul>${input.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>`
      : '';

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.businessName)} — ${escapeHtml(input.reportTitle)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px 40px;
    font-family: "Nirmala UI", "Noto Sans Bengali", "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
    font-size: 12.5px; line-height: 1.45; color: #14181f; background: #fff;
  }
  header { border-bottom: 2px solid #14181f; padding-bottom: 10px; margin-bottom: 14px; }
  .biz { font-size: 17px; font-weight: 700; }
  .doc-title { font-size: 14px; margin-top: 2px; }
  .meta { margin-top: 6px; color: #4b5563; font-size: 11.5px; }
  .bn { font-family: "Nirmala UI", "Noto Sans Bengali", sans-serif; }
  .summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 4px; }
  .summary-item {
    flex: 1 1 150px; border: 1px solid #d7dbe0; border-radius: 6px; padding: 8px 10px;
    display: flex; flex-direction: column; gap: 2px; background: #fafbfc;
  }
  .summary-item.emphasis { border-color: #14181f; background: #f2f4f7; }
  .summary-item .label { font-size: 11px; color: #4b5563; }
  .summary-item .value { font-size: 14px; font-weight: 700; }
  .table-block { margin-top: 16px; break-inside: avoid; }
  h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; border-bottom: 1px solid #d7dbe0; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #e6e9ed; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.emphasis td { font-weight: 700; background: #f8f9fb; }
  .notes { margin-top: 18px; font-size: 11.5px; color: #4b5563; }
  .notes ul { margin: 6px 0 0; padding-left: 18px; }
  .empty { padding: 18px; border: 1px dashed #d7dbe0; border-radius: 6px; color: #6b7280; }
  footer { margin-top: 22px; border-top: 1px solid #d7dbe0; padding-top: 8px; font-size: 10.5px; color: #6b7280; }
  .toolbar { position: fixed; right: 16px; bottom: 16px; }
  .toolbar button {
    font: inherit; padding: 8px 14px; border-radius: 999px; border: 1px solid #14181f;
    background: #14181f; color: #fff; cursor: pointer;
  }
  @media print {
    body { padding: 0; }
    .toolbar { display: none; }
    .table-block { break-inside: avoid; }
    thead { display: table-header-group; }
  }
  @page { margin: 14mm 12mm; }
</style>
</head>
<body>
  <header>
    <div class="biz">${escapeHtml(input.businessName)}</div>
    <div class="doc-title">${escapeHtml(input.reportTitle)} <span class="bn">${escapeHtml(input.reportTitleBn)}</span></div>
    <div class="meta">
      ${escapeHtml(input.periodLabel)} &middot; Currency: ${escapeHtml(input.currency)} &middot; Timezone: ${escapeHtml(input.timezone)}
      ${input.basis ? `&middot; ${escapeHtml(input.basis)}` : ''}
    </div>
  </header>

  ${summaryHtml}
  ${emptyNotice}
  ${tablesHtml}
  ${notesHtml}

  <footer>
    Generated ${escapeHtml(input.generatedAt)} by Small Business Manager.
    Figures are derived from the posted double-entry ledger${input.basis ? ` (${escapeHtml(input.basis)})` : ''}.
    This is an internal management report, not a tax or audit document; no regulatory compliance is claimed.
  </footer>

  <div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF (প্রিন্ট)</button></div>
</body>
</html>`;
}
