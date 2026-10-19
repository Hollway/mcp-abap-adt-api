/**
 * The main program an include is activated in.
 *
 * The inactive list names a report include by its bare URI, and activation
 * refuses that with 500 invalidMainProgram, "Select a master program for
 * include X in the properties view" - for every include that belongs to any
 * program at all. CL_SEDI_ADT_WB_HELPER->is_frame_program_valid raises it
 * whenever the context check is on and the URI carries no ?context=: it does
 * not pick the only main program there is, it asks for one. Eclipse sends the
 * one chosen in the properties view; nothing here did, and over two weeks of
 * task chats that refusal came back 165 times (activateSafe 97,
 * activateObjects 54, editObject 8, activateByName 3), each time worked round
 * by hand with ?context= written into the URI.
 *
 * So the URI gets the context here, the way Eclipse sends it: the main program
 * from mainPrograms when there is exactly one; the one being activated in the
 * same call when there are several and one of them is; the one the caller
 * named otherwise. An include no active program contains yet - a new include
 * in a program whose INCLUDE statement is not active either - goes without
 * one: with a context the backend answers "Master program X is invalid for
 * include Y" (message 007 of SADT_TOOLS_CORE), the other way round. If the
 * backend still refuses, the one include it names is flipped and the call is
 * made once more: a refused activation activates nothing.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ADTClient } from 'abap-adt-api';
import { describeAdtError } from './adtError';

export interface ActivationEntry {
  'adtcore:uri': string;
  'adtcore:type': string;
  'adtcore:name': string;
  'adtcore:parentUri': string;
}

export interface MainProgramRef {
  uri: string;
  name: string;
}

export interface IncludeContext {
  include: string;
  /** The main program the include was activated in; absent when it went without one. */
  mainProgram?: string;
  from: 'only' | 'inThisActivation' | 'argument' | 'none' | 'retry';
  /** Every main program there was to choose from, when there were several. */
  candidates?: string[];
}

const INCLUDE_PATH = /^\/sap\/bc\/adt\/programs\/includes\/[^/?#]+$/i;
const PROGRAM_BASE = '/sap/bc/adt/programs/programs/';

/** A report include URI with no context yet - the only kind this adds one to. */
export const needsContext = (entry: ActivationEntry): boolean =>
  String(entry['adtcore:type'] || '').toUpperCase() === 'PROG/I' && INCLUDE_PATH.test(String(entry['adtcore:uri'] || ''));

export const withContext = (uri: string, mainUri: string): string =>
  `${uri.split('?')[0]}?context=${encodeURIComponent(mainUri)}`;

export const withoutContext = (uri: string): string => uri.split('?')[0];

export const hasContext = (uri: string): boolean => /[?&]context=/.test(uri);

/** A main program as a URI, from a name or a URI. */
export function mainProgramUri(given: string): string {
  const value = String(given || '').trim();
  if (!value) return '';
  if (value.startsWith('/')) return value.split('?')[0].replace(/\/source\/main$/, '');
  if (!/^[A-Z0-9_/]+$/i.test(value)) {
    throw new McpError(ErrorCode.InvalidParams, `'${given}' is not a program name or URI.`);
  }
  return `${PROGRAM_BASE}${encodeURIComponent(value.toLowerCase())}`;
}

const nameOf = (uri: string): string => decodeURIComponent(uri.split('?')[0].split('/').pop() || '').toUpperCase();

/**
 * Which main program, if any. Returns a refusal text when there are several
 * and nothing says which.
 */
export function chooseMainProgram(
  include: string,
  mains: MainProgramRef[],
  activating: Set<string>,
  given?: string
): IncludeContext | { refusal: string } {
  if (given) {
    const uri = mainProgramUri(given);
    const known = mains.find(main => main.uri.toLowerCase() === uri.toLowerCase());
    if (mains.length && !known) {
      return { refusal: `${nameOf(uri)} is not a main program of ${include}; its main programs are ${mains.map(main => main.name).join(', ')}.` };
    }
    return { include, mainProgram: known?.uri ?? uri, from: 'argument' };
  }
  if (mains.length === 0) return { include, from: 'none' };
  if (mains.length === 1) return { include, mainProgram: mains[0].uri, from: 'only' };
  const inCall = mains.filter(main => activating.has(main.uri.toLowerCase()));
  const candidates = mains.map(main => main.name);
  if (inCall.length === 1) return { include, mainProgram: inCall[0].uri, from: 'inThisActivation', candidates };
  return {
    refusal: `${include} belongs to ${mains.length} main programs (${candidates.join(', ')}), and activation needs to know which one it is activated in. Pass mainProgram.`
  };
}

/** The main programs of an include, as mainPrograms answers them. A failed lookup counts as none. */
export async function mainProgramsOf(
  client: Pick<ADTClient, 'mainPrograms'>,
  includeUri: string
): Promise<MainProgramRef[]> {
  try {
    const rows: any[] = await client.mainPrograms(withoutContext(includeUri));
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({ uri: String(row?.['adtcore:uri'] || '').split('?')[0], name: String(row?.['adtcore:name'] || '').toUpperCase() }))
      .filter(main => main.uri);
  } catch {
    return [];
  }
}

/**
 * The entries with a context on every report include that needs one. Entries
 * that already carry a context, and everything that is not a report include,
 * go as they came.
 */
export async function addIncludeContexts(
  client: Pick<ADTClient, 'mainPrograms'>,
  entries: ActivationEntry[],
  mainProgram?: string
): Promise<{ entries: ActivationEntry[]; contexts: IncludeContext[] }> {
  const activating = new Set(entries.map(entry => withoutContext(String(entry['adtcore:uri'] || '')).toLowerCase()));
  const contexts: IncludeContext[] = [];
  const refusals: string[] = [];
  const result: ActivationEntry[] = [];
  for (const entry of entries) {
    if (!needsContext(entry)) {
      result.push(entry);
      continue;
    }
    const include = String(entry['adtcore:name'] || nameOf(entry['adtcore:uri'])).toUpperCase();
    const choice = chooseMainProgram(include, await mainProgramsOf(client, entry['adtcore:uri']), activating, mainProgram);
    if ('refusal' in choice) {
      refusals.push(choice.refusal);
      result.push(entry);
      continue;
    }
    contexts.push(choice);
    result.push(choice.mainProgram ? { ...entry, 'adtcore:uri': withContext(entry['adtcore:uri'], choice.mainProgram) } : entry);
  }
  if (refusals.length) throw new McpError(ErrorCode.InvalidParams, `${refusals.join(' ')} Nothing was activated.`);
  return { entries: result, contexts };
}

/** The include a main-program refusal is about, or undefined when it is not one. */
export function refusedInclude(error: unknown): { include: string; wantsContext: boolean } | undefined {
  const info = describeAdtError(error);
  const text = `${info.error} ${info.localizedMessage ?? ''}`;
  const select = /Select a master program for include (\S+)/i.exec(text);
  if (select) return { include: select[1].toUpperCase(), wantsContext: true };
  const invalid = /Master program \S+ is invalid for include (\S+)/i.exec(text);
  if (invalid) return { include: invalid[1].toUpperCase(), wantsContext: false };
  return undefined;
}

/**
 * Activate with the contexts in place, and once more with the named include
 * flipped if the backend refuses its main program anyway.
 */
export async function activateWithContexts<T>(
  client: Pick<ADTClient, 'mainPrograms'>,
  entries: ActivationEntry[],
  activate: (entries: ActivationEntry[]) => Promise<T>,
  mainProgram?: string
): Promise<{ result: T; entries: ActivationEntry[]; contexts: IncludeContext[] }> {
  const prepared = await addIncludeContexts(client, entries, mainProgram);
  try {
    return { result: await activate(prepared.entries), ...prepared };
  } catch (error) {
    const refused = refusedInclude(error);
    if (!refused) throw error;
    const index = prepared.entries.findIndex(entry =>
      String(entry['adtcore:name'] || '').toUpperCase() === refused.include && needsContextOrHas(entry));
    if (index < 0) throw error;
    const entry = prepared.entries[index];
    let flipped: ActivationEntry;
    let context: IncludeContext;
    if (refused.wantsContext) {
      if (hasContext(entry['adtcore:uri'])) throw error;
      const mains = await mainProgramsOf(client, entry['adtcore:uri']);
      if (mains.length !== 1) throw error;
      flipped = { ...entry, 'adtcore:uri': withContext(entry['adtcore:uri'], mains[0].uri) };
      context = { include: refused.include, mainProgram: mains[0].uri, from: 'retry' };
    } else {
      if (!hasContext(entry['adtcore:uri'])) throw error;
      flipped = { ...entry, 'adtcore:uri': withoutContext(entry['adtcore:uri']) };
      context = { include: refused.include, from: 'retry' };
    }
    const retried = prepared.entries.map((candidate, at) => (at === index ? flipped : candidate));
    const contexts = [...prepared.contexts.filter(known => known.include !== refused.include), context];
    return { result: await activate(retried), entries: retried, contexts };
  }
}

const needsContextOrHas = (entry: ActivationEntry): boolean =>
  String(entry['adtcore:type'] || '').toUpperCase() === 'PROG/I';
