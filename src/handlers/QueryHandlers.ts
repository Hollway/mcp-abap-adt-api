import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';

/**
 * Rows abap-adt-api asks for when nothing is passed: its runQuery and
 * tableContents both default rowNumber to 100, and that number travels as a
 * query parameter on /sap/bc/adt/datapreview.
 */
const BACKEND_DEFAULT_ROWS = 100;

/**
 * `UP TO n ROWS` as written inside the query text.
 *
 * The data preview endpoint ignores it. Measured live: a SELECT with
 * UP TO 3 ROWS and no rowNumber answered with a hundred rows, and the same
 * query with rowNumber 3 answered with three. The cap the backend honours is
 * the rowNumber parameter and nothing else - so read the intent out of the
 * text and apply it there, instead of letting the caller believe in a limit
 * that does nothing and paying for it in a hundred rows of result.
 */
const upToRows = (sql: unknown): number | undefined => {
    if (typeof sql !== 'string') return undefined;
    const match = /\bUP\s+TO\s+(\d+)\s+ROWS\b/i.exec(sql);
    if (!match) return undefined;
    const rows = Number(match[1]);
    return Number.isInteger(rows) && rows > 0 ? rows : undefined;
};

/** Where the row cap that actually applied came from. */
type LimitSource = 'rowNumber' | 'upToRows' | 'default';

export class QueryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tableContents',
                description: 'Read rows of one table or view by name, with an optional WHERE clause - the quickest look at data when you know the table. Reading only: ADT serves no write here. For a join, an aggregate or anything over more than one table use runQuery; to see what FIELDS a table has use getStructureSource, because this answers with data and not with a definition. The row cap is the rowNumber parameter and nothing else - without it the backend returns 100 rows. There is no offset in the backend, so paging fetches offset+rowNumber rows and returns the tail - pass an ORDER BY to make the window stable.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ddicEntityName: {
                            type: 'string',
                            description: 'The name of the DDIC entity (table or view).'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'Rows to return. This is the only cap the backend honours; without it you get 100 rows of every column, which is rarely what you want.'
                        },
                        decode: {
                            type: 'boolean',
                            description: 'Whether to decode the data.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Skip this many leading rows. ADT has no offset, so the server fetches offset+rowNumber rows and returns the tail - add an ORDER BY to make the window stable.'
                        },
                        sqlQuery: {
                            type: 'string',
                            description: 'An optional SQL query to filter the data.'
                        }
                    },
                    required: ['ddicEntityName']
                }
            },
            {
                name: 'runQuery',
                description: 'Run an Open SQL SELECT and get the rows back - joins, aggregates, GROUP BY, whatever the ABAP SQL console accepts. Reading only, and only SELECT: the endpoint refuses anything that writes, and for logic around the data (call a function module, compute, loop) use runSnippet. Ask for the rows you need with the rowNumber parameter: an UP TO n ROWS inside the query text is ignored by this endpoint, and without rowNumber the answer is 100 rows of every selected column. Field lists need commas between the fields - this endpoint speaks new Open SQL.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sqlQuery: {
                            type: 'string',
                            description: 'The SQL query to execute.'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'Rows to return. This is the only cap the backend honours; an UP TO n ROWS written into the query is ignored, and without either you get 100 rows.'
                        },
                        decode: {
                            type: 'boolean',
                            description: 'Whether to decode the data.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Skip this many leading rows. ADT has no offset, so the server fetches offset+rowNumber rows and returns the tail - add an ORDER BY to make the window stable.'
                        }
                    },
                    required: ['sqlQuery']
                }
            }
        ];
    }

    async handle(toolName: string, arguments_: any): Promise<any> {
        switch (toolName) {
            case 'tableContents':
                return this.handleTableContents(arguments_);
            case 'runQuery':
                return this.handleRunQuery(arguments_);
            default:
                throw new Error(`Tool ${toolName} not implemented in QueryHandlers`);
        }
    }


    /**
     * ADT exposes no offset, only a row limit, so a window into a result set
     * is fetched as offset+rowNumber rows and sliced here. Without an ORDER BY
     * the row order is not guaranteed, so the window is only meaningful for an
     * ordered query - which the parameter description says.
     */
    private window(result: any, args: any) {
        const offset = Number(args?.offset) || 0;
        if (offset <= 0 || !result || !Array.isArray(result.values)) return { result };
        const total = result.values.length;
        const { limit } = this.limitOf(args);
        const end = offset + limit;
        return {
            result: { ...result, values: result.values.slice(offset, end) },
            window: { offset, returned: Math.max(0, Math.min(end, total) - offset), fetched: total }
        };
    }

    /**
     * The cap that will actually apply, and where it came from. An explicit
     * rowNumber wins; an UP TO n ROWS in the text is honoured next, because
     * the backend would otherwise drop it on the floor; failing both, the
     * library's own hundred.
     */
    private limitOf(args: any): { limit: number; limitedBy: LimitSource } {
        const rowNumber = Number(args?.rowNumber);
        if (Number.isFinite(rowNumber) && rowNumber > 0) return { limit: rowNumber, limitedBy: 'rowNumber' };
        const upTo = upToRows(args?.sqlQuery);
        if (upTo !== undefined) return { limit: upTo, limitedBy: 'upToRows' };
        return { limit: BACKEND_DEFAULT_ROWS, limitedBy: 'default' };
    }

    /** Rows to ask the backend for, so an offset window can be sliced out. */
    private fetchCount(args: any) {
        const offset = Number(args?.offset) || 0;
        return this.limitOf(args).limit + Math.max(0, offset);
    }

    /**
     * What the caller needs in order to read the size of this answer: how many
     * rows came back, which cap produced that number, and whether the result
     * stopped at the cap - in which case there is more behind it.
     */
    private rows(result: any, args: any): Record<string, unknown> {
        const { limit, limitedBy } = this.limitOf(args);
        const offset = Number(args?.offset) || 0;
        const fetched = Array.isArray(result?.values) ? result.values.length : undefined;
        const report: Record<string, unknown> = { limit, limitedBy };
        if (fetched !== undefined) {
            report.returned = Math.max(0, Math.min(fetched, offset + limit) - offset);
            if (fetched >= offset + limit) {
                report.more = true;
                report.hint = 'The answer stopped at the limit, so there are more rows behind it. Raise rowNumber, or narrow the query.';
            }
        }
        if (limitedBy === 'upToRows') {
            report.hint = `The data preview endpoint ignores UP TO ${limit} ROWS, so it was applied as rowNumber instead.`;
        } else if (limitedBy === 'rowNumber') {
            const upTo = upToRows(args?.sqlQuery);
            if (upTo !== undefined && upTo !== limit) {
                report.upToRowsIgnored = upTo;
                report.hint = `UP TO ${upTo} ROWS in the query text does nothing here - rowNumber ${limit} is the cap that applied.`;
            }
        }
        return report;
    }

    async handleTableContents(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.tableContents(
                args.ddicEntityName,
                this.fetchCount(args),
                args.decode,
                args.sqlQuery
            );
            const rows = this.rows(result, args);
            const windowed = this.window(result, args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...windowed,
                            rows
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to retrieve table contents');
        }
    }

    async handleRunQuery(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.runQuery(
                args.sqlQuery,
                this.fetchCount(args),
                args.decode
            );
            const rows = this.rows(result, args);
            const windowed = this.window(result, args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...windowed,
                            rows
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to run query');
        }
    }
}
