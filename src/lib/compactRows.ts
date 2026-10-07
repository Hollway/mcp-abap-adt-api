/**
 * The data preview answer, laid out for reading rather than for a parser.
 *
 * The endpoint answers with every column described in seven fields and every
 * row as an object that repeats each column name. Measured on EKPO, fifteen
 * rows of 307 columns came to 101,703 characters: 38,329 of them column
 * metadata - keyAttribute, colType and isKeyFigure empty for every column -
 * and 63,169 rows in which the 307 names were written out fifteen times.
 * 249 of the 307 columns were blank or zero in every row.
 *
 * Here the columns are described once, as [name, type, length, description],
 * each row is an array in that order, and a column blank or zero in every
 * returned row is named in emptyColumns instead of being repeated in each
 * row. The same answer comes to 11,359 characters - 28,149 with the empty
 * columns kept - and nothing is lost: a dropped column is named, and its
 * value in every row is blank or zero.
 */

export type RowFormat = 'compact' | 'objects';

export const ROW_FORMATS: RowFormat[] = ['compact', 'objects'];

interface Column {
  name: string;
  type?: unknown;
  length?: unknown;
  description?: unknown;
  keyAttribute?: unknown;
  colType?: unknown;
  isKeyFigure?: unknown;
}

const BASE_FIELDS = ['name', 'type', 'length', 'description'] as const;
const OPTIONAL_FIELDS = ['keyAttribute', 'colType', 'isKeyFigure'] as const;

/** Zeros and the separators of an amount, a date or a time: 0, 0.00, 00000000, 00:00:00. */
const ZERO_TEXT = /^[0.,:\-\/ ]*$/;

export const isBlank = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return ZERO_TEXT.test(value.trim());
  return false;
};

export const rowFormatOf = (args: any): RowFormat =>
  args?.format === 'objects' ? 'objects' : 'compact';

/**
 * The result of the endpoint in compact form. A result without a columns or
 * values array is handed back unchanged; with no rows, nothing counts as
 * empty, because a column is only empty when there were rows to look at.
 */
export function compactResult(result: any, keepEmptyColumns = false): any {
  const columns: Column[] | undefined = Array.isArray(result?.columns) ? result.columns : undefined;
  const values: any[] | undefined = Array.isArray(result?.values) ? result.values : undefined;
  if (!columns || !values) return result;

  const empty = keepEmptyColumns || values.length === 0
    ? []
    : columns.filter(column => values.every(row => isBlank(row?.[column.name])));
  const emptyNames = new Set(empty.map(column => column.name));
  const kept = columns.filter(column => !emptyNames.has(column.name));

  const optional = OPTIONAL_FIELDS.filter(field => columns.some(column => Boolean(column[field])));
  const columnFormat = [...BASE_FIELDS, ...optional];

  return {
    format: 'compact',
    columnFormat,
    columns: kept.map(column => columnFormat.map(field => column[field] ?? null)),
    values: values.map(row => kept.map(column => row?.[column.name] ?? null)),
    ...(empty.length ? { emptyColumns: empty.map(column => column.name) } : {})
  };
}
