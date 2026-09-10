import { fullParse, extractXmlArray, typedNodeAttr } from 'abap-adt-api/build/utilities';

/**
 * Reading a recorded trace: the statements, and the size of both answers.
 *
 * Two things a live run settled, neither of them visible from the library's
 * types:
 *
 * - The statement codec declares `callingProgram` mandatory. A statement that
 *   is an entry point has no caller, so it carries none - two of 8051 in one
 *   ordinary trace - and those two failed the whole call, exactly as a missing
 *   atom title failed `tracesList`. The statements are parsed here instead,
 *   with the caller optional.
 * - A trace of a single ADT call is 8051 statements and 7.5 MB of XML, and its
 *   hit list 1.5 MB of JSON. Neither fits in an answer, and the caller reading
 *   one wants the heavy end of it, not all of it. Both are capped, and the
 *   counts say what was left out.
 */

export interface TraceReadOptions {
    /** Cap on the entries reported. The counts are always for everything found. */
    limit?: unknown;
    /** Sort by gross time, longest first, before capping. */
    heaviestFirst?: unknown;
}

export interface CappedEntries<T> {
    total: number;
    returned: number;
    entries: T[];
    truncated?: true;
    hint?: string;
    order: 'call sequence' | 'gross time, longest first';
}

export const DEFAULT_TRACE_ENTRY_LIMIT = 100;

const grossTimeOf = (entry: any): number => Number(entry?.grossTime?.time ?? 0);

/**
 * Cut a trace answer down to what was asked for. Shared by the statements and
 * the hit list, which differ in what they hold but not in how much of it.
 */
export const capTraceEntries = <T>(entries: T[], options: TraceReadOptions = {}): CappedEntries<T> => {
    const all = Array.isArray(entries) ? entries : [];
    const heaviestFirst = options.heaviestFirst === true;
    // Sorting a copy: the call sequence is the order the backend sent, and a
    // caller asking for the tree back should still get it in that order.
    const ordered = heaviestFirst
        ? [...all].sort((a, b) => grossTimeOf(b) - grossTimeOf(a))
        : all;

    const asked = Number(options.limit);
    const limit = Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_TRACE_ENTRY_LIMIT;
    const reported = ordered.slice(0, limit);

    const result: CappedEntries<T> = {
        total: all.length,
        returned: reported.length,
        entries: reported,
        order: heaviestFirst ? 'gross time, longest first' : 'call sequence'
    };

    if (reported.length < all.length) {
        result.truncated = true;
        result.hint = heaviestFirst
            ? `Showing the ${reported.length} longest of ${all.length}. Raise limit for more.`
            : `Showing the first ${reported.length} of ${all.length}, in call sequence. Pass heaviestFirst to see where the time went, or raise limit.`;
    }

    return result;
};

export interface TraceStatement {
    callingProgram?: Record<string, any>;
    grossTime?: Record<string, any>;
    traceEventNetTime?: Record<string, any>;
    proceduralNetTime?: Record<string, any>;
    [key: string]: any;
}

export interface TraceStatements extends CappedEntries<TraceStatement> {
    /** What the backend said it had, which is not always what it sent. */
    count: number;
    parentLink: string;
}

export const parseTraceStatements = (xml: string, options: TraceReadOptions = {}): TraceStatements => {
    const raw = fullParse(xml, { removeNSPrefix: true })?.statements ?? {};
    const statements: TraceStatement[] = extractXmlArray<any>(raw.statement).map(statement => ({
        ...typedNodeAttr(statement),
        // Optional, unlike in the library's codec: a statement that is an entry
        // point has no calling program, and two of those are enough to lose the
        // other eight thousand.
        ...(statement?.callingProgram ? { callingProgram: typedNodeAttr(statement.callingProgram) } : {}),
        ...(statement?.grossTime ? { grossTime: typedNodeAttr(statement.grossTime) } : {}),
        ...(statement?.traceEventNetTime ? { traceEventNetTime: typedNodeAttr(statement.traceEventNetTime) } : {}),
        ...(statement?.proceduralNetTime ? { proceduralNetTime: typedNodeAttr(statement.proceduralNetTime) } : {})
    }));

    return {
        count: Number(raw['@_count'] ?? statements.length),
        parentLink: String(raw.link?.['@_href'] ?? ''),
        ...capTraceEntries(statements, options)
    };
};
