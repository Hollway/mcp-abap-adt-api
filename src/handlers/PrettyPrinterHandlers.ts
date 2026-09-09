import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";

export class PrettyPrinterHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'prettyPrinterSetting',
                description: 'How pretty-printing is set for this user: whether keywords go upper or lower case, and how identifiers are treated. Worth reading before formatting a source that is not yours, because the setting decides what the reformat does to every line.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'setPrettyPrinterSetting',
                description: 'Change the pretty-printer setting for this user - it is a user setting and stays until changed back. It decides what prettyPrinter does to keywords and identifiers, so changing it changes how every later reformat looks.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        indent: {
                            type: 'boolean',
                            description: 'Whether to indent the code.'
                        },
                        style: {
                            type: 'string',
                            description: 'The pretty printer style.'
                        }
                    },
                    required: ['indent', 'style']
                }
            },
            {
                name: 'prettyPrinter',
                description: 'Reformat a source the way the ADT pretty printer would, following the setting of this user. It answers with the formatted text and writes nothing - the write is yours to make. It does not fix indentation of continuation lines the way a person would: aligning parameters to a column is not something it does.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: {
                            type: 'string',
                            description: 'The ABAP source code to format.'
                        }
                    },
                    required: ['source']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'prettyPrinterSetting':
                return this.handlePrettyPrinterSetting(args);
            case 'setPrettyPrinterSetting':
                return this.handleSetPrettyPrinterSetting(args);
            case 'prettyPrinter':
                return this.handlePrettyPrinter(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown pretty printer tool: ${toolName}`);
        }
    }

    async handlePrettyPrinterSetting(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const settings = await this.readClient.prettyPrinterSetting();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            settings
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get pretty printer settings');
        }
    }

    async handleSetPrettyPrinterSetting(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.setPrettyPrinterSetting(args.indent, args.style);
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
            throw wrapAdtError(error, 'Failed to set pretty printer settings');
        }
    }

    async handlePrettyPrinter(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const source = await this.readClient.prettyPrinter(args.source);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            source
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to format ABAP code');
        }
    }
}
