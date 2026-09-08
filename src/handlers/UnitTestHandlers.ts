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
                description: 'Run ABAP Unit tests for an object. An empty result does not mean the tests passed - it means none ran, and the answer then explains why (inactive object, or an include that does not compile).',
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

    /**
     * An empty result from ABAP Unit does NOT mean "all tests passed", and it
     * does not mean "this class has no tests" either. It means one of:
     *   - the class is inactive, so its test include was never compiled;
     *   - the test include itself does not compile;
     *   - there really are no tests.
     * ABAP Unit reports none of that, which has cost real debugging time, so
     * check the inactive list and say what is actually going on.
     */
    private async diagnoseEmptyRun(url: string): Promise<Record<string, unknown>> {
        try {
            const inactive = await this.readClient.inactiveObjects();
            const target = (url || '').toLowerCase();
            const related = inactive
                .map(r => r.object)
                .filter(e => !!e && (e['adtcore:uri'] || '').toLowerCase().startsWith(target))
                .map(e => ({ name: e!['adtcore:name'], type: e!['adtcore:type'] }));

            if (related.length > 0) {
                return {
                    emptyResult: true,
                    inactiveParts: related,
                    hint: 'No tests ran because this object is not active: the test include is not compiled against it. Run activateSafe and try again - its messages carry any syntax error.'
                };
            }
            return {
                emptyResult: true,
                inactiveParts: [],
                hint: 'The object is active, so either the test include does not compile or it defines no tests. Re-save the test include and activate class, public section and include together, then re-run. An empty result never means "all tests passed".'
            };
        } catch {
            return {
                emptyResult: true,
                hint: 'No tests ran, and the inactive list could not be read to say why. An empty result never means "all tests passed".'
            };
        }
    }

    async handleUnitTestRun(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.unitTestRun(
                args.url,
                this.parseObjectArg<UnitTestRunFlags>(args.flags, 'flags')
            );
            const diagnosis = Array.isArray(result) && result.length === 0
                ? await this.diagnoseEmptyRun(args.url)
                : {};
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...diagnosis,
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
            const result = await this.readClient.unitTestEvaluation(
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
            const markers = await this.readClient.unitTestOccurrenceMarkers(args.url, args.source);
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
