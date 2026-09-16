import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireShape } from '../lib/argShape';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, isMissingCollection } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, ServiceBinding } from "abap-adt-api";

export class ServiceBindingHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'publishServiceBinding',
                description: 'Publish a service binding, which makes its service reachable on this system. Outward-facing: the endpoint goes live for anyone who can reach the host.',
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
                description: 'Take a published service offline. Outward-facing and immediate: anything calling that endpoint stops working.',
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
                description: 'What a service binding exposes: its services, versions and the entities behind them - read before publishing or unpublishing one.',
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
            // The publish jobs collection is absent on a system that serves no
            // business services at all, and its 404 says nothing about the
            // binding that was named.
            throw wrapAdtError(
                error,
                isMissingCollection(error)
                    ? 'OData publishing is not served by this system: /sap/bc/adt/businessservices/odatav2/publishjobs does not exist, which is not the same as this binding being unknown'
                    : `Failed to publish the service binding ${args?.name || ''}`.trim()
            );
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
            throw wrapAdtError(
                error,
                isMissingCollection(error)
                    ? 'OData publishing is not served by this system: /sap/bc/adt/businessservices/odatav2/unpublishjobs does not exist, which is not the same as this binding being unknown'
                    : `Failed to unpublish the service binding ${args?.name || ''}`.trim()
            );
        }
    }

    async handleBindingDetails(args: any): Promise<any> {
        const startTime = performance.now();
        requireShape(args?.binding, {
            parameter: 'binding',
            fields: ['links', 'services'],
            producedBy: 'objectStructure on a service binding, parsed as a ServiceBinding'
        });
        try {
            const details = await this.readClient.bindingDetails(args.binding, args.index);
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
