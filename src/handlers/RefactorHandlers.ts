import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { packageUriOf } from '../lib/activation';
import { ADTClient, Range, ExtractMethodProposal, GenericRefactoring } from 'abap-adt-api';

export class RefactorHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'changePackagePreview',
                description: 'What moving an object to another package would involve: the refactoring the backend proposes, with the old and new package and the transport it would be recorded in. Preview only - this server does not execute the move, because the library offers no evaluate step and the payload has to be assembled here, which is not something to run unverified against a real package. Do the move itself in ADT or SE80 once the preview looks right.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'Object to move, e.g. /sap/bc/adt/oo/classes/zcl_app_foo.'
                        },
                        newPackage: {
                            type: 'string',
                            description: 'Target package, e.g. ZAPP_BASE.'
                        },
                        transport: {
                            type: 'string',
                            description: 'Transport request the move would be recorded in - the request itself, not a developer task.'
                        },
                        oldPackage: {
                            type: 'string',
                            description: 'Current package; looked up when omitted.'
                        },
                        objectName: {
                            type: 'string',
                            description: 'Object name; looked up when omitted.'
                        },
                        objectType: {
                            type: 'string',
                            description: 'ADT object type, e.g. CLAS/OC; looked up when omitted.'
                        },
                        ignoreSyntaxErrors: {
                            type: 'boolean',
                            description: 'Ask the backend to propose the move even with syntax errors (default false).'
                        }
                    },
                    required: ['objectUrl', 'newPackage']
                }
            },
            {
                name: 'extractMethodEvaluate',
                description: 'First of the three steps that pull a range of lines out into a method: it asks the system whether the range CAN be extracted and what the new method would need - which variables come in, which go out. Nothing is written. Then extractMethodPreview, then extractMethodExecute.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uri: {
                            type: 'string',
                            description: 'The URI of the object.'
                        },
                        range: {
                            type: 'string',
                            description: 'The range to extract, as a JSON string, e.g. {"start":{"line":1,"column":0},"end":{"line":5,"column":10}}'
                        }
                    },
                    required: ['uri', 'range']
                }
            },
            {
                name: 'extractMethodPreview',
                description: 'Second step of extract-method: the edits the refactoring would make, from the evaluation you pass back in. Still nothing written - this is where the new signature and the changed call site can be read before agreeing to them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        proposal: {
                            type: 'string',
                            description: 'The extract method proposal returned by extractMethodEvaluate, as a JSON string.'
                        }
                    },
                    required: ['proposal']
                }
            },
            {
                name: 'extractMethodExecute',
                description: 'Third step of extract-method: apply what the preview showed. This WRITES the object, so it needs the object unlocked by anything else and, outside $TMP, a transport request. Nothing is rolled back if the activation afterwards fails.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        refactoring: {
                            type: 'string',
                            description: 'The refactoring returned by extractMethodPreview, as a JSON string.'
                        }
                    },
                    required: ['refactoring']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'changePackagePreview':
                return this.handleChangePackagePreview(args);
            case 'extractMethodEvaluate':
                return this.handleExtractMethodEvaluate(args);
            case 'extractMethodPreview':
                return this.handleExtractMethodPreview(args);
            case 'extractMethodExecute':
                return this.handleExtractMethodExecute(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown refactor tool: ${toolName}`);
        }
    }

    /**
     * What a package move would look like.
     *
     * Unlike rename, the library has no evaluate step for this refactoring:
     * the document the preview posts has to be built by the caller, which
     * means the object's own name, type and current package have to be known.
     * They are looked up here rather than demanded.
     */
    async handleChangePackagePreview(args: any): Promise<any> {
        const objectUrl = String(args?.objectUrl || '').split('#')[0];
        const newPackage = String(args?.newPackage || '').toUpperCase();
        if (!objectUrl || !newPackage) {
            throw new McpError(ErrorCode.InvalidParams, 'Pass objectUrl and newPackage.');
        }

        let name = args?.objectName;
        let type = args?.objectType;
        let oldPackage = args?.oldPackage;

        if (!name || !type) {
            const startTime = performance.now();
            try {
                const structure: any = await this.readClient.objectStructure(objectUrl);
                this.trackRequest(startTime, true);
                name = name || structure?.metaData?.['adtcore:name'];
                type = type || structure?.metaData?.['adtcore:type'];
            } catch (error: any) {
                this.trackRequest(startTime, false);
                throw wrapAdtError(
                    error,
                    `Failed to read ${objectUrl}, whose name and type the refactoring document needs. Pass objectName and objectType to skip the lookup`
                );
            }
        }
        if (!oldPackage) {
            const uri = await packageUriOf(this.readClient, objectUrl);
            oldPackage = uri ? decodeURIComponent(uri.split('/').pop() || '').toUpperCase() : '';
        }
        if (!name || !type) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Could not determine the name and type of ${objectUrl}. Pass objectName and objectType.`
            );
        }

        const refactoring: any = {
            title: 'Change Package',
            adtObjectUri: objectUrl,
            oldPackage,
            newPackage,
            transport: args?.transport || '',
            ignoreSyntaxErrorsAllowed: true,
            ignoreSyntaxErrors: args?.ignoreSyntaxErrors === true,
            userContent: '',
            affectedObjects: {
                uri: objectUrl,
                type,
                name,
                oldPackage,
                newPackage,
                parentUri: ''
            }
        };

        const startTime = performance.now();
        // abap-adt-api prints the refactoring to stdout here, and stdout is
        // the MCP protocol stream: an unguarded call would corrupt the
        // conversation with the client. Send it to stderr for the duration.
        const stdoutLog = console.log;
        console.log = (...parts: unknown[]) => console.error(...parts);
        try {
            const preview = await this.readClient.changePackagePreview(
                refactoring,
                args?.transport
            );
            this.trackRequest(startTime, true);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        executed: false,
                        objectUrl,
                        objectName: name,
                        objectType: type,
                        oldPackage,
                        newPackage,
                        preview,
                        hint: 'Preview only - nothing was moved. This server does not run the execute step; do the move in ADT or SE80.'
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to preview moving ${name} to ${newPackage}`);
        } finally {
            console.log = stdoutLog;
        }
    }

    async handleExtractMethodEvaluate(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const range = this.parseObjectArg<Range>(args.range, 'range');
            const result = await this.readClient.extractMethodEvaluate(args.uri, range);
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
            throw wrapAdtError(error, 'Failed to evaluate extract method');
        }
    }

    async handleExtractMethodPreview(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const proposal = this.parseObjectArg<ExtractMethodProposal>(args.proposal, 'proposal');
            const result = await this.readClient.extractMethodPreview(proposal);
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
            throw wrapAdtError(error, 'Failed to preview extract method');
        }
    }

    async handleExtractMethodExecute(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const refactoring = this.parseObjectArg<GenericRefactoring>(args.refactoring, 'refactoring');
            const result = await this.adtclient.extractMethodExecute(refactoring);
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
            throw wrapAdtError(error, 'Failed to execute extract method');
        }
    }
}
