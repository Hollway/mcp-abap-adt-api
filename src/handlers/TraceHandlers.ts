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
                description: 'Retrieves a list of traces.',
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
                description: 'Retrieves a list of trace requests.',
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
                description: 'Retrieves the hit list for a trace.',
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
                description: 'Retrieves database access information for a trace.',
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
                description: 'Retrieves statements for a trace.',
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
                description: 'Sets trace parameters.',
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
                description: 'Creates a trace configuration.',
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
                description: 'Deletes a trace configuration.',
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
                description: 'Deletes a trace.',
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
            const traces = await this.adtclient.tracesList(args.user);
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
            const requests = await this.adtclient.tracesListRequests(args.user);
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
            const hitList = await this.adtclient.tracesHitList(args.id, args.withSystemEvents);
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
            const dbAccess = await this.adtclient.tracesDbAccess(args.id, args.withSystemEvents);
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
            const statements = await this.adtclient.tracesStatements(args.id, this.parseObjectArg(args.options, 'options'));
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
