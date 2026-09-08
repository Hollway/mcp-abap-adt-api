import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';

export class QueryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tableContents',
                description: 'Retrieves the contents of an ABAP table.',
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
                description: 'Runs a SQL query on the target system.',
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
            const result = await this.adtclient.tableContents(
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
            const result = await this.adtclient.runQuery(
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
