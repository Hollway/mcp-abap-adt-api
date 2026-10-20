/**
 * Just enough Open SQL to answer the statements the graph load writes:
 * SELECT columns FROM table WHERE conditions [ORDER BY column], conditions
 * being =, >=, LIKE, NOT LIKE and IN joined by AND and OR, in parentheses.
 * Rows come back keyed by the upper-case column name, as the data preview
 * endpoint answers them.
 */
export type Tables = Record<string, Record<string, string>[]>;

type Condition = (row: Record<string, string>) => boolean;

const likeToRegex = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let value = '';
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (text[i] === "'") break;
        value += text[i++];
      }
      i++;
      tokens.push(`'${value}`);
      continue;
    }
    if (c === '(' || c === ')' || c === ',') { tokens.push(c); i++; continue; }
    if (c === '>' && text[i + 1] === '=') { tokens.push('>='); i += 2; continue; }
    if (c === '=') { tokens.push('='); i++; continue; }
    let word = '';
    while (i < text.length && !/[\s(),=>']/.test(text[i])) word += text[i++];
    tokens.push(word);
  }
  return tokens;
}

function parseConditions(tokens: string[]): Condition {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const literal = () => {
    const token = next();
    if (!token.startsWith("'")) throw new Error(`literal expected, got ${token}`);
    return token.slice(1);
  };

  const primary = (): Condition => {
    if (peek() === '(') {
      next();
      const inner = or();
      if (next() !== ')') throw new Error(') expected');
      return inner;
    }
    const column = next().toUpperCase();
    const op = next().toUpperCase();
    const value = (row: Record<string, string>) => row[column] ?? '';
    if (op === '=') { const v = literal(); return row => value(row) === v; }
    if (op === '>=') { const v = literal(); return row => value(row) >= v; }
    if (op === 'LIKE') { const r = likeToRegex(literal()); return row => r.test(value(row)); }
    if (op === 'NOT') {
      if (next().toUpperCase() !== 'LIKE') throw new Error('NOT LIKE expected');
      const r = likeToRegex(literal());
      return row => !r.test(value(row));
    }
    if (op === 'IN') {
      if (next() !== '(') throw new Error('( expected');
      const values: string[] = [];
      while (peek() !== ')') {
        values.push(literal());
        if (peek() === ',') next();
      }
      next();
      return row => values.includes(value(row));
    }
    throw new Error(`operator ${op} not supported`);
  };
  const and = (): Condition => {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      const right = primary();
      const l = left;
      left = row => l(row) && right(row);
    }
    return left;
  };
  const or = (): Condition => {
    let left = and();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      const right = and();
      const l = left;
      left = row => l(row) || right(row);
    }
    return left;
  };
  const condition = or();
  if (pos !== tokens.length) throw new Error(`unparsed: ${tokens.slice(pos).join(' ')}`);
  return condition;
}

export interface FakeSql {
  rows(sql: string, rowNumber: number): Promise<Record<string, string>[]>;
  /** Every statement run, for assertions about paging and length. */
  statements: string[];
}

export function fakeSql(tables: Tables): FakeSql {
  const statements: string[] = [];
  return {
    statements,
    async rows(sql: string, rowNumber: number) {
      statements.push(sql);
      if (sql.length > 255) throw new Error(`statement over 255 characters: ${sql}`);
      const match = /^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)\s+WHERE\s+([\s\S]+?)(?:\s+ORDER BY\s+(\w+))?$/i.exec(sql);
      if (!match) throw new Error(`cannot run: ${sql}`);
      const columns = match[1].split(',').map(column => column.trim().toUpperCase());
      const table = tables[match[2].toLowerCase()] || [];
      const where = parseConditions(tokenize(match[3]));
      let rows = table.filter(where);
      if (match[4]) {
        const key = match[4].toUpperCase();
        // Binary order, as the database sorts and as >= compares.
        rows = [...rows].sort((a, b) => ((a[key] ?? '') < (b[key] ?? '') ? -1 : (a[key] ?? '') > (b[key] ?? '') ? 1 : 0));
      }
      return rows.slice(0, rowNumber).map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? ''])));
    }
  };
}
