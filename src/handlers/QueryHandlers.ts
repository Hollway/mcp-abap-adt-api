import { ADTClient } from 'abap-adt-api';
import { MAX_QUERY_CHARS } from '../lib/queryLimits';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
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

/**
 * The filter of tableContents has to be a whole SELECT.
 *
 * The parameter is called sqlQuery and was described as a WHERE clause, but
 * /sap/bc/adt/datapreview/ddic answers a bare condition with "Invalid query
 * string. Only the SELECT statement is allowed". Writing the condition is the
 * natural thing to do and it cost a rejected call every time, so complete it
 * into the statement the endpoint wants instead of passing it on to be
 * refused.
 */
const ddicQuery = (entity: unknown, sql: unknown): { query?: string; rewritten?: string } => {
    if (typeof sql !== 'string' || sql.trim().length === 0) return {};
    const text = sql.trim();
    if (/^select\b/i.test(text)) return { query: text };
    const name = String(entity || '').trim();
    if (!name) return { query: text };
    const condition = text.replace(/^where\s+/i, '');
    const query = `SELECT * FROM ${name} WHERE ${condition}`;
    return { query, rewritten: query };
};

export class QueryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tableContents',
                description: 'Read rows of one table or view by name, with an optional filter - the quickest look at data when you know the table. Reading only: ADT serves no write here. For a join, an aggregate or anything over more than one table use runQuery; to see what FIELDS a table has use getStructureSource, because this answers with data and not with a definition. The row cap is the rowNumber parameter and nothing else - without it the backend returns 100 rows. There is no offset in the backend, so paging fetches offset+rowNumber rows and returns the tail - pass an ORDER BY to make the window stable.',
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
                            description: 'An optional filter. The endpoint itself accepts nothing but a whole SELECT, so a bare condition (BUKRS = \'1000\') is completed into SELECT * FROM <entity> WHERE <condition> and the answer says what was sent. A SELECT written out in full is passed through untouched.'
                        }
                    },
                    required: ['ddicEntityName']
                }
            },
            {
                name: 'runQuery',
                description: 'Run an Open SQL SELECT of at most 255 characters and get the rows back - joins, aggregates, GROUP BY, whatever the ABAP SQL console accepts. Reading only, and only SELECT: the endpoint refuses anything that writes, and for logic around the data (call a function module, compute, loop) use runSnippet. Ask for the rows you need with the rowNumber parameter: an UP TO n ROWS inside the query text is ignored by this endpoint, and without rowNumber the answer is 100 rows of every selected column. Field lists need commas between the fields - this endpoint speaks new Open SQL.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sqlQuery: {
                            type: 'string',
                            description: 'The SELECT to run. At most 255 characters: the endpoint refuses a longer statement, and wrapping the text does not help because it counts the whole statement. Split a long IN list into several calls.'
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
     * Cut the answer down to the rows that were asked for, and say what the
     * size of it means.
     *
     * The two data preview endpoints do not count alike: freestyle (runQuery)
     * answers with exactly rowNumber rows, while ddic (tableContents) answers
     * with rowNumber+1 - it fetches one row past the cap to see whether
     * anything follows, and then hands that row over as if it had been asked
     * for. Both were measured on a live system. So the extra row is trimmed
     * here and spent on the answer it was fetched for: `more` is true when a
     * row beyond the cap was really seen, and 'unknown' when the result merely
     * filled the cap exactly - which is all freestyle can ever say.
     *
     * ADT exposes no offset either, so a window is fetched as offset+limit
     * rows and sliced here. Without an ORDER BY the row order is not
     * guaranteed, so the window only means something for an ordered query -
     * which the parameter description says.
     */
    private shape(result: any, args: any) {
        const { limit, limitedBy } = this.limitOf(args);
        const offset = Number(args?.offset) || 0;
        const rows: Record<string, unknown> = { limit, limitedBy };
        const values = Array.isArray(result?.values) ? result.values : undefined;
        const out: Record<string, unknown> = { result };

        if (values) {
            const end = offset + limit;
            const kept = values.slice(offset, end);
            out.result = { ...result, values: kept };
            rows.returned = kept.length;
            if (values.length > end) {
                rows.more = true;
                rows.hint = 'There are more rows behind the cap. Raise rowNumber, or narrow the query.';
            } else if (values.length === end) {
                rows.more = 'unknown';
                rows.hint = 'The answer filled the cap exactly and this endpoint does not say whether anything follows - raise rowNumber to find out.';
            }
            if (offset > 0) out.window = { offset, returned: kept.length, fetched: values.length };
        }

        if (limitedBy === 'upToRows') {
            rows.limitNote = `The data preview endpoint ignores UP TO ${limit} ROWS, so it was applied as rowNumber instead.`;
        } else if (limitedBy === 'rowNumber') {
            const upTo = upToRows(args?.sqlQuery);
            if (upTo !== undefined && upTo !== limit) {
                rows.upToRowsIgnored = upTo;
                rows.limitNote = `UP TO ${upTo} ROWS in the query text does nothing here - rowNumber ${limit} is the cap that applied.`;
            }
        }
        out.rows = rows;
        return out;
    }

    async handleTableContents(args: any): Promise<any> {
        const startTime = performance.now();
        const { query, rewritten } = ddicQuery(args?.ddicEntityName, args?.sqlQuery);
        try {
            const result = await this.readClient.tableContents(
                args.ddicEntityName,
                this.fetchCount(args),
                args.decode,
                query
            );
            const shaped = this.shape(result, args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...shaped,
                            ...(rewritten ? { sqlRewritten: rewritten } : {})
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
        return this.answer(await this.runQueryCore(args));
    }

    /**
     * The query, as a payload rather than a tool answer. Not part of the
     * tool surface - called directly by the transport-registration read,
     * which needs the rows without round-tripping them through JSON.
     */
    async runQueryCore(args: any): Promise<Record<string, unknown>> {
        // The endpoint refuses a statement longer than 255 characters, and says
        // so as "Maximum number of characters in a row exceeds 255" - which
        // sounds like a row of the result, not like the query. Measured: 250
        // characters answer, 292 do not, and wrapping the text changes nothing
        // because it is the whole statement that is counted.
        const sql = String(args?.sqlQuery ?? '');
        if (sql.length > MAX_QUERY_CHARS) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `This statement is ${sql.length} characters and the data preview endpoint refuses anything over ${MAX_QUERY_CHARS}. ` +
                'Shorten it - drop the field list to what you read, alias the tables, or split a long IN list into several calls - or use tableContents for one table.'
            );
        }
        return this.tracked('Failed to run query', async () => {
            const result = await this.readClient.runQuery(
                args.sqlQuery,
                this.fetchCount(args),
                args.decode
            );
            const shaped = this.shape(result, args);
            return {
                status: 'success',
                ...shaped
            };
        });
    }
}
