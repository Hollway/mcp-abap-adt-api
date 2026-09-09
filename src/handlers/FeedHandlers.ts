import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";

export class FeedHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'feeds',
                description: 'The ADT feeds this system publishes (dumps, system messages) with their URLs - the index behind dumps.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'dumps',
                description: 'Short dumps from ST22, newest first, as the HTML page ST22 itself shows. The header of one carries the runtime error, the exception and the program that died.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'An optional query string to filter the dumps.'
                        }
                    }
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'feeds':
                return this.handleFeeds(args);
            case 'dumps':
                return this.handleDumps(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown feed tool: ${toolName}`);
        }
    }

    async handleFeeds(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const feeds = await this.readClient.feeds();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            feeds
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get feeds');
        }
    }

    async handleDumps(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const dumps = await this.readClient.dumps(args.query);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            dumps
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get dumps');
        }
    }
}
