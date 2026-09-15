/**
 * Quick-fix proposals, trimmed to what a caller reads and what the next call
 * needs.
 *
 * The backend answers with ADT bookkeeping around an HTML description that
 * arrives double-escaped - &lt;p&gt;Starts the rename wizard&lt;/p&gt; - so
 * the text of a proposal could not be read without decoding it by hand. Each
 * row keeps every field fixEdits dereferences, so a row handed straight back
 * still works.
 */
import { htmlToText } from './htmlText';

export interface FixProposalRow {
  name: string;
  type: string;
  description: string;
  /** The quickfixes endpoint fixEdits posts to. */
  'adtcore:uri': string;
  uri: string;
  line: number;
  column: number;
  userContent: string;
}

export const FIX_PROPOSAL_FIELDS = ['adtcore:uri', 'uri', 'line', 'column'];

export function fixProposalRows(result: unknown): FixProposalRow[] {
  const rows = Array.isArray(result) ? result : result ? [result] : [];
  return rows.map((p: any) => ({
    name: String(p?.['adtcore:name'] ?? ''),
    type: String(p?.['adtcore:type'] ?? ''),
    description: htmlToText(String(p?.['adtcore:description'] ?? '')),
    'adtcore:uri': String(p?.['adtcore:uri'] ?? ''),
    uri: String(p?.uri ?? ''),
    line: Number(p?.line ?? 0),
    column: Number(p?.column ?? 0),
    userContent: String(p?.userContent ?? '')
  }));
}
