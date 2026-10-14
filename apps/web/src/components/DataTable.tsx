import type { ReactNode } from 'react';
import { visibleColumns, type GatedColumn } from '../api/permissions';
import { useT } from '../state/AppContext';

/** A table that stacks into cards on narrow screens. */

export interface Column<T> extends GatedColumn {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  readonly align?: 'left' | 'right';
  readonly numeric?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  getKey,
  permissions,
  caption,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly getKey: (row: T, index: number) => string;
  readonly permissions: readonly string[];
  readonly caption?: string;
}) {
  const { t } = useT();
  const shown = visibleColumns(columns, permissions);
  if (rows.length === 0) {
    return (
      <div className="state state--empty">
        <p className="state__title">{t('common.empty')}</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {shown.map((column) => (
              <th key={column.id} scope="col" className={column.align === 'right' ? 'is-right' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getKey(row, index)}>
              {shown.map((column, columnIndex) => (
                <td
                  key={column.id}
                  className={column.align === 'right' ? 'is-right' : undefined}
                  {...(columnIndex > 0 ? { 'data-label': typeof column.header === 'string' ? column.header : '' } : {})}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
