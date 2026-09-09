import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { NodeParents, NodeStructure } from "abap-adt-api";

export class NodeHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'nodeContents',
                description: 'One level of the repository tree: what is directly inside a package, or inside a function group. Two things to know. Most rows hand back a SAPGUI bridge URI that serves properties and no content, so it is not the way to read sources - packageTree resolves the real source URLs, and listFunctionGroup does it for a group. And an unknown package answers exactly like an empty one, with no nodes at all, so only a repository search tells them apart.',
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
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            nodeContents
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
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            mainPrograms
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get main programs');
        }
    }
}
