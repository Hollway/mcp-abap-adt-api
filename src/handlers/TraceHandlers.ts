import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, TraceStatementOptions, TraceParameters, TracesCreationConfig } from 'abap-adt-api';

export class TraceHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'tracesList',
                description: 'Traces recorded for this user, newest first, with their ids - the way into tracesHitList, tracesStatements and tracesDbAccess.',
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
                description: 'The hit list of a trace: what was called how often and for how long, heaviest first - the fastest read of where the time went.',
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
                description: 'The statements of one trace, with their times - where a run spent itself. Takes a trace id from tracesList.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The ID of the trace.'
                        },
                        options: {
                            type: 'object',
                            description: 'Options for retrieving statements (object, or a JSON string).'
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
                description: 'Create a trace configuration: which user and which process to record, and for how long. Recording starts when that user next runs something.',
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
        try {
            const traces = await this.readClient.tracesList(args.user);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            traces
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
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            hitList
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
            const statements = await this.readClient.tracesStatements(args.id, this.parseObjectArg(args.options, 'options'));
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            statements
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
            const result = await this.adtclient.tracesCreateConfiguration(this.parseObjectArg(args.config, 'config'));
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
