/**
 * Generating the ABAP that calls something and hands its results back.
 *
 * Asking "what does this function module return for these inputs" used to
 * mean writing the snippet by hand every time: declare a variable per
 * parameter with the right type, get the direction of the blocks right (a
 * module's IMPORTING parameters are supplied in the call's EXPORTING block,
 * which is the mistake everyone makes), remember that a classic exception
 * arrives as sy-subrc and not as a message, and then print the results in
 * some shape that can be read back.
 *
 * All of that is derivable from the signature, which is already parsed - so
 * this module turns a signature plus a set of values into the lines of a
 * snippet, and says which payload binding belongs to which parameter so the
 * answer can be assembled again.
 *
 * Three rules the generated code follows, all deliberate:
 *  - nothing is committed unless the caller asks. The call is followed by an
 *    explicit ROLLBACK WORK, because the implicit commit at the end of an ABAP
 *    program would otherwise make every trial call permanent.
 *  - sy-subrc and the message are captured in the statement right after the
 *    call. Anything else in between - a method call in a CATCH block, a
 *    ROLLBACK - is free to overwrite both.
 *  - the results are serialised with CALL TRANSFORMATION id and printed base64
 *    encoded between markers. The console is a formatted channel and may break
 *    a long line; base64 survives that, and a field value would not.
 */

import type { FunctionParameter, FunctionSignature } from './functionModule';

export class CallGenError extends Error {}

/** Where a returned value came from. */
export type ResultKind = 'exporting' | 'changing' | 'tables' | 'returning';
type SectionKind = ResultKind | 'importing';

export interface ResultBinding {
  /** Element name in the payload. */
  binding: string;
  /** Parameter as the signature spells it. */
  parameter: string;
  kind: ResultKind;
}

export interface GeneratedCall {
  /** Class-level declarations for the snippet. */
  declarations: string[];
  /** The body of the run method. */
  code: string[];
  results: ResultBinding[];
  /** Classic exception names by the sy-subrc value the call assigns them. */
  exceptions: Record<number, string>;
  /** Parameters that were filled from the passed values. */
  supplied: string[];
  rolledBack: boolean;
  maxRows: number;
}

export interface CallOptions {
  /** Roll the call back instead of committing it. Default true. */
  rollback?: boolean;
  /** Rows of a table kept in the answer. Default 20. */
  maxRows?: number;
}

/** A signature in the shape this module needs, whatever it was read from. */
export interface CallableSignature {
  importing: FunctionParameter[];
  exporting: FunctionParameter[];
  changing: FunctionParameter[];
  tables?: FunctionParameter[];
  returning?: FunctionParameter;
  exceptions: string[];
}

const DEFAULT_MAX_ROWS = 20;

/** Bindings the generated code always writes, whatever is being called. */
export const CONTROL_BINDINGS = {
  subrc: 'MCP_SUBRC',
  exception: 'MCP_EXCEPTION',
  message: 'MCP_MESSAGE',
  rows: 'MCP_ROWS'
} as const;

/** OTHERS gets a number of its own, out of the way of the declared ones. */
export const OTHERS_SUBRC = 99;

const COMPONENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const OBJECT_NAME = /^\/?[A-Za-z][A-Za-z0-9_/]*$/;

/**
 * Names are checked rather than trusted because they are pasted into source.
 * A component name arriving as "x = 1. DELETE FROM ekpo. y" would otherwise be
 * compiled and run.
 */
const checkComponent = (name: string, what: string): string => {
  const text = String(name ?? '').trim();
  if (!COMPONENT.test(text) || text.length > 30) {
    throw new CallGenError(`"${text}" is not a valid ${what} - letters, digits and underscores only.`);
  }
  return text;
};

export const checkObjectName = (name: string, what: string): string => {
  const text = String(name ?? '').trim();
  if (!OBJECT_NAME.test(text) || text.length > 61) {
    throw new CallGenError(`"${text}" is not a valid ${what}.`);
  }
  return text;
};

/**
 * A value as an ABAP expression.
 *
 * Strings are written as backtick literals: a quoted literal drops trailing
 * blanks, which silently changes a value whose blanks matter, and the escape
 * is then a doubled backtick. Numbers go through unquoted so a numeric target
 * gets a number rather than a conversion, and a boolean becomes the constant
 * ABAP itself uses.
 */
export function abapValue(value: unknown, path: string): string {
  if (value === null || value === undefined) {
    throw new CallGenError(`${path} has no value.`);
  }
  if (typeof value === 'boolean') return value ? 'abap_true' : 'abap_false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CallGenError(`${path} is ${String(value)}, which has no ABAP equivalent.`);
    }
    return String(value);
  }
  if (typeof value === 'string') return '`' + value.replace(/`/g, '``') + '`';
  if (Array.isArray(value)) {
    const rows = value.map((row, index) => {
      const inner = `${path}[${index}]`;
      return row !== null && typeof row === 'object' && !Array.isArray(row)
        ? `( ${componentList(row as Record<string, unknown>, inner)} )`
        : `( ${abapValue(row, inner)} )`;
    });
    return rows.length ? `VALUE #( ${rows.join(' ')} )` : 'VALUE #( )';
  }
  if (typeof value === 'object') {
    return `VALUE #( ${componentList(value as Record<string, unknown>, path)} )`;
  }
  throw new CallGenError(`${path} has a type this cannot pass to ABAP: ${typeof value}.`);
}

/** The `comp = expr` list of a structure, or of one row of a table. */
function componentList(record: Record<string, unknown>, path: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    const name = checkComponent(key, 'component name');
    parts.push(`${name.toLowerCase()} = ${abapValue(value, `${path}.${key}`)}`);
  }
  return parts.join(' ');
}

/**
 * The declaration of one parameter variable.
 *
 * A parameter with no type at all cannot be declared, and there is no way
 * around it: the interface says nothing about what the caller must supply. It
 * is named here rather than left to fail as a syntax error nobody can read.
 */
function declare(variable: string, parameter: FunctionParameter, kind: SectionKind): string {
  if (parameter.type) return `DATA ${variable} TYPE ${parameter.type}.`;
  if (parameter.structure) {
    return `DATA ${variable} TYPE STANDARD TABLE OF ${parameter.structure} WITH DEFAULT KEY.`;
  }
  if (parameter.like) return `DATA ${variable} LIKE ${parameter.like}.`;
  throw new CallGenError(
    `Parameter ${parameter.name} (${kind}) has no type in the interface, so nothing can be declared for it. ` +
    'Such a parameter can only be passed from code that already has a matching data object.'
  );
}

/** A readable variable name that is still a legal one. */
export function variableFor(name: string, index: number): string {
  const candidate = `p_${String(name).toLowerCase()}`;
  return candidate.length <= 30 ? candidate : `p_${index}`;
}

interface Bound {
  parameter: FunctionParameter;
  variable: string;
  /** The key the caller used, when a value was passed for this parameter. */
  key?: string;
}

interface Shaped {
  declarations: string[];
  fill: string[];
  results: ResultBinding[];
  variables: Map<string, string>;
  rowBlocks: string[];
  exceptions: Record<number, string>;
  supplied: string[];
  block: (label: string, kind: SectionKind) => string[];
  maxRows: number;
}

/**
 * Match the passed values to the signature, declare a variable per parameter
 * and work out what comes back.
 *
 * The direction is the part worth reading twice. A callee's IMPORTING
 * parameters are what the caller EXPORTS, and its EXPORTING parameters are
 * what the caller IMPORTS - so the blocks are named after the call, not after
 * the interface.
 */
function shape(what: string, signature: CallableSignature, values: Record<string, unknown>, options: CallOptions): Shaped {
  const maxRows = Number.isFinite(options.maxRows) && (options.maxRows as number) > 0
    ? Math.floor(options.maxRows as number)
    : DEFAULT_MAX_ROWS;

  const sections: { kind: SectionKind; parameters: FunctionParameter[] }[] = [
    { kind: 'importing', parameters: signature.importing || [] },
    { kind: 'exporting', parameters: signature.exporting || [] },
    { kind: 'changing', parameters: signature.changing || [] },
    { kind: 'tables', parameters: signature.tables || [] },
    { kind: 'returning', parameters: signature.returning ? [signature.returning] : [] }
  ];

  const known = new Map<string, SectionKind>();
  for (const section of sections) {
    for (const parameter of section.parameters) known.set(parameter.name.toUpperCase(), section.kind);
  }

  // What the caller passed, checked before anything is generated: a typo in a
  // parameter name is the likeliest mistake, and it must not reach the system
  // as a compile error.
  const passed = new Map<string, { key: string; value: unknown }>();
  for (const [key, value] of Object.entries(values || {})) {
    if (value === null || value === undefined) continue;
    const upper = String(key).trim().toUpperCase();
    const kind = known.get(upper);
    if (!kind) {
      const accepted = [...known.entries()].map(([name, k]) => `${name} (${k})`).join(', ');
      throw new CallGenError(
        `${what} has no parameter ${upper}. It takes: ${accepted || 'no parameters at all'}.`
      );
    }
    if (kind === 'exporting' || kind === 'returning') {
      throw new CallGenError(
        `${upper} is ${kind === 'returning' ? 'the returning parameter' : 'an exporting parameter'} of ` +
        `${what} - it comes back, it is not supplied. Remove it from the values.`
      );
    }
    passed.set(upper, { key, value });
  }

  const bound = new Map<SectionKind, Bound[]>();
  const missing: string[] = [];
  const declarations: string[] = [];
  const fill: string[] = [];
  const results: ResultBinding[] = [];
  const variables = new Map<string, string>();
  const rowBlocks: string[] = [];
  const supplied: string[] = [];
  let index = 0;

  for (const section of sections) {
    const list: Bound[] = [];
    for (const parameter of section.parameters) {
      const upper = parameter.name.toUpperCase();
      const entry = passed.get(upper);
      if (
        section.kind === 'importing' && !entry &&
        !parameter.optional && parameter.default === undefined
      ) {
        missing.push(upper);
      }
      const variable = variableFor(parameter.name, ++index);
      list.push({ parameter, variable, ...(entry ? { key: entry.key } : {}) });

      declarations.push(declare(variable, parameter, section.kind));
      if (entry) {
        supplied.push(upper);
        fill.push(`${variable} = ${abapValue(entry.value, upper)}.`);
      }
      if (section.kind !== 'importing') {
        results.push({ binding: upper, parameter: upper, kind: section.kind });
        variables.set(upper, variable);
        // A TABLES parameter is a table for certain, so its rows can be
        // counted and cut in ABAP. Anything else has to be asked at runtime.
        const staticTable = section.kind === 'tables' && !!(parameter.structure || parameter.type);
        rowBlocks.push(...rowLines(upper, variable, maxRows, staticTable));
      }
    }
    bound.set(section.kind, list);
  }

  if (missing.length) {
    throw new CallGenError(
      `${what} needs ${missing.length === 1 ? 'a value' : 'values'} for ${missing.join(', ')}: ` +
      'the interface declares them without OPTIONAL or DEFAULT.'
    );
  }

  const exceptions: Record<number, string> = {};
  (signature.exceptions || []).forEach((name, position) => {
    exceptions[position + 1] = name.toUpperCase();
  });

  /**
   * One argument block. An IMPORTING parameter nobody passed is left out
   * rather than passed empty, so the callee applies its own default.
   */
  const block = (label: string, kind: SectionKind): string[] => {
    const list = (bound.get(kind) || []).filter(entry => kind !== 'importing' || entry.key !== undefined);
    if (!list.length) return [];
    const width = Math.max(...list.map(entry => entry.parameter.name.length));
    return [
      `  ${label}`,
      ...list.map(entry => `    ${entry.parameter.name.toLowerCase().padEnd(width)} = ${entry.variable}`)
    ];
  };

  return { declarations, fill, results, variables, rowBlocks, exceptions, supplied, block, maxRows };
}

/** The lines that count the rows of a table result, and cut a TABLES one short. */
const rowLines = (binding: string, variable: string, maxRows: number, staticTable: boolean): string[] =>
  staticTable
    ? [
      `APPEND VALUE #( name = \`${binding}\` rows = lines( ${variable} ) ) TO lt_mcp_rows.`,
      `IF lines( ${variable} ) > ${maxRows}.`,
      `  DELETE ${variable} FROM ${maxRows + 1}.`,
      'ENDIF.'
    ]
    // Whether an exporting parameter is a table is not knowable from its type
    // name, and lines( ) on something else would not compile. Assigning to a
    // generically typed field symbol answers it at runtime instead: sy-subrc
    // says whether it matched. Nothing is cut here - the row cap is applied to
    // the answer rather than to the data on the way out.
    : [
      `ASSIGN ${variable} TO <mcp_tab>.`,
      'IF sy-subrc = 0.',
      `  APPEND VALUE #( name = \`${binding}\` rows = lines( <mcp_tab> ) ) TO lt_mcp_rows.`,
      'ENDIF.'
    ];

/** The declarations every generated call needs at class level. */
export const CALL_DECLARATIONS: string[] = [
  'TYPES: BEGIN OF ts_mcp_rows,',
  '         name TYPE string,',
  '         rows TYPE i,',
  '       END OF ts_mcp_rows.',
  'TYPES tt_mcp_rows TYPE STANDARD TABLE OF ts_mcp_rows WITH EMPTY KEY.'
];

/** The locals the fixed part of the body works with. */
const fixedLocals = (): string[] => [
  'DATA lv_mcp_subrc TYPE sy-subrc.',
  'DATA lv_mcp_exception TYPE string.',
  'DATA lv_mcp_message TYPE string.',
  'DATA lt_mcp_rows TYPE tt_mcp_rows.',
  'DATA lt_mcp_bind TYPE abap_trans_srcbind_tab.',
  'DATA lv_mcp_xml TYPE xstring.',
  'DATA lv_mcp_payload TYPE string.',
  'DATA lo_mcp_error TYPE REF TO cx_root.',
  'FIELD-SYMBOLS <mcp_tab> TYPE ANY TABLE.'
];

/**
 * What the call said about itself, captured immediately.
 *
 * sy-subrc carries which classic exception was raised, and sy-msg* the message
 * a RAISING with MESSAGE left behind - and both live only until the next
 * statement that sets them.
 */
const captureOutcome = (): string[] => [
  'lv_mcp_subrc = sy-subrc.',
  'IF lv_mcp_subrc <> 0 AND sy-msgid IS NOT INITIAL AND sy-msgty IS NOT INITIAL.',
  '  MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno',
  '          WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4',
  '          INTO lv_mcp_message.',
  'ENDIF.'
];

/** The EXCEPTIONS block, numbered so sy-subrc can be read back as a name. */
const exceptionBlock = (names: string[]): string[] => {
  if (!names.length) return [];
  const width = Math.max(...names.map(name => name.length), 'OTHERS'.length);
  return [
    '  EXCEPTIONS',
    ...names.map((name, index) => `    ${name.toLowerCase().padEnd(width)} = ${index + 1}`),
    `    ${'OTHERS'.padEnd(width)} = ${OTHERS_SUBRC}`
  ];
};

/** Serialise the results and print them where the answer can find them. */
const serialise = (results: ResultBinding[], variables: Map<string, string>): string[] => {
  const bindings = [
    ['MCP_SUBRC', 'lv_mcp_subrc'],
    ['MCP_EXCEPTION', 'lv_mcp_exception'],
    ['MCP_MESSAGE', 'lv_mcp_message'],
    ['MCP_ROWS', 'lt_mcp_rows'],
    ...results.map(result => [result.binding, variables.get(result.binding) as string])
  ];
  return [
    'lt_mcp_bind = VALUE #(',
    ...bindings.map(([name, variable]) => `  ( name = \`${name}\` value = REF #( ${variable} ) )`),
    ').',
    'CALL TRANSFORMATION id SOURCE (lt_mcp_bind) RESULT XML lv_mcp_xml.',
    'lv_mcp_payload = cl_http_utility=>encode_x_base64( lv_mcp_xml ).',
    "out->write_text( '<<<MCP-RESULT>>>' ).",
    'out->write_text( lv_mcp_payload ).',
    "out->write_text( '<<<MCP-END>>>' )."
  ];
};

/** The snippet around the call statement. */
function assemble(shaped: Shaped, call: string[], options: CallOptions): GeneratedCall {
  const code = [
    ...fixedLocals(),
    ...shaped.declarations,
    ...(shaped.fill.length ? ['', '" what the caller passed', ...shaped.fill] : []),
    '',
    'TRY.',
    ...call.map(line => `    ${line}`),
    ...captureOutcome().map(line => `    ${line}`),
    '  CATCH cx_root INTO lo_mcp_error.',
    '    lv_mcp_exception = cl_abap_classdescr=>get_class_name( lo_mcp_error ).',
    '    lv_mcp_message = lo_mcp_error->get_text( ).',
    'ENDTRY.',
    '',
    ...(options.rollback === false
      ? ['" the caller asked for what this did to stand', 'COMMIT WORK AND WAIT.']
      : ['" nothing a trial call did is kept', 'ROLLBACK WORK.']),
    ...(shaped.rowBlocks.length ? ['', '" how much came back', ...shaped.rowBlocks] : []),
    '',
    '" the results, in a form that can be read back',
    ...serialise(shaped.results, shaped.variables)
  ];

  return {
    declarations: [...CALL_DECLARATIONS],
    code,
    results: shaped.results,
    exceptions: shaped.exceptions,
    supplied: shaped.supplied,
    rolledBack: options.rollback !== false,
    maxRows: shaped.maxRows
  };
}

/** Close the call statement, whose full stop sits on its last line. */
const close = (call: string[]): string[] => {
  const lines = [...call];
  lines[lines.length - 1] = `${lines[lines.length - 1]}.`;
  return lines;
};

/** A snippet that calls one function module. */
export function buildFunctionCall(
  signature: FunctionSignature,
  values: Record<string, unknown>,
  options: CallOptions = {}
): GeneratedCall {
  const name = checkObjectName(signature.name, 'function module name').toUpperCase();
  const shaped = shape(`Function module ${name}`, signature, values, options);

  return assemble(shaped, close([
    `CALL FUNCTION '${name}'`,
    ...shaped.block('EXPORTING', 'importing'),
    ...shaped.block('IMPORTING', 'exporting'),
    ...shaped.block('TABLES', 'tables'),
    ...shaped.block('CHANGING', 'changing'),
    ...exceptionBlock(signature.exceptions || [])
  ]), options);
}

export interface MethodCallTarget {
  className: string;
  methodName: string;
}

/** A snippet that calls one static method. */
export function buildMethodCall(
  target: MethodCallTarget,
  signature: CallableSignature,
  values: Record<string, unknown>,
  options: CallOptions = {}
): GeneratedCall {
  const className = checkObjectName(target.className, 'class name').toLowerCase();
  const methodName = checkObjectName(target.methodName, 'method name').toLowerCase();
  const label = `${className.toUpperCase()}=>${methodName.toUpperCase()}`;
  const shaped = shape(`Method ${label}`, signature, values, options);

  const returning = signature.returning;
  const receiving = returning
    ? [
      '  RECEIVING',
      `    ${returning.name.toLowerCase()} = ${shaped.variables.get(returning.name.toUpperCase())}`
    ]
    : [];

  return assemble(shaped, close([
    `CALL METHOD ${className}=>${methodName}`,
    ...shaped.block('EXPORTING', 'importing'),
    ...shaped.block('IMPORTING', 'exporting'),
    ...shaped.block('CHANGING', 'changing'),
    ...receiving,
    ...exceptionBlock(signature.exceptions || [])
  ]), options);
}

/** What a generated call turned out to have done. */
export interface CallOutcome {
  subrc: number;
  /** The classic exception the callee raised, by name rather than by number. */
  exceptionRaised?: string;
  /** A class-based exception, and what it says. */
  exceptionClass?: string;
  message?: string;
  /** One entry per parameter that comes back, capped at maxRows. */
  values: Record<string, unknown>;
  /** True row counts, before the cap. */
  rows?: Record<string, number>;
  /** Parameters whose rows the answer does not carry in full. */
  truncated?: string[];
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);

/** The MCP_ROWS table, whichever case the serialiser wrote its components in. */
const rowCounts = (value: unknown): Record<string, number> => {
  const counts: Record<string, number> = {};
  if (!Array.isArray(value)) return counts;
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const name = asText(record.NAME ?? record.name).toUpperCase();
    const rows = Number.parseInt(asText(record.ROWS ?? record.rows), 10);
    if (name && Number.isFinite(rows)) counts[name] = rows;
  }
  return counts;
};

/**
 * Read the payload of a generated call back into an answer.
 *
 * The control bindings are taken out of the values: what the caller asked for
 * is the parameters, and sy-subrc means nothing to them until it is turned
 * back into the name of the exception it stood for.
 */
export function interpretCall(
  payload: Record<string, unknown>,
  generated: GeneratedCall
): CallOutcome {
  const subrc = Number.parseInt(asText(payload[CONTROL_BINDINGS.subrc]), 10) || 0;
  const exceptionClass = asText(payload[CONTROL_BINDINGS.exception]);
  const message = asText(payload[CONTROL_BINDINGS.message]);
  const rows = rowCounts(payload[CONTROL_BINDINGS.rows]);

  const values: Record<string, unknown> = {};
  const truncated: string[] = [];
  for (const result of generated.results) {
    const value = payload[result.binding];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const total = rows[result.binding] ?? value.length;
      values[result.parameter] = value.slice(0, generated.maxRows);
      if (total > generated.maxRows || value.length > generated.maxRows) truncated.push(result.parameter);
    } else {
      values[result.parameter] = value;
    }
  }

  const raised = subrc !== 0 && subrc !== OTHERS_SUBRC ? generated.exceptions[subrc] : undefined;

  return {
    subrc,
    ...(raised ? { exceptionRaised: raised } : {}),
    ...(subrc === OTHERS_SUBRC ? { exceptionRaised: 'OTHERS' } : {}),
    ...(exceptionClass ? { exceptionClass } : {}),
    ...(message ? { message } : {}),
    values,
    ...(Object.keys(rows).length ? { rows } : {}),
    ...(truncated.length ? { truncated } : {})
  };
}
