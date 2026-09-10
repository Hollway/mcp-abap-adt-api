import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, TraceStatementOptions, TraceParameters, TracesCreationConfig } from 'abap-adt-api';
import { parseTraceFeed, normaliseTraceConfig } from '../lib/traceFeed';
import { parseTraceStatements, capTraceEntries } from '../lib/traceRead';

const TRACES_URL = '/sap/bc/adt/runtime/traces/abaptraces';
const DEFAULT_TRACE_LIMIT = 50;

export class TraceHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tracesList',
                description: 'Traces recorded for this user, newest first, with their ids - the way into tracesHitList, tracesStatements and tracesDbAccess. Each run carries how long it took and when its file expires: an expired trace is still listed, but reading it answers "wrong input data".',
                inputSchema: {
                    type: 'object',
                    properties: {
                        user: {
                            type: 'string',
                            description: 'The user. Defaults to the one this server logs in as.'
                        },
                        limit: {
                            type: 'number',
                            description: 'Cap on the runs reported, default 50. The total is always for everything found.'
                        },
                        includeLinks: {
                            type: 'boolean',
                            description: 'Keep the four atom links each run carries. They are half the size of the answer and only lead to SAP GUI, so they are dropped by default.'
                        }
                    }
                }
            },
            {
                name: 'tracesListRequests',
                description: 'The recorded requests of a trace - one per unit of work measured. The entry point into a trace before its statements.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        user: {
                            type: 'string',
                            description: 'The user.'
                        }
                    }
                }
            },
            {
                name: 'tracesHitList',
                description: 'The hit list of a trace: what was called how often and for how long - the fastest read of where the time went. The hit list of a single ADT call runs to megabytes, so the answer is capped: pass heaviestFirst for the expensive end of it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace, as tracesList reports it.'
                        },
                        withSystemEvents: {
                            type: 'boolean',
                            description: 'Whether to include system events.'
                        },
                        limit: {
                            type: 'number',
                            description: 'Cap on the entries reported, default 100. The total is always for everything found.'
                        },
                        heaviestFirst: {
                            type: 'boolean',
                            description: 'Sort by gross time, longest first, before capping. Off by default, which keeps the order the backend sent.'
                        }
                    },
                    required: ['id']
                }
            },
            {
                name: 'tracesDbAccess',
                description: 'The database accesses of one trace: which tables, how many rows, how long - where a slow run met the database.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace.'
                        },
                        withSystemEvents: {
                            type: 'boolean',
                            description: 'Whether to include system events.'
                        }
                    },
                    required: ['id']
                }
            },
            {
                name: 'tracesStatements',
                description: 'The statements of one trace, with their times - where a run spent itself. Takes a trace id from tracesList. The trace has to have been recorded with aggregate false: the backend refuses statements for an aggregated one. One ADT call is some 8000 statements, so the answer is capped - pass heaviestFirst for the expensive end of it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace, as tracesList reports it.'
                        },
                        options: {
                            type: 'object',
                            description: 'Query options passed on to the backend, e.g. withDetails (object, or a JSON string).'
                        },
                        limit: {
                            type: 'number',
                            description: 'Cap on the statements reported, default 100. The counts are always for everything found.'
                        },
                        heaviestFirst: {
                            type: 'boolean',
                            description: 'Sort by gross time, longest first, before capping. Off by default, which keeps the call sequence.'
                        }
                    },
                    required: ['id']
                }
            },
            {
                name: 'tracesSetParameters',
                description: 'Set what the next trace records: statements, database access, aggregation. It applies to traces started afterwards, not to one already recorded.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        parameters: {
                            type: 'object',
                            description: 'The trace parameters (object, or a JSON string).'
                        }
                    },
                    required: ['parameters']
                }
            },
            {
                name: 'tracesCreateConfiguration',
                description: 'Create a trace configuration: which user and which process to record, and for how long. Recording starts when that user next runs something. Needs parametersId - the URI tracesSetParameters answered with - plus traceUser, traceClient, processType, objectType, expires and maximalExecutions. A bare parameters id and a plain date are accepted here and normalised; sent to the backend as they stand, both answer a flat 400 that names neither field.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        config: {
                            type: 'object',
                            description: 'The trace configuration (object, or a JSON string).'
                        }
                    },
                    required: ['config']
                }
            },
            {
                name: 'tracesDeleteConfiguration',
                description: 'Delete a trace configuration, so nothing more is recorded under it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace configuration.'
                        }
                    },
                    required: ['id']
                }
            },
            {
                name: 'tracesDelete',
                description: 'Delete a recorded trace. Final, and the measurement cannot be taken again from the same run.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace.'
                        }
                    },
                    required: ['id']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'tracesList':
                return this.handleTracesList(args);
            case 'tracesListRequests':
                return this.handleTracesListRequests(args);
            case 'tracesHitList':
                return this.handleTracesHitList(args);
            case 'tracesDbAccess':
                return this.handleTracesDbAccess(args);
            case 'tracesStatements':
                return this.handleTracesStatements(args);
            case 'tracesSetParameters':
                return this.handleTracesSetParameters(args);
            case 'tracesCreateConfiguration':
                return this.handleTracesCreateConfiguration(args);
            case 'tracesDeleteConfiguration':
                return this.handleTracesDeleteConfiguration(args);
            case 'tracesDelete':
                return this.handleTracesDelete(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown trace tool: ${toolName}`);
        }
    }

    async handleTracesList(args: any): Promise<any> {
        const startTime = performance.now();
        const client = this.readClient;
        const user = String(args?.user || client.username || '').toUpperCase();
        const limit = args?.limit === undefined ? DEFAULT_TRACE_LIMIT : Number(args.limit);
        try {
            // Read the feed ourselves. Going through the library here fails on
            // any system that holds a trace without a description - see
            // lib/traceFeed for what its codec gets wrong.
            const response = await client.httpClient.request(TRACES_URL, {
                method: 'GET',
                qs: { user }
            });
            const traces = parseTraceFeed(String(response.body ?? ''), {
                limit: Number.isFinite(limit) ? limit : DEFAULT_TRACE_LIMIT,
                includeLinks: args?.includeLinks === true
            });
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            user,
                            ...traces,
                            ...(traces.returned < traces.total
                                ? { truncated: true, hint: `Showing ${traces.returned} of ${traces.total} runs. Raise limit for more.` }
                                : {})
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get traces list');
        }
    }

    async handleTracesListRequests(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const requests = await this.readClient.tracesListRequests(args.user);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            requests
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get trace requests');
        }
    }

    async handleTracesHitList(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const hitList = await this.readClient.tracesHitList(args.id, args.withSystemEvents);
            // One ADT call produced 1.5 MB of hit list, which the response guard
            // then threw away whole. Cap it here, where what is dropped can be
            // named and the heavy end can be asked for.
            const capped = capTraceEntries((hitList as any)?.entries ?? [], args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            parentLink: (hitList as any)?.parentLink,
                            ...capped
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get trace hit list');
        }
    }

    async handleTracesDbAccess(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const dbAccess = await this.readClient.tracesDbAccess(args.id, args.withSystemEvents);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            dbAccess
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get trace DB access');
        }
    }

    async handleTracesStatements(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            // Parsed here rather than by the library: its codec drops the whole
            // answer over a statement that carries no calling program, which
            // every entry point is - see lib/traceRead.
            const id = String(args.id ?? '');
            const url = id.startsWith('/') ? id + '/statements' : TRACES_URL + '/' + id + '/statements';
            const response = await this.readClient.httpClient.request(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml'
                },
                qs: this.parseObjectArg<Record<string, unknown>>(args.options, 'options') || {}
            });
            const statements = parseTraceStatements(String(response.body ?? ''), args);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...statements
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get trace statements');
        }
    }

    async handleTracesSetParameters(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.tracesSetParameters(this.parseObjectArg(args.parameters, 'parameters'));
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to set trace parameters');
        }
    }

    async handleTracesCreateConfiguration(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const config = normaliseTraceConfig(
                this.parseObjectArg<TracesCreationConfig>(args.config, 'config') as any
            );
            const result = await this.adtclient.tracesCreateConfiguration(config);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to create trace configuration');
        }
    }

    async handleTracesDeleteConfiguration(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.tracesDeleteConfiguration(args.id);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to delete trace configuration');
        }
    }

    async handleTracesDelete(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.tracesDelete(args.id);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to delete trace');
        }
    }
}
