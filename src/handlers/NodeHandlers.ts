import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { NodeParents, NodeStructure } from "abap-adt-api";
import { pageNodes } from '../lib/nodePage';

export class NodeHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'nodeContents',
                description: 'One level of the repository tree: what is directly inside a package, or inside a function group. Three things to know. Most rows hand back a SAPGUI bridge URI that serves properties and no content, so it is not the way to read sources - packageTree resolves the real source URLs, and listFunctionGroup does it for a group. An unknown package answers exactly like an empty one, with no nodes at all, so only a repository search tells them apart. And a large package answers with everything at once - measured, SABAPDEMOS holds 802 nodes and 238,596 characters, past the response cap - so the nodes are counted by type and returned one page at a time, with maxResults, offset and objectType to steer it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        parent_type: {
                            type: 'string',
                            description: 'The type of the parent node.'
                        },
                        parent_name: {
                            type: 'string',
                            description: 'The name of the parent node.'
                        },
                        user_name: {
                            type: 'string',
                            description: 'The user name.'
                        },
                        parent_tech_name: {
                            type: 'string',
                            description: 'The technical name of the parent node.'
                        },
                        rebuild_tree: {
                            type: 'boolean',
                            description: 'Whether to rebuild the tree.'
                        },
                        parentnodes: {
                            type: 'array',
                            description: 'An array of parent node IDs.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Nodes in this page, default 100. The counts always cover the whole level, not the page.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Nodes to skip, for the next page. Default 0.'
                        },
                        objectType: {
                            type: 'string',
                            description: 'Keep only nodes of this ADT type, e.g. CLAS/OC or PROG/P. The counts say which types are there.'
                        }
                    },
                    required: ['parent_type']
                }
            },
            {
                name: 'mainPrograms',
                description: 'Which programs an include belongs to - the question a report include cannot answer about itself. It is needed to create or syntax-check an include, both of which want the main program, and an include used by several reports answers with all of them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        includeUrl: {
                            type: 'string',
                            description: 'The URL of the include.'
                        }
                    },
                    required: ['includeUrl']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'nodeContents':
                return this.handleNodeContents(args);
            case 'mainPrograms':
                return this.handleMainPrograms(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown node tool: ${toolName}`);
        }
    }

    async handleNodeContents(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const nodeContents = await this.readClient.nodeContents(
                args.parent_type,
                args.parent_name,
                args.user_name,
                args.parent_tech_name,
                args.rebuild_tree,
                args.parentnodes
            );
            this.trackRequest(startTime, true);
            const page = pageNodes(nodeContents, {
                offset: args.offset,
                maxResults: args.maxResults,
                objectType: args.objectType
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...page,
                            hint: page.more
                                ? `More nodes follow: ask again with offset=${page.offset + page.returned}.`
                                : (page.total === 0
                                    ? 'No nodes here. An unknown package answers exactly like an empty one - searchObject tells them apart.'
                                    : undefined)
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get node contents');
        }
    }

    async handleMainPrograms(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const mainPrograms = await this.readClient.mainPrograms(args.includeUrl);
            this.trackRequest(startTime, true);
            const programs = Array.isArray(mainPrograms) ? mainPrograms : [];
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            includeUrl: args.includeUrl,
                            found: programs.length > 0,
                            count: programs.length,
                            mainPrograms
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            // Only a program or function-group include has main programs. A
            // class include answers 404, which says nothing about why.
            throw wrapAdtError(error, describeAdtError(error).status === 404
                ? `No main-program list at ${args?.includeUrl}: this answers for program and function-group includes only. A class include belongs to its class - use classIncludes for those`
                : 'Failed to get main programs');
        }
    }
}
