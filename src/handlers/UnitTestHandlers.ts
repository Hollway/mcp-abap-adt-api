import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient, UnitTestRunFlags, UnitTestClass } from 'abap-adt-api';
import { session_types } from 'abap-adt-api';
import { activateAndVerify } from '../lib/activation';
import { lockRegistry } from '../lib/lockRegistry';
import { describeAdtError } from '../lib/adtError';

/** Object URL of a class, from its name. */
const classUrl = (name: string): string => {
    const lower = name.trim().toLowerCase();
    return `/sap/bc/adt/oo/classes/${lower.includes('/') ? encodeURIComponent(lower) : lower}`;
};

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
                name: 'runTests',
                description: 'Run the ABAP Unit tests of a class and report what happened, activating it first if it has inactive parts. This is what unitTestRun should feel like: tests do not run at all against an inactive object, so a bare run answers with an empty list that reads like success. Returns a summary - how many methods ran, which failed, and each failure with its message - with the full ADT result available on request.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        className: {
                            type: 'string',
                            description: 'Class to test, e.g. ZCL_APP_PCK_PLAN. Its own test include is what runs.'
                        },
                        url: {
                            type: 'string',
                            description: 'Object URL instead of the class name.'
                        },
                        activate: {
                            type: 'boolean',
                            description: 'Activate inactive parts of the object before running (default true). Without this an inactive class silently runs no tests.'
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
                        },
                        raw: {
                            type: 'boolean',
                            description: 'Include the full ADT result alongside the summary.'
                        }
                    }
                }
            },
            {
                name: 'unitTestEvaluation',
                description: 'The evaluation behind a unit-test run, for the alerts a run reported. Prefer runTests, which activates first and reports each failure with its assert message.',
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
                description: 'The markers ADT draws next to code covered by a unit test - which lines a run touched.',
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
                description: 'Create the test include of a class - the place ABAP Unit tests live, which a new class does not have. It writes an empty include; runTests then runs what is put in it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        clas: {
                            type: 'string',
                            description: 'The class name.'
                        },
                        lockHandle: {
                            type: 'string',
                            description: 'Lock handle for the class; omit to use the one this server recorded for it (see listLocks).'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.'
                        }
                    },
                    required: ['clas']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'unitTestRun':
                return this.handleUnitTestRun(args);
            case 'runTests':
                return this.handleRunTests(args);
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

    /**
     * Run the tests of one object and say what happened.
     *
     * Two things make a bare unitTestRun misleading. Tests do not run against
     * an inactive object at all - the test include was never compiled against
     * it - and the answer to that is an empty list, which looks exactly like
     * "everything passed". And the full ADT result is a deep structure whose
     * failures are buried in nested alerts, so the one question worth asking
     * (did anything fail, and why) takes work to answer.
     *
     * So: activate first when something is inactive, then run, then summarise.
     */
    async handleRunTests(args: any): Promise<any> {
        const url = typeof args?.url === 'string' && args.url.trim()
            ? args.url.trim()
            : typeof args?.className === 'string' && args.className.trim()
                ? classUrl(args.className)
                : '';
        if (!url) {
            throw new McpError(ErrorCode.InvalidParams, 'Which object? Pass className, or url.');
        }

        const steps: Record<string, unknown>[] = [];

        if (args?.activate !== false) {
            const activateStart = performance.now();
            try {
                const outcome = await activateAndVerify(this.adtclient, { objectUrl: url });
                this.trackRequest(activateStart, true);
                steps.push({ step: 'activate', ...outcome });
                if (!outcome.success) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'error',
                                ran: false,
                                objectUrl: url,
                                steps,
                                hint: 'The object could not be activated, so no test would have run. The activation messages are in the activate step - fix those first.'
                            })
                        }]
                    };
                }
            } catch (error: any) {
                this.trackRequest(activateStart, false);
                steps.push({ step: 'activate', error: describeAdtError(error).error });
            }
        }

        const runStart = performance.now();
        try {
            const result = await this.adtclient.unitTestRun(
                url,
                this.parseObjectArg<UnitTestRunFlags>(args.flags, 'flags')
            );
            this.trackRequest(runStart, true);

            const classes = Array.isArray(result) ? result : [];
            if (classes.length === 0) {
                const diagnosis = await this.diagnoseEmptyRun(url);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ran: false,
                            objectUrl: url,
                            methods: 0,
                            failures: 0,
                            steps,
                            ...diagnosis,
                            ...(args?.raw === true ? { result } : {})
                        })
                    }]
                };
            }

            const failures: Record<string, unknown>[] = [];
            let methods = 0;
            for (const clas of classes) {
                for (const alert of (clas as any)?.alerts || []) {
                    failures.push({
                        class: (clas as any)?.['adtcore:name'],
                        method: undefined,
                        kind: alert?.kind,
                        severity: alert?.severity,
                        title: alert?.title,
                        details: alert?.details
                    });
                }
                for (const test of (clas as any)?.testmethods || []) {
                    methods += 1;
                    for (const alert of test?.alerts || []) {
                        failures.push({
                            class: (clas as any)?.['adtcore:name'],
                            method: test?.['adtcore:name'],
                            kind: alert?.kind,
                            severity: alert?.severity,
                            title: alert?.title,
                            details: alert?.details
                        });
                    }
                }
            }

            const passed = methods - new Set(
                failures.filter(f => f.method).map(f => `${f.class}.${f.method}`)
            ).size;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        ran: true,
                        objectUrl: url,
                        testClasses: classes.map((c: any) => c?.['adtcore:name']),
                        methods,
                        passed,
                        failures: failures.length,
                        failureDetails: failures,
                        steps,
                        ...(args?.raw === true ? { result } : {}),
                        hint: failures.length === 0
                            ? `${methods} test method(s) ran and none raised an alert.`
                            : 'Failures are listed with the method they came from; each carries the ABAP Unit message.'
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(runStart, false);
            throw wrapAdtError(error, `Failed to run the tests of ${url}`);
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
        // The class has to be locked for this, and when this server took that
        // lock it already knows the handle.
        const classObjectUrl = classUrl(String(args?.clas || ''));
        const held = lockRegistry.forUrl(classObjectUrl);
        const lockHandle = args?.lockHandle || held?.lockHandle;
        if (!lockHandle) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `No lockHandle given and none recorded for ${classObjectUrl}. Call lock on that URL first.`
            );
        }

        const startTime = performance.now();
        try {
            this.adtclient.stateful = session_types.stateful;
            const result = await this.adtclient.createTestInclude(args.clas, lockHandle, args.transport);
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
