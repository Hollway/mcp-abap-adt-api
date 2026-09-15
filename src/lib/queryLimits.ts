/**
 * What the data preview endpoint accepts as a statement.
 *
 * It refuses anything longer than 255 characters, and says so as "Maximum
 * number of characters in a row exceeds 255" - which reads as a limit on the
 * rows of the result rather than on the query. Measured on a classic ERP
 * system: 250 characters answer, 292 come back as that error, and wrapping
 * the text over several lines changes nothing, so it is the whole statement
 * that is counted.
 *
 * Anything here that reads a list of names therefore asks in pieces.
 */
export const MAX_QUERY_CHARS = 255;

export const quoteSql = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

/** One statement per piece of the value list that fits inside the limit. */
export function chunkedQueries(prefix: string, values: string[], suffix = ')', max = MAX_QUERY_CHARS): string[] {
  const queries: string[] = [];
  let current: string[] = [];
  const size = (parts: string[]) => prefix.length + parts.join(', ').length + suffix.length;
  for (const value of values) {
    const quoted = quoteSql(value);
    if (current.length && size([...current, quoted]) > max) {
      queries.push(prefix + current.join(', ') + suffix);
      current = [];
    }
    current.push(quoted);
  }
  if (current.length) queries.push(prefix + current.join(', ') + suffix);
  return queries;
}
