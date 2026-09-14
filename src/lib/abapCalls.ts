/**
 * What an object's own code calls - the other direction of the where-used graph.
 *
 * usageReferences answers "who calls this", and there is no backend call that
 * answers the reverse: what this object calls. ADT itself has none either; the
 * dependency arrows in its diagrams come from the same where-used index, read
 * one object at a time. So the only place the answer exists is the source, and
 * the honest way to get it is to read the source and look.
 *
 * This is scanning, not parsing. A macro hides whatever it expands to, a
 * generated include is not followed, and a name assembled at runtime cannot be
 * known before the program runs - so every dynamic call is reported as
 * unresolved rather than dropped, because a silently missing edge is worse
 * than a named gap.
 *
 * Everything here is pure text work on a source string: no client, no session.
 */

import { codeOf } from './sourceScan';

/** One logical ABAP statement, and the line it starts on. */
export interface Statement {
  text: string;
  line: number;
}

export type CallKind =
  | 'method'
  | 'constructor'
  | 'exception'
  | 'reference'
  | 'function'
  | 'form'
  | 'program'
  | 'transaction'
  | 'table'
  | 'inherits'
  | 'implements'
  | 'include';

export const CALL_KINDS: readonly CallKind[] = [
  'method', 'constructor', 'exception', 'reference', 'function', 'form',
  'program', 'transaction', 'table', 'inherits', 'implements', 'include'
];

/** One place in the source that reaches another object. */
export interface CallSite {
  target: string;
  kind: CallKind;
  /** Method, function module or form name, where the kind has one. */
  member?: string;
  line: number;
  statement: string;
  /** Which source the line is in, when more than one was scanned. */
  source?: string;
}

/** A call whose target this scan cannot name, and why. */
export interface UnresolvedCall {
  kind: CallKind;
  line: number;
  statement: string;
  reason: string;
  /** Which source the line is in, when more than one was scanned. */
  source?: string;
}

export interface CallScanOptions {
  /** Keep only Z*, Y* and /namespace/ targets. Default true. */
  onlyCustom?: boolean;
  /** Only these kinds. */
  kinds?: string[];
}

export interface CallScanResult {
  calls: CallSite[];
  unresolved: UnresolvedCall[];
  /** Targets dropped because they are not custom code. */
  standardTargetsHidden: number;
  statements: number;
}

const CUSTOM_NAME = /^(z|y|\/[a-z0-9_]+\/)/i;

/**
 * What stands in front of a type rather than in front of a call.
 *
 * `VALUE zcl_return=>tt_return( )` carries the parentheses of a method call
 * and is none: every constructor expression takes a type, and a type owned by
 * a class is written with the same `=>` a method is.
 */
const TYPE_EXPRESSION = /\b(VALUE|CONV|COND|SWITCH|CAST|REF|EXACT|FILTER|REDUCE|CORRESPONDING|NEW|TYPE|LIKE)\s*$/i;

/**
 * Words that stand where a table name would: INSERT REPORT and MODIFY SCREEN
 * are not database access, and `DELETE itab FROM ls` has the same shape as a
 * delete from a table.
 */
const NOT_A_TABLE = new Set([
  'REPORT', 'TEXTPOOL', 'PROGRAM', 'DYNPRO', 'SCREEN', 'MEMORY', 'TABLE', 'DATABASE',
  'FIELD', 'LINE', 'INITIAL', 'OBJECT', 'ID', 'DATASET', 'ITAB', 'FROM', 'INTO', 'DATA',
  'ADJACENT'
]);

/**
 * Logical statements of a source.
 *
 * A statement is not a line: `CALL FUNCTION` with its parameters runs over a
 * dozen of them, and `SELECT` often carries its FROM on the next one. Scanning
 * line by line would miss both, which is why everything below works on
 * statements. Comments are removed by codeOf, which already knows a `"` inside
 * a literal is not one; the period that ends a statement is found with the
 * same care, because '1.5' and |a.b| carry one that ends nothing.
 *
 * Chain statements are expanded: `DATA: a TYPE i, b TYPE REF TO zcl_x` becomes
 * two statements, each keeping the line it was written on.
 */
export function statementsOf(source: string): Statement[] {
  const lines = source.split(/\r?\n/);
  let text = '';
  const lineOf: number[] = [];
  lines.forEach((raw, index) => {
    const piece = `${codeOf(raw)}\n`;
    for (let i = 0; i < piece.length; i++) lineOf.push(index + 1);
    text += piece;
  });

  const statements: Statement[] = [];
  const push = (from: number, to: number): void => {
    for (const part of chainParts(text.slice(from, to), from)) {
      const normalized = part.text.replace(/\s+/g, ' ').trim();
      if (normalized) statements.push({ text: normalized, line: lineOf[part.offset] || 1 });
    }
  };

  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if ((quote === '`' || quote === '|') && ch === '\\') { i++; continue; }
      if (ch === quote) {
        // '' and `` inside a literal are how it escapes its own delimiter.
        if ((ch === "'" || ch === '`') && text[i + 1] === ch) { i++; continue; }
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '`' || ch === '|') { quote = ch; continue; }
    if (ch === '.') {
      push(start, i);
      start = i + 1;
    }
  }
  // A source whose last statement has no period - a fragment, or a file cut
  // short - still has that statement in it.
  if (start < text.length) push(start, text.length);
  return statements;
}

/** Offset of the first character that is not whitespace. */
const firstWord = (text: string, base: number): number => {
  const match = /\S/.exec(text);
  return base + (match ? match.index : 0);
};

/**
 * A chain statement split into its parts, each with the keyword put back in
 * front of it. `INTERFACES: zif_a, zif_b` is two statements written as one,
 * and every rule below expects to see them that way.
 */
function chainParts(raw: string, base: number): Array<{ text: string; offset: number }> {
  const whole = [{ text: raw, offset: firstWord(raw, base) }];
  let quote: string | undefined;
  let depth = 0;
  let colon = -1;
  for (let i = 0; i < raw.length && colon < 0; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '`' || ch === '|') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ':' && depth === 0) colon = i;
  }
  if (colon < 0) return whole;

  const keyword = raw.slice(0, colon).trim();
  // Only a leading keyword can introduce a chain; anything else that holds a
  // colon - a WHERE with a time literal that survived, an expression - is left
  // alone rather than cut in the wrong place.
  if (!keyword || !/^[\w\-/ ]+$/.test(keyword)) return whole;

  const parts: Array<{ text: string; offset: number }> = [];
  let partStart = colon + 1;
  quote = undefined;
  depth = 0;
  const cut = (end: number): void => {
    const part = raw.slice(partStart, end);
    if (part.trim()) parts.push({ text: `${keyword} ${part.trim()}`, offset: firstWord(part, base + partStart) });
  };
  for (let i = colon + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '`' || ch === '|') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { cut(i); partStart = i + 1; }
  }
  cut(raw.length);
  return parts.length ? parts : whole;
}

/** Names declared in this source, and the class or interface each reference holds. */
export interface Locals {
  /** Variable name to the type it references, upper case. */
  refTypes: Map<string, string>;
  /** Every name declared here: variables, tables, types, field symbols. */
  declared: Set<string>;
}

const DECLARING = /^(DATA|CLASS-DATA|STATICS|CONSTANTS|TYPES|FIELD-SYMBOLS|PARAMETERS|SELECT-OPTIONS|RANGES)\s+([\w/<>-]+)/i;

/**
 * What the source declares about itself.
 *
 * Two things are needed later: the type behind `lo_ref->method( )`, which is
 * the only way to say which class that call reaches, and the set of names that
 * are local - because `DELETE lt_orders FROM ls` and `DELETE zorders FROM ls`
 * are the same statement, and only the declarations tell a table apart from an
 * internal one.
 */
export function localNames(statements: Statement[]): Locals {
  const refTypes = new Map<string, string>();
  const declared = new Set<string>();

  for (const { text } of statements) {
    const declaration = DECLARING.exec(text);
    if (declaration) declared.add(declaration[2].toUpperCase());

    // Inline declarations, wherever they sit: DATA(lv), FINAL(lv), @DATA(lt).
    for (const match of text.matchAll(/\b(?:@?DATA|FINAL)\(\s*([\w]+)\s*\)/gi)) {
      declared.add(match[1].toUpperCase());
    }
    for (const match of text.matchAll(/<([\w-]+)>/g)) declared.add(`<${match[1].toUpperCase()}>`);

    // TYPE REF TO, wherever it sits: a DATA line, a METHODS signature, a FORM
    // USING. VALUE(io_x) and REFERENCE(io_x) are the same parameter wearing a
    // passing mode.
    for (const match of text.matchAll(/(?:VALUE|REFERENCE)?\(?\s*([\w/<>-]+)\s*\)?\s+TYPE\s+REF\s+TO\s+([\w/]+)/gi)) {
      const name = match[1].toUpperCase();
      declared.add(name);
      refTypes.set(name, match[2].toUpperCase());
    }
    // DATA(lo_x) = NEW zcl_y( ), and CREATE OBJECT lo_x TYPE zcl_y.
    const inlineNew = /\b(?:DATA|FINAL)\(\s*([\w]+)\s*\)\s*=\s*NEW\s+([\w/]+)\s*\(/i.exec(text);
    if (inlineNew) refTypes.set(inlineNew[1].toUpperCase(), inlineNew[2].toUpperCase());
    const created = /^CREATE\s+OBJECT\s+([\w<>-]+)\s+TYPE\s+([\w/]+)/i.exec(text);
    if (created) refTypes.set(created[1].toUpperCase(), created[2].toUpperCase());
  }

  return { refTypes, declared };
}

/** The class a reference variable holds, or undefined when this source never says. */
const typeOf = (locals: Locals, variable: string): string | undefined =>
  locals.refTypes.get(variable.trim().toUpperCase());

/**
 * An interface-qualified member names the interface, not the class: a call
 * written `lo_ref->zif_log~write( )` reaches ZIF_LOG through whatever class
 * the reference happens to hold, and the interface is the dependency that
 * survives a change of implementation.
 */
function splitMember(target: string, member: string): { target: string; member: string } {
  const tilde = member.indexOf('~');
  if (tilde < 0) return { target, member };
  return { target: member.slice(0, tilde), member: member.slice(tilde + 1) };
}

/** What one pass of the scan collects, so several sources can share it. */
interface ScanState {
  calls: CallSite[];
  unresolved: UnresolvedCall[];
  seen: Set<string>;
  seenUnresolved: Set<string>;
  standardTargetsHidden: number;
  statements: number;
}

const emptyState = (): ScanState => ({
  calls: [],
  unresolved: [],
  seen: new Set(),
  seenUnresolved: new Set(),
  standardTargetsHidden: 0,
  statements: 0
});

/**
 * The scan itself, over statements that have already been read.
 *
 * Kept apart from extractCalls so that a function group - whose declarations
 * are in one include and whose code is in another - can be scanned with the
 * declarations of all its includes in hand.
 */
function scan(
  statements: Statement[],
  locals: Locals,
  options: CallScanOptions,
  state: ScanState,
  sourceName?: string
): void {
  const onlyCustom = options.onlyCustom !== false;
  const wantedKinds = options.kinds?.length
    ? new Set(options.kinds.map(kind => String(kind).trim().toLowerCase()))
    : undefined;
  state.statements += statements.length;

  const add = (statement: Statement, kind: CallKind, target: string, member?: string): void => {
    if (wantedKinds && !wantedKinds.has(kind)) return;
    const name = target.trim().toUpperCase();
    if (!name || name === 'ME' || name === 'SUPER') return;
    if (onlyCustom && !CUSTOM_NAME.test(name)) { state.standardTargetsHidden++; return; }
    const key = `${sourceName || ''}|${kind}|${name}|${(member || '').toUpperCase()}|${statement.line}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.calls.push({
      target: name,
      kind,
      ...(member ? { member: member.trim().toUpperCase() } : {}),
      line: statement.line,
      statement: statement.text,
      ...(sourceName ? { source: sourceName } : {})
    });
  };

  const cannotName = (statement: Statement, kind: CallKind, reason: string): void => {
    if (wantedKinds && !wantedKinds.has(kind)) return;
    const key = `${sourceName || ''}|${kind}|${statement.line}|${reason}`;
    if (state.seenUnresolved.has(key)) return;
    state.seenUnresolved.add(key);
    state.unresolved.push({
      kind,
      line: statement.line,
      statement: statement.text,
      reason,
      ...(sourceName ? { source: sourceName } : {})
    });
  };

  // Several sources are read together for a function group, so what the scan
  // did not find a declaration in is all of them, not one file.
  const undeclared = (name: string): string => `${name.toUpperCase()} is not declared as a reference in ${sourceName ? 'the sources read for this object' : 'this source'}, so its class is unknown here`;

  for (const statement of statements) {
    const text = statement.text;

    // CALL METHOD is the one statement where a static call may carry no
    // parentheses at all, so its head is read on its own terms. The rest of
    // the statement - its EXPORTING parameters, which hold calls and constants
    // of their own - still goes through the general rules below, which is what
    // headEnd keeps them from reading twice.
    let headEnd = 0;
    const callMethod = /^CALL\s+METHOD\s+(.+)$/i.exec(text);
    if (callMethod) {
      const rest = callMethod[1];
      const offset = text.length - rest.length;
      const dynamicClass = /^\(/.test(rest);
      const dynamicMember = /^([\w/<>-]+)\s*(?:->|=>)\s*\(/.exec(rest);
      const staticCall = /^([\w/]+)\s*=>\s*([\w/~]+)/.exec(rest);
      const refCall = /^([\w/<>-]+)\s*->\s*([\w/~]+)/.exec(rest);
      if (dynamicClass) {
        headEnd = text.length;
        cannotName(statement, 'method', 'the class and the method are both in variables');
      } else if (dynamicMember) {
        headEnd = offset + dynamicMember[0].length;
        cannotName(statement, 'method', 'the method name is in a variable');
      } else if (staticCall) {
        headEnd = offset + staticCall[0].length;
        const split = splitMember(staticCall[1], staticCall[2]);
        add(statement, 'method', split.target, split.member);
      } else if (refCall) {
        headEnd = offset + refCall[0].length;
        const split = splitMember(refCall[1], refCall[2]);
        const owner = split.target === refCall[1] ? typeOf(locals, refCall[1]) : split.target;
        if (owner) add(statement, 'method', owner, split.member);
        else cannotName(statement, 'method', undeclared(refCall[1]));
      }
    }

    // zcl_x=>method( ) is a call; zcl_x=>co_value and zcl_x=>ty_row are a
    // dependency on the same class without being one, and are kept apart. So
    // is VALUE zcl_x=>ty_row( ) - a constructor expression over a type owned
    // by that class, which wears the parentheses of a call without being one.
    for (const match of text.matchAll(/([\w/]+)\s*=>\s*([\w/~]+)\s*(\()?/g)) {
      if (match.index! < headEnd) continue;
      const split = splitMember(match[1], match[2]);
      const overAType = TYPE_EXPRESSION.test(text.slice(0, match.index));
      add(statement, match[3] && !overAType ? 'method' : 'reference', split.target, split.member);
    }
    for (const match of text.matchAll(/([\w/<>-]+)\s*->\s*([\w/~]+)\s*\(/g)) {
      if (match.index! < headEnd) continue;
      const variable = match[1];
      const split = splitMember(variable, match[2]);
      if (split.target !== variable) { add(statement, 'method', split.target, split.member); continue; }
      const upper = variable.toUpperCase();
      if (upper === 'ME' || upper === 'SUPER') continue;
      const owner = typeOf(locals, variable);
      if (owner) add(statement, 'method', owner, split.member);
      else cannotName(statement, 'method', undeclared(upper));
    }
    for (const match of text.matchAll(/[\w/<>-]+\s*(?:->|=>)\s*\(/g)) {
      if (match.index! < headEnd) continue;
      cannotName(statement, 'method', 'the method name is in a variable');
    }

    // A call on what another call returned: zcl_a=>get( )->do( ). The first
    // half is found above; the second has no name to resolve, ever.
    if (/\)\s*->\s*[\w/~]+\s*\(/.test(text)) {
      cannotName(statement, 'method', 'a chained call on the result of another call, whose class is not written here');
    }

    for (const match of text.matchAll(/\bNEW\s+([\w/]+)\s*\(/gi)) {
      add(statement, 'constructor', match[1]);
    }

    const created = /^CREATE\s+OBJECT\s+([\w<>-]+)(?:\s+TYPE\s+(\(?[\w/]*\)?))?/i.exec(text);
    if (created) {
      const typeName = created[2];
      if (typeName && typeName.startsWith('(')) {
        cannotName(statement, 'constructor', 'the class to instantiate is in a variable');
      } else if (typeName) {
        add(statement, 'constructor', typeName);
      } else {
        const owner = typeOf(locals, created[1]);
        if (owner) add(statement, 'constructor', owner);
        else cannotName(statement, 'constructor', undeclared(created[1]));
      }
    }

    const raised = /\bRAISE\s+(?:RESUMABLE\s+)?EXCEPTION\s+TYPE\s+([\w/]+)/i.exec(text);
    if (raised) add(statement, 'exception', raised[1]);

    const functionModule = /^CALL\s+FUNCTION\s+(?:'([^']+)'|`([^`]+)`|(.+?))(?:\s|$)/i.exec(text);
    if (functionModule) {
      const literal = functionModule[1] || functionModule[2];
      if (literal) add(statement, 'function', literal);
      else cannotName(statement, 'function', 'the function module name is in a variable');
    }

    const performIn = /^PERFORM\s+(\(?[\w/]+\)?)\s+IN\s+PROGRAM\s+(\(?[\w/]*\)?)/i.exec(text)
      || /^PERFORM\s+(\(?[\w/]+\)?)\s*\(\s*([\w/]+)\s*\)/i.exec(text);
    if (performIn) {
      const form = performIn[1];
      const program = performIn[2];
      if (form.startsWith('(') || !program || program.startsWith('(')) {
        cannotName(statement, 'form', 'the form or the program it lives in is in a variable');
      } else {
        add(statement, 'form', program, form);
      }
    } else if (/^PERFORM\s+\(/i.test(text)) {
      cannotName(statement, 'form', 'the form name is in a variable');
    }

    const submitted = /^SUBMIT\s+(\(?[\w/]+\)?)/i.exec(text);
    if (submitted) {
      if (submitted[1].startsWith('(')) cannotName(statement, 'program', 'the program name is in a variable');
      else add(statement, 'program', submitted[1]);
    }

    const transaction = /\b(?:CALL\s+TRANSACTION|LEAVE\s+TO\s+TRANSACTION)\s+(?:'([^']+)'|(\(?[\w/]+\)?))/i.exec(text);
    if (transaction) {
      if (transaction[1]) add(statement, 'transaction', transaction[1]);
      else cannotName(statement, 'transaction', 'the transaction code is in a variable');
    }

    // Database access. A name this source declares is an internal table, not a
    // table: MODIFY lt_rows FROM ls and MODIFY zrows FROM ls are one statement
    // shape, and the declarations are what tell them apart.
    const table = (name: string | undefined): void => {
      if (!name) return;
      const upper = name.toUpperCase();
      if (NOT_A_TABLE.has(upper) || locals.declared.has(upper) || upper.startsWith('@')) return;
      add(statement, 'table', upper);
    };
    if (/\bSELECT\b/i.test(text)) {
      for (const match of text.matchAll(/\bFROM\s+([\w/]+)/gi)) table(match[1]);
      for (const match of text.matchAll(/\bJOIN\s+([\w/]+)/gi)) table(match[1]);
      if (/\b(?:FROM|JOIN)\s*\(/i.test(text)) {
        cannotName(statement, 'table', 'the table read from is in a variable');
      }
    }
    const written = /^(?:UPDATE|MODIFY)\s+([\w/]+)/i.exec(text)
      || /^INSERT\s+(?:INTO\s+)?([\w/]+)/i.exec(text)
      || /^DELETE\s+(?:FROM\s+)?([\w/]+)/i.exec(text);
    if (written) table(written[1]);
    else if (/^(?:UPDATE|MODIFY|INSERT\s+INTO|DELETE\s+FROM)\s*\(/i.test(text)) {
      cannotName(statement, 'table', 'the table written to is in a variable');
    }

    // TABLES declares a work area over a database table, and naming one is a
    // dependency on it even where nothing reads it in this source.
    const tablesStatement = /^TABLES\s+([\w/]+)/i.exec(text);
    if (tablesStatement) add(statement, 'table', tablesStatement[1]);

    const inherits = /\bINHERITING\s+FROM\s+([\w/]+)/i.exec(text);
    if (inherits) add(statement, 'inherits', inherits[1]);

    const implemented = /^INTERFACES\s+([\w/]+)/i.exec(text);
    if (implemented) add(statement, 'implements', implemented[1]);

    const included = /^INCLUDE\s+([\w/]+)/i.exec(text);
    if (included && !/^INCLUDE\s+(?:TYPE|STRUCTURE)\b/i.test(text)) add(statement, 'include', included[1]);
  }

}

const resultOf = (state: ScanState): CallScanResult => ({
  calls: state.calls,
  unresolved: state.unresolved,
  standardTargetsHidden: state.standardTargetsHidden,
  statements: state.statements
});

/**
 * Every other object this source reaches, and every call it cannot name.
 */
export function extractCalls(source: string, options: CallScanOptions = {}): CallScanResult {
  const statements = statementsOf(source);
  const state = emptyState();
  scan(statements, localNames(statements), options, state);
  return resultOf(state);
}

/** A source read for the scan, and the name to report its lines under. */
export interface NamedSource {
  name: string;
  source: string;
}

/**
 * The same scan over several sources that belong together.
 *
 * A function group declares its globals in one include and uses them in
 * another: scanned one at a time, every call through gs_screen-handler would
 * be unresolvable. The declarations of all the sources are collected first,
 * and each source still prefers its own - a name reused for something else in
 * one include means what that include says it means.
 */
export function extractCallsAcross(sources: NamedSource[], options: CallScanOptions = {}): CallScanResult {
  const parsed = sources.map(source => ({ name: source.name, statements: statementsOf(source.source) }));
  const shared: Locals = { refTypes: new Map(), declared: new Set() };
  const own = parsed.map(source => {
    const locals = localNames(source.statements);
    for (const [name, type] of locals.refTypes) if (!shared.refTypes.has(name)) shared.refTypes.set(name, type);
    for (const name of locals.declared) shared.declared.add(name);
    return locals;
  });

  const state = emptyState();
  const many = parsed.length > 1;
  parsed.forEach((source, index) => {
    const locals: Locals = many
      ? { refTypes: new Map([...shared.refTypes, ...own[index].refTypes]), declared: shared.declared }
      : own[index];
    scan(source.statements, locals, options, state, many ? source.name : undefined);
  });
  return resultOf(state);
}

/** One object that is called, with the places that call it. */
export interface CallTarget {
  target: string;
  kind: CallKind;
  calls: number;
  members?: string[];
  places: Array<{ line: number; member?: string; statement: string; source?: string }>;
  /** Places beyond the listed ones. */
  morePlaces?: number;
}

/**
 * Call sites grouped by what they reach, heaviest first - the same shape
 * impactOf answers in, read the other way round.
 */
export function groupCalls(
  calls: CallSite[],
  options: { maxTargets?: number; maxPlacesPerTarget?: number; maxStatementChars?: number } = {}
): { targets: CallTarget[]; targetsHidden: number } {
  const maxTargets = Math.max(1, Number(options.maxTargets) || 100);
  const maxPlaces = Math.max(1, Number(options.maxPlacesPerTarget) || 8);
  const maxChars = Math.max(40, Number(options.maxStatementChars) || 160);
  const shorten = (text: string): string => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);

  const grouped = new Map<string, CallTarget>();
  for (const call of calls) {
    const key = `${call.kind}|${call.target}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { target: call.target, kind: call.kind, calls: 0, places: [] };
      grouped.set(key, entry);
    }
    entry.calls++;
    entry.places.push({
      line: call.line,
      ...(call.member ? { member: call.member } : {}),
      statement: shorten(call.statement),
      ...(call.source ? { source: call.source } : {})
    });
  }

  const all = [...grouped.values()].sort((a, b) =>
    b.calls - a.calls || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));

  const kept = all.slice(0, maxTargets);
  for (const entry of kept) {
    const members = [...new Set(entry.places.map(place => place.member).filter(Boolean))] as string[];
    if (members.length) entry.members = members.sort();
    if (entry.places.length > maxPlaces) {
      entry.morePlaces = entry.places.length - maxPlaces;
      entry.places = entry.places.slice(0, maxPlaces);
    }
  }

  return { targets: kept, targetsHidden: Math.max(0, all.length - kept.length) };
}
