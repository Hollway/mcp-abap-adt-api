import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";

/**
 * A dump without its page.
 *
 * Measured on a classic ERP system: six dumps came to 61,644 characters,
 * because every one of them carries the whole ST22 page in `text` - 11,739
 * characters for the first. What identifies a dump is in its categories: the
 * runtime error and the program that died. The page itself is worth asking
 * for one dump at a time, not six at once.
 */
const headerOfDump = (entry: any) => {
    const { text, ...rest } = entry || {};
    const categories: any[] = Array.isArray(entry?.categories) ? entry.categories : [];
    const labelled = (label: string) =>
        categories.find(category => String(category?.label || '').toLowerCase().includes(label))?.term;
    return {
        ...rest,
        runtimeError: labelled('runtime error'),
        program: labelled('program'),
        textChars: typeof text === 'string' ? text.length : 0
    };
};

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
                description: 'Short dumps from ST22, newest first. Each carries its whole ST22 page as HTML - measured, six dumps came to 61,644 characters, about 12,000 each - so by default only the headers come back: the runtime error, the program that died, the user, the time and the link. Ask with full: true for the pages themselves, and narrow to the dump you mean first.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'An optional query string to filter the dumps, as the ST22 feed takes it.'
                        },
                        max: {
                            type: 'number',
                            description: 'How many dumps to return, newest first. Default 10.'
                        },
                        full: {
                            type: 'boolean',
                            description: 'Include the whole ST22 page of each dump. Off by default; it costs some 12,000 characters per dump.'
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
            const entries: any[] = Array.isArray(dumps?.dumps) ? dumps.dumps : [];
            const max = Math.max(1, Math.floor(Number(args.max) > 0 ? Number(args.max) : 10));
            const page = entries.slice(0, max);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            count: entries.length,
                            returned: page.length,
                            more: entries.length > page.length,
                            dumps: {
                                ...dumps,
                                dumps: page.map(entry => (args.full ? entry : headerOfDump(entry)))
                            },
                            hint: args.full
                                ? undefined
                                : 'Headers only. Each dump carries its whole ST22 page in "text" - some 12,000 characters each - so it is left out; ask with full: true for the ones you need.'
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
