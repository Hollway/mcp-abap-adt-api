import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, ServiceBinding } from "abap-adt-api";

export class ServiceBindingHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'publishServiceBinding',
                description: 'Publishes a service binding.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'The name of the service binding.'
                        },
                        version: {
                            type: 'string',
                            description: 'The version of the service binding.'
                        }
                    },
                    required: ['name', 'version']
                }
            },
            {
                name: 'unPublishServiceBinding',
                description: 'Unpublishes a service binding.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'The name of the service binding.'
                        },
                        version: {
                            type: 'string',
                            description: 'The version of the service binding.'
                        }
                    },
                    required: ['name', 'version']
                }
            },
            {
                name: 'bindingDetails',
                description: 'Retrieves details of a service binding.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        binding: {
                            type: 'object',
                            description: 'The service binding.'
                        },
                        index: {
                            type: 'number',
                            description: 'The index of the service binding.'
                        }
                    },
                    required: ['binding']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'publishServiceBinding':
                return this.handlePublishServiceBinding(args);
            case 'unPublishServiceBinding':
                return this.handleUnPublishServiceBinding(args);
            case 'bindingDetails':
                return this.handleBindingDetails(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown service binding tool: ${toolName}`);
        }
    }

    async handlePublishServiceBinding(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.publishServiceBinding(args.name, args.version);
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
            throw wrapAdtError(error, 'Failed to publish service binding');
        }
    }

    async handleUnPublishServiceBinding(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.unPublishServiceBinding(args.name, args.version);
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
            throw wrapAdtError(error, 'Failed to unpublish service binding');
        }
    }

    async handleBindingDetails(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const details = await this.adtclient.bindingDetails(args.binding, args.index);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            details
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get binding details');
        }
    }
}
