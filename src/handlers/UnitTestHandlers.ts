import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, UnitTestRunFlags, UnitTestClass } from 'abap-adt-api';

export class UnitTestHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'unitTestRun',
                description: 'Runs unit tests.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the object to test.'
                        },
                        flags: {
                            type: 'object',
                            description: 'Which test risk levels and durations to run. Six booleans; a JSON string is accepted too. Omit for the ADT defaults.',
                            properties: {
                                harmless: { type: 'boolean' },
                                dangerous: { type: 'boolean' },
                                critical: { type: 'boolean' },
                                short: { type: 'boolean' },
                                medium: { type: 'boolean' },
                                long: { type: 'boolean' }
                            }
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'unitTestEvaluation',
                description: 'Evaluates unit test results.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        clas: {
                            type: 'object',
                            description: 'A test class as returned by unitTestRun (object, or a JSON string).'
                        },
                        flags: {
                            type: 'object',
                            description: 'Which test risk levels and durations to evaluate. Six booleans; a JSON string is accepted too. Omit for the ADT defaults.',
                            properties: {
                                harmless: { type: 'boolean' },
                                dangerous: { type: 'boolean' },
                                critical: { type: 'boolean' },
                                short: { type: 'boolean' },
                                medium: { type: 'boolean' },
                                long: { type: 'boolean' }
                            }
                        }
                    },
                    required: ['clas']
                }
            },
            {
                name: 'unitTestOccurrenceMarkers',
                description: 'Retrieves unit test occurrence markers.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the object.'
                        },
                        source: {
                            type: 'string',
                            description: 'The source code.'
                        }
                    },
                    required: ['url', 'source']
                }
            },
            {
                name: 'createTestInclude',
                description: 'Creates a test include for a class.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        clas: {
                            type: 'string',
                            description: 'The class name.'
                        },
                        lockHandle: {
                            type: 'string',
                            description: 'The lock handle.'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.'
                        }
                    },
                    required: ['clas', 'lockHandle']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'unitTestRun':
                return this.handleUnitTestRun(args);
            case 'unitTestEvaluation':
                return this.handleUnitTestEvaluation(args);
            case 'unitTestOccurrenceMarkers':
                return this.handleUnitTestOccurrenceMarkers(args);
            case 'createTestInclude':
                return this.handleCreateTestInclude(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown unit test tool: ${toolName}`);
        }
    }

    async handleUnitTestRun(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.unitTestRun(
                args.url,
                this.parseObjectArg<UnitTestRunFlags>(args.flags, 'flags')
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
            throw wrapAdtError(error, 'Failed to run unit test');
        }
    }

    async handleUnitTestEvaluation(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.unitTestEvaluation(
                this.parseObjectArg<UnitTestClass>(args.clas, 'clas'),
                this.parseObjectArg<UnitTestRunFlags>(args.flags, 'flags')
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
            throw wrapAdtError(error, 'Failed to evaluate unit test');
        }
    }

    async handleUnitTestOccurrenceMarkers(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const markers = await this.adtclient.unitTestOccurrenceMarkers(args.url, args.source);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            markers
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get unit test markers');
        }
    }

    async handleCreateTestInclude(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.createTestInclude(args.clas, args.lockHandle, args.transport);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result,
                            message: 'Test include created successfully'
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to create test include');
        }
    }
}
