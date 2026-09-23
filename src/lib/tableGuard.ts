/**
 * No lock - and so no write, patch or delete - on a database table.
 *
 * ADT serves a transparent table and a structure from the same collection,
 * ddic/structures, as the same DDL text (see lib/ddicStructure). Nothing in
 * the address tells them apart, so a table can be locked, rewritten and
 * activated exactly like a structure - and a table rewritten that way can
 * lose what the DDL text does not carry (technical settings, enhancement
 * category, the conversion SE14 would have run), leaving it broken or
 * inactive in the middle of a transport. That has happened; the definition
 * of a table is changed in SE11, never over this bridge.
 *
 * Every write needs a lock first, so this is checked where the lock is taken:
 * the lock tool, editObject and lib/lockCycle (every composite write). The
 * table class comes from DD02L. Only a plain structure (INTTAB) passes - an
 * append structure changes the table it is appended to when it activates, so
 * it is refused like the table itself. A name DD02L does not know at all is
 * let through: it cannot be a table, and a structure this bridge has just
 * created has no active row yet. Anything that cannot be decided - an
 * unreadable name, a failed query - is refused rather than guessed.
 *
 * There is deliberately no switch to turn this off.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ddicName } from './tableFields';
import { describeAdtError } from './adtError';

/** What runQuery is needed for - the stateful client or a clone both do. */
export interface TableClassReader {
  runQuery(sql: string, rowNumber?: number, decode?: boolean): Promise<any>;
}

const DDIC_OBJECT = /^\/sap\/bc\/adt\/ddic\/(structures|tables)\/([^/?#]+)/i;

const REFUSAL_TAIL =
  'Change the definition of a table in SE11 - this bridge never locks, writes or deletes one. getStructureSource and tableFields still read it.';

export class TableWriteRefused extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = 'TableWriteRefused';
  }
}

/** The DDIC name behind a ddic/structures or ddic/tables address, if it is one. */
export function ddicObjectOf(objectUrl: string): { collection: string; name: string } | undefined {
  const match = String(objectUrl ?? '').trim().match(DDIC_OBJECT);
  if (!match) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(match[2]);
  } catch {
    name = match[2];
  }
  return { collection: match[1].toLowerCase(), name: name.trim().toUpperCase() };
}

export const tableClassQuery = (name: string): string =>
  `SELECT tabname,as4local,tabclass FROM dd02l WHERE tabname = '${ddicName(name)}'`;

/**
 * Throws TableWriteRefused unless the address is harmless: not a DDIC table
 * or structure address at all, or a plain structure.
 */
export async function assertNotTable(client: TableClassReader, objectUrl: string): Promise<void> {
  const target = ddicObjectOf(objectUrl);
  if (!target) return;

  if (target.collection === 'tables') {
    throw new TableWriteRefused(`${target.name} is addressed as a table (${objectUrl}). ${REFUSAL_TAIL}`);
  }

  let sql: string;
  try {
    sql = tableClassQuery(target.name);
  } catch {
    throw new TableWriteRefused(
      `Cannot tell whether "${target.name}" is a table or a structure - the name is not a valid DDIC name - so it is not locked. ${REFUSAL_TAIL}`
    );
  }

  let rows: any[];
  try {
    const result: any = await client.runQuery(sql, 10);
    rows = Array.isArray(result?.values) ? result.values : [];
  } catch (error: any) {
    throw new TableWriteRefused(
      `Cannot tell whether ${target.name} is a table or a structure - reading DD02L failed (${describeAdtError(error).error}) - so it is not locked. ${REFUSAL_TAIL}`
    );
  }

  const classes = [...new Set(
    rows.map(row => String(row?.TABCLASS ?? '').trim().toUpperCase()).filter(Boolean)
  )];
  if (rows.length && !classes.length) {
    throw new TableWriteRefused(
      `Cannot tell whether ${target.name} is a table or a structure - DD02L has it but names no class - so it is not locked. ${REFUSAL_TAIL}`
    );
  }
  const foreign = classes.filter(tabclass => tabclass !== 'INTTAB');
  if (foreign.length) {
    const what = foreign.includes('APPEND')
      ? 'an append structure, which changes the table it is appended to when it activates'
      : `a database table (DD02L class ${foreign.join('/')})`;
    throw new TableWriteRefused(`${target.name} is ${what}. ${REFUSAL_TAIL}`);
  }
}
