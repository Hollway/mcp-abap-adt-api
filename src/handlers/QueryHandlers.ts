import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';

export class QueryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tableContents',
                description: 'Read rows of one table or view by name, with an optional WHERE clause - the quickest look at data when you know the table. Reading only: ADT serves no write here. For a join, an aggregate or anything over more than one table use runQuery; to see what FIELDS a table has use getStructureSource, because this answers with data and not with a definition. There is no offset in the backend, so paging fetches offset+rowNumber rows and returns the tail - pass an ORDER BY to make the window stable.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ddicEntityName: {
                            type: 'string',
                            description: 'The name of the DDIC entity (table or view).'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'The maximum number of rows to retrieve.'
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
                description: 'Run an Open SQL SELECT and get the rows back - joins, aggregates, GROUP BY, whatever the ABAP SQL console accepts. Reading only, and only SELECT: the endpoint refuses anything that writes, and for logic around the data (call a function module, compute, loop) use runSnippet. Row limits are the ones the backend applies, so ask for what you need with UP TO n ROWS.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sqlQuery: {
                            type: 'string',
                            description: 'The SQL query to execute.'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'The maximum number of rows to retrieve.'
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
        const rowNumber = Number(args?.rowNumber);
        const end = Number.isFinite(rowNumber) && rowNumber > 0 ? offset + rowNumber : total;
        return {
            result: { ...result, values: result.values.slice(offset, end) },
            window: { offset, returned: Math.max(0, Math.min(end, total) - offset), fetched: total }
        };
    }

    /** Rows to ask the backend for, so an offset window can be sliced out. */
    private fetchCount(args: any) {
        const rowNumber = Number(args?.rowNumber);
        const offset = Number(args?.offset) || 0;
        if (!Number.isFinite(rowNumber) || rowNumber <= 0) return args?.rowNumber;
        return rowNumber + Math.max(0, offset);
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
            const windowed = this.window(result, args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...windowed
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
            const windowed = this.window(result, args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...windowed
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
