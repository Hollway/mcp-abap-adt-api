/**
 * Wrapping a piece of ABAP in something the system can run.
 *
 * There is no "evaluate this ABAP" endpoint. What ADT does have is runClass,
 * which executes a class that implements IF_OO_ADT_CLASSRUN - the same F9 an
 * ADT editor does. So a snippet becomes a class with that interface, its main
 * method carrying the code, and the console output comes back from the run.
 *
 * The interface on this system (SEO_ADT) declares:
 *   METHODS main IMPORTING out TYPE REF TO if_oo_adt_intrnl_classrun.
 * and `out` offers write( data ), write_text( ), display( ), begin_section( ).
 * That is what a snippet writes its output to.
 */

export class SnippetError extends Error {}

/** A name for a throwaway class: short, obvious, and unlikely to collide. */
export const snippetClassName = (prefix = 'ZMCP_SNIP', now: number = Date.now()): string => {
  const suffix = now.toString(36).toUpperCase();
  const name = `${prefix}_${suffix}`;
  if (name.length > 30) throw new SnippetError(`The generated class name ${name} is longer than 30 characters.`);
  return name;
};

export interface SnippetSpec {
  className: string;
  /** Lines of the snippet, as they go inside the main method. */
  code: string[];
  /** Extra class-level declarations: types, constants, helper methods. */
  declarations?: string[];
}

/**
 * The class that carries a snippet.
 *
 * Written the way ADT writes a class, because the source is what the backend
 * stores: interface in the public section, one method implementation.
 */
export function buildSnippetClass(spec: SnippetSpec): string {
  const name = String(spec.className || '').trim().toUpperCase();
  if (!name) throw new SnippetError('A snippet class needs a name.');
  const code = (spec.code || []).filter(line => line !== undefined && line !== null);
  if (code.length === 0) throw new SnippetError('Pass code - the ABAP to run.');

  const declarations = (spec.declarations || []).map(line => (line.trim() === '' ? '' : `    ${line}`));
  const body = code.map(line => (line.trim() === '' ? '' : `    ${line}`));

  return [
    `CLASS ${name} DEFINITION`,
    '  PUBLIC',
    '  FINAL',
    '  CREATE PUBLIC .',
    '',
    '  PUBLIC SECTION.',
    '    INTERFACES if_oo_adt_classrun .',
    ...(declarations.length ? ['  PRIVATE SECTION.', ...declarations] : []),
    'ENDCLASS.',
    '',
    '',
    '',
    `CLASS ${name} IMPLEMENTATION.`,
    '  METHOD if_oo_adt_classrun~main.',
    ...body,
    '  ENDMETHOD.',
    'ENDCLASS.',
    ''
  ].join('\n');
}

export interface DumpSummary {
  shortText?: string;
  runtimeError?: string;
  exception?: string;
  program?: string;
  when?: string;
  user?: string;
  /** Line of the snippet the dump points at, from its "show in code" link. */
  line?: number;
  /** ST22 id, for looking the whole thing up. */
  id?: string;
}

const unescapeHtml = (text: string): string => text
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

/**
 * What a dump says, in six fields instead of ten thousand characters.
 *
 * The dump feed serves an HTML page - the same one ST22 shows, links and all -
 * and it ran to 10,088 characters for a division by zero. The header table
 * carries what a caller actually needs, and the "Show Abortion in Code" link
 * carries the line of the snippet that died.
 */
export function summariseDump(dump: { id?: string; text?: string } | undefined): DumpSummary | undefined {
  if (!dump) return undefined;
  const html = String(dump.text || '');
  const field = (label: string): string | undefined => {
    const pattern = new RegExp(
      `<b>\\s*${label}\\s*</b>\\s*</td>\\s*<td>([\\s\\S]*?)</td>`, 'i'
    );
    const match = pattern.exec(html);
    return match ? unescapeHtml(match[1]).replace(/<[^>]+>/g, '').trim() || undefined : undefined;
  };
  const line = /#start=(\d+)/.exec(html);
  const summary: DumpSummary = {
    shortText: field('Short Text'),
    runtimeError: field('Runtime Error'),
    exception: field('Exception'),
    program: field('Program'),
    when: field('Date/Time'),
    user: field('User'),
    ...(line ? { line: Number(line[1]) } : {}),
    // The id is an ST22 key padded with spaces; it is only useful whole.
    ...(dump.id ? { id: decodeURIComponent(String(dump.id)).replace(/\s+/g, ' ').trim() } : {})
  };
  return Object.values(summary).some(value => value !== undefined) ? summary : undefined;
}

/**
 * The console output of a run, as text.
 *
 * runClass answers with the console as one string on this release; older or
 * newer ones have been seen to answer with an object carrying it, so both are
 * accepted rather than making the caller guess which they got.
 */
export function snippetOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['console', 'output', 'text', 'result']) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
    return JSON.stringify(result);
  }
  return result === undefined || result === null ? '' : String(result);
}
