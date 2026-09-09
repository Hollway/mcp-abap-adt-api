import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, RenameRefactoringProposal, RenameRefactoring } from 'abap-adt-api';

export class RenameHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'renameEvaluate',
                description: 'First of the three steps of a rename: it asks the system what the symbol at this position is and where it is used, so the rename can be planned. Nothing is written. Then renamePreview, then renameExecute.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uri: {
                            type: 'string',
                            description: 'The URI of the object to rename.'
                        },
                        line: {
                            type: 'number',
                            description: 'The line number.'
                        },
                        startColumn: {
                            type: 'number',
                            description: 'The starting column.'
                        },
                        endColumn: {
                            type: 'number',
                            description: 'The ending column.'
                        }
                    },
                    required: ['uri', 'line', 'startColumn', 'endColumn']
                }
            },
            {
                name: 'renamePreview',
                description: 'Second step of a rename: every object and line the rename would touch, from the evaluation you pass back in. Read this before agreeing - a rename reaches objects you did not open, and the preview is the only place that shows how far it goes.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        renameRefactoring: {
                            type: 'object',
                            description: 'The rename refactoring proposal.'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.'
                        }
                    },
                    required: ['renameRefactoring']
                }
            },
            {
                name: 'renameExecute',
                description: 'Third step of a rename: apply it. This WRITES every object the preview listed, so all of them must be free of other locks and, outside $TMP, in a transport request. It is not a transaction: a failure part way through leaves the objects already renamed as they are.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        refactoring: {
                            type: 'object',
                            description: 'The rename refactoring.'
                        }
                    },
                    required: ['refactoring']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'renameEvaluate':
                return this.handleRenameEvaluate(args);
            case 'renamePreview':
                return this.handleRenamePreview(args);
            case 'renameExecute':
                return this.handleRenameExecute(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown rename tool: ${toolName}`);
        }
    }

    async handleRenameEvaluate(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.renameEvaluate(
                args.uri,
                args.line,
                args.startColumn,
                args.endColumn
            );
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
            throw wrapAdtError(error, 'Failed to evaluate rename');
        }
    }

    async handleRenamePreview(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.renamePreview(
                args.renameRefactoring,
                args.transport
            );
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
            throw wrapAdtError(error, 'Failed to preview rename');
        }
    }

    async handleRenameExecute(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.renameExecute(args.refactoring);
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
            throw wrapAdtError(error, 'Failed to execute rename');
        }
    }
}
