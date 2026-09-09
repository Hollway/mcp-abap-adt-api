import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';

export class DiscoveryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'featureDetails',
                description: 'What one discovery feature offers, by title - the capabilities behind a collection.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: 'The title of the feature.'
                        }
                    },
                    required: ['title']
                }
            },
            {
                name: 'collectionFeatureDetails',
                description: 'What one collection of the discovery document offers: its capabilities, its supported types and its versions.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the collection feature.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'findCollectionByUrl',
                description: 'Which discovery collection serves a given URL - the reverse lookup of adtDiscovery, for when an address is in hand and its capabilities are not.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the collection.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'loadTypes',
                description: 'The object types the creation endpoints accept, with the templates behind them - what a wrong objtype is checked against.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtDiscovery',
                description: 'The ADT service document: every collection this system offers, with its URL and the object types it serves. This is where the address of an unfamiliar collection comes from.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtCoreDiscovery',
                description: 'The core discovery document of the ADT service - what healthcheck calls to prove the connection is alive.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtCompatibiliyGraph',
                description: 'The ADT compatibility graph of this system: which protocol versions its collections speak. Diagnostic, for a call refused as an unsupported version.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'featureDetails':
                return this.handleFeatureDetails(args);
            case 'collectionFeatureDetails':
                return this.handleCollectionFeatureDetails(args);
            case 'findCollectionByUrl':
                return this.handleFindCollectionByUrl(args);
            case 'loadTypes':
                return this.handleLoadTypes(args);
            case 'adtDiscovery':
                return this.handleAdtDiscovery(args);
            case 'adtCoreDiscovery':
                return this.handleAdtCoreDiscovery(args);
            case 'adtCompatibiliyGraph':
                return this.handleAdtCompatibilityGraph(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown discovery tool: ${toolName}`);
        }
    }

    async handleFeatureDetails(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const details = await this.readClient.featureDetails(args.title);
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
            throw wrapAdtError(error, 'Failed to get feature details');
        }
    }

    async handleCollectionFeatureDetails(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const details = await this.readClient.collectionFeatureDetails(args.url);
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
            throw wrapAdtError(error, 'Failed to get collection feature details');
        }
    }

    async handleFindCollectionByUrl(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const collection = await this.readClient.findCollectionByUrl(args.url);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            collection
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to find collection by URL');
        }
    }

    async handleLoadTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const types = await this.readClient.loadTypes();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            types
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to load types');
        }
    }

    async handleAdtDiscovery(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const discovery = await this.readClient.adtDiscovery();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            discovery
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to perform ADT discovery');
        }
    }

    async handleAdtCoreDiscovery(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const discovery = await this.readClient.adtCoreDiscovery();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            discovery
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to perform ADT core discovery');
        }
    }

    async handleAdtCompatibilityGraph(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const graph = await this.readClient.adtCompatibiliyGraph();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            graph
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get ADT compatibility graph');
        }
    }
}
