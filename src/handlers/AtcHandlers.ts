import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { AtcProposal } from 'abap-adt-api';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { objectUrlFor } from '../lib/packageWalk';
import { describeAdtError } from '../lib/adtError';

export class AtcHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'atcCustomizing',
                description: 'How ATC is set up on this system: the check variants and their priorities - what atcCheck runs against by default.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'atcCheckVariant',
                description: 'Opens a worklist for an ATC check variant and answers with its id. It reads nothing about the variant, whatever the name suggests: the id it returns is what createAtcRun needs as its worklistId - passing the variant name there is what makes the run answer 500. atcCheck does this and the run and the report in one call.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        variant: {
                            type: 'string',
                            description: 'The name of the ATC check variant.'
                        }
                    },
                    required: ['variant']
                }
            },
            {
                name: 'createAtcRun',
                description: 'Starts an ATC run over one object. The first parameter has to be a WORKLIST ID, not a check variant name, whatever it is called here: the backend answers 500 for a variant name. Get the id from atcCheckVariant, or use atcCheck which does the whole sequence.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        variant: {
                            type: 'string',
                            description: 'Worklist id, as atcCheckVariant returns it - NOT the check variant name.'
                        },
                        mainUrl: {
                            type: 'string',
                            description: 'The main URL for the ATC run.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'The maximum number of results to retrieve.'
                        }
                    },
                    required: ['variant', 'mainUrl']
                }
            },
            {
                name: 'atcCheck',
                description: 'Run the ATC checks over an object or a whole package and report what they found: for each object, every finding with its priority, the check that raised it, the message, and the source line it points at. This is the whole sequence in one call - the check variant from the system customizing, a worklist, the run, the worklist read back - and getting it wrong is what made a run answer 500 (the run needs a worklist id where the library asks for a variant). Findings are ordered by priority, 1 being the worst.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'Object to check, e.g. ZCL_APP or ZR_APPO_NEW.'
                        },
                        objectType: {
                            type: 'string',
                            description: 'ADT type of that object: CLAS/OC, INTF/OI, PROG/P, FUGR/F, DDLS/DF, TABL/DS. Defaults to CLAS/OC.'
                        },
                        packageName: {
                            type: 'string',
                            description: 'Check a whole package instead of one object - every object in it, sub-packages included.'
                        },
                        objectUrl: {
                            type: 'string',
                            description: 'Escape hatch: the ADT URI to check, if it is neither an object name nor a package.'
                        },
                        variant: {
                            type: 'string',
                            description: 'Check variant to use. Defaults to the system check variant from atcCustomizing.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Cap on the verdicts the backend produces, default 100. A single old report can hold 900.'
                        },
                        maxFindings: {
                            type: 'number',
                            description: 'Cap on the findings reported back, default 100. The counts are always for everything found.'
                        },
                        minPriority: {
                            type: 'number',
                            description: 'Report only findings at least this severe: 1 is the worst, 3 the mildest. Default is all of them.'
                        },
                        includeExempted: {
                            type: 'boolean',
                            description: 'Include findings that carry an approved exemption. Off by default.'
                        }
                    }
                }
            },
            {
                name: 'atcWorklists',
                description: 'An existing ATC worklist by id, with the findings it holds. Prefer atcCheck, which opens a worklist, runs the checks and reports them in one call.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        runResultId: {
                            type: 'string',
                            description: 'The ID of the ATC run result.'
                        },
                        timestamp: {
                            type: 'number',
                            description: 'The timestamp.'
                        },
                        usedObjectSet: {
                            type: 'string',
                            description: 'The used object set.'
                        },
                        includeExempted: {
                            type: 'boolean',
                            description: 'Whether to include exempted findings.'
                        }
                    },
                    required: ['runResultId']
                }
            },
            {
                name: 'atcUsers',
                description: 'The users ATC knows for exemption approval - who can be named as an approver.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'atcDocumentation',
                description: 'The documentation of one ATC finding: what the check means and what it wants instead. Takes the documentation URI that atcWorklists reports for a finding. Returns the document as it comes from the backend, which is HTML.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        docUri: {
                            type: 'string',
                            description: 'Documentation URI of the finding, from the atcWorklists answer.'
                        }
                    },
                    required: ['docUri']
                }
            },
            {
                name: 'atcExemptProposal',
                description: 'The exemption proposal for an ATC finding: what would be requested, before requesting it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        markerId: {
                            type: 'string',
                            description: 'The ID of the marker.'
                        }
                    },
                    required: ['markerId']
                }
            },
            {
                name: 'atcRequestExemption',
                description: 'Ask for an ATC finding to be exempted, with a reason - it goes to an approver, it is not granted here.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        proposal: {
                            type: 'object',
                            description: 'The ATC exemption proposal.'
                        }
                    },
                    required: ['proposal']
                }
            },
            {
                name: 'isProposalMessage',
                description: 'Whether a message from a check is an ATC proposal rather than a plain finding - which decides whether an exemption can be requested for it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        proposal: {
                            type: 'object',
                            description: 'The ATC exemption proposal.'
                        }
                    },
                    required: ['proposal']
                }
            },
            {
                name: 'atcContactUri',
                description: 'The contact URI of an ATC finding - who is responsible for it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        findingUri: {
                            type: 'string',
                            description: 'The URI of the ATC finding.'
                        }
                    },
                    required: ['findingUri']
                }
            },
            {
                name: 'atcChangeContact',
                description: 'Change who is responsible for an ATC finding - it moves the finding into another worklist.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        itemUri: {
                            type: 'string',
                            description: 'The URI of the item.'
                        },
                        userId: {
                            type: 'string',
                            description: 'The ID of the user.'
                        }
                    },
                    required: ['itemUri', 'userId']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'atcCustomizing':
                return this.handleAtcCustomizing(args);
            case 'atcCheckVariant':
                return this.handleAtcCheckVariant(args);
            case 'atcCheck':
                return this.handleAtcCheck(args);
            case 'createAtcRun':
                return this.handleCreateAtcRun(args);
            case 'atcWorklists':
                return this.handleAtcWorklists(args);
            case 'atcUsers':
                return this.handleAtcUsers(args);
            case 'atcDocumentation':
                return this.handleAtcDocumentation(args);
            case 'atcExemptProposal':
                return this.handleAtcExemptProposal(args);
            case 'atcRequestExemption':
                return this.handleAtcRequestExemption(args);
            case 'isProposalMessage':
                return this.handleIsProposalMessage(args);
            case 'atcContactUri':
                return this.handleAtcContactUri(args);
            case 'atcChangeContact':
                return this.handleAtcChangeContact(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown ATC tool: ${toolName}`);
        }
    }

    async handleAtcCustomizing(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcCustomizing();
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
            throw wrapAdtError(error, 'Failed to get ATC customizing');
        }
    }

    async handleAtcCheckVariant(args: { variant: string }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcCheckVariant(args.variant);
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
            throw wrapAdtError(error, 'Failed to get ATC check variant');
        }
    }

    async handleCreateAtcRun(args: { variant: string, mainUrl: string, maxResults?: number }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.createAtcRun(args.variant, args.mainUrl, args.maxResults);
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
            throw wrapAdtError(error, 'Failed to create ATC run');
        }
    }

    async handleAtcWorklists(args: { runResultId: string, timestamp?: number, usedObjectSet?: string, includeExempted?: boolean }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcWorklists(args.runResultId, args.timestamp || 0, args.usedObjectSet || "", args.includeExempted);
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
            throw wrapAdtError(error, 'Failed to get ATC worklists');
        }
    }

    async handleAtcUsers(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcUsers();
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
            throw wrapAdtError(error, 'Failed to get ATC users');
        }
    }

    async handleAtcDocumentation(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            // The library hands back the whole HTTP response here, not a
            // parsed document - only the body is of any use to a caller.
            const response: any = await this.readClient.atcDocumentation(args.docUri);
            this.trackRequest(startTime, true);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        docUri: args.docUri,
                        contentType: response?.headers?.['content-type'],
                        documentation: response?.body
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to read the ATC documentation');
        }
    }

    async handleAtcExemptProposal(args: { markerId: string }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcExemptProposal(args.markerId);
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
            throw wrapAdtError(error, 'Failed to get ATC exempt proposal');
        }
    }

    async handleAtcRequestExemption(args: { proposal: AtcProposal }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.atcRequestExemption(this.parseObjectArg(args.proposal, 'proposal'));
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
            throw wrapAdtError(error, 'Failed to request ATC exemption');
        }
    }

    async handleIsProposalMessage(args: { proposal: AtcProposal }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.isProposalMessage(this.parseObjectArg(args.proposal, 'proposal'));
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
            throw wrapAdtError(error, 'Failed to check if proposal message');
        }
    }

    async handleAtcContactUri(args: { findingUri: string }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcContactUri(args.findingUri);
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
            throw wrapAdtError(error, 'Failed to get ATC contact URI');
        }
    }

    async handleAtcChangeContact(args: { itemUri: string, userId: string }): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.atcChangeContact(args.itemUri, args.userId);
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
            throw wrapAdtError(error, 'Failed to change ATC contact');
        }
    }

    /**
     * The whole ATC sequence, and a report that can be read.
     *
     * Four calls have to happen in order, and the third one is where this used
     * to break: createAtcRun posts to /sap/bc/adt/atc/runs?worklistId=, and the
     * library fills that parameter from an argument it calls "variant" - so a
     * variant name lands in it and the backend answers 500 with nothing to go
     * on. The id has to come from atcCheckVariant, which despite its name opens
     * a worklist and returns its id.
     *
     * A package is checked through its SAPGUI bridge URI: /sap/bc/adt/packages/
     * ZFOO is refused with "No URI-Mapping defined for URI", because that
     * collection is not served on this kind of system at all.
     */
    async handleAtcCheck(args: any): Promise<any> {
        const target = this.atcTarget(args);
        const steps: Record<string, unknown>[] = [];

        let variant = args?.variant ? String(args.variant) : '';
        if (!variant) {
            const startTime = performance.now();
            try {
                const customizing: any = await this.readClient.atcCustomizing();
                this.trackRequest(startTime, true);
                variant = String(
                    (customizing?.properties || []).find((p: any) => p.name === 'systemCheckVariant')?.value || ''
                );
            } catch (error: any) {
                this.trackRequest(startTime, false);
                throw wrapAdtError(error, 'Failed to read the ATC customizing, so the system check variant is unknown. Pass variant');
            }
            if (!variant) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'The system customizing names no check variant (systemCheckVariant). Pass variant.'
                );
            }
        }
        steps.push({ step: 'variant', variant, from: args?.variant ? 'argument' : 'systemCheckVariant' });

        let worklistId: string;
        const worklistStart = performance.now();
        try {
            worklistId = String(await this.readClient.atcCheckVariant(variant));
            this.trackRequest(worklistStart, true);
        } catch (error: any) {
            this.trackRequest(worklistStart, false);
            throw wrapAdtError(error, `Failed to open a worklist for check variant ${variant}`);
        }
        steps.push({ step: 'worklist', worklistId });

        let run: any;
        const runStart = performance.now();
        try {
            run = await this.adtclient.createAtcRun(
                worklistId,
                target.uri,
                Number(args?.maxResults) > 0 ? Number(args.maxResults) : 100
            );
            this.trackRequest(runStart, true);
        } catch (error: any) {
            this.trackRequest(runStart, false);
            const info = describeAdtError(error);
            throw wrapAdtError(
                error,
                /No URI-Mapping/.test(info.error || '')
                    ? `ATC does not accept ${target.uri} as something to check. A package has to be addressed through its SAPGUI bridge URI, an object through its ADT URI`
                    : `Failed to start the ATC run over ${target.label}`
            );
        }
        steps.push({ step: 'run', runId: run?.id, timestamp: run?.timestamp, infos: run?.infos });

        const listStart = performance.now();
        let worklist: any;
        try {
            worklist = await this.readClient.atcWorklists(
                run.id,
                run.timestamp,
                // Typed as a string in the library and sent as a query
                // parameter; "true" is what a run over one object set needs.
                'true',
                args?.includeExempted === true
            );
            this.trackRequest(listStart, true);
        } catch (error: any) {
            this.trackRequest(listStart, false);
            throw wrapAdtError(error, `The ATC run finished but its worklist ${run.id} could not be read`);
        }

        const minPriority = Number(args?.minPriority) > 0 ? Number(args.minPriority) : undefined;
        const maxFindings = Number(args?.maxFindings) > 0 ? Number(args.maxFindings) : 100;
        const byPriority: Record<string, number> = {};
        let total = 0;

        const objects = (worklist?.objects || []).map((object: any) => {
            const findings = (object.findings || [])
                .map((finding: any) => {
                    const priority = Number(finding.priority) || 0;
                    byPriority[priority] = (byPriority[priority] || 0) + 1;
                    total += 1;
                    return {
                        priority,
                        check: finding.checkTitle,
                        message: finding.messageTitle,
                        sourceUrl: finding.location?.uri,
                        line: finding.location?.range?.start?.line,
                        ...(finding.exemptionApproval ? { exemptionApproval: finding.exemptionApproval } : {}),
                        // The link is what atcDocumentation takes, and it is the
                        // only way to the text of the rule.
                        ...(finding.link?.href ? { documentationUri: finding.link.href } : {})
                    };
                })
                .sort((a: any, b: any) => a.priority - b.priority || Number(a.line) - Number(b.line));
            return {
                name: object.name,
                objectType: object.objectTypeId || object.type,
                packageName: object.packageName,
                author: object.author,
                findingCount: findings.length,
                findings
            };
        });

        for (const object of objects) {
            if (minPriority) object.findings = object.findings.filter((f: any) => f.priority <= minPriority);
            object.findingCount = object.findings.length;
        }

        // Worst first, and within an object by priority then line: a report read
        // from the top is then read in the order worth fixing.
        const reported = objects
            .filter((object: any) => object.findingCount > 0)
            .sort((a: any, b: any) => {
                const worst = (o: any) => Math.min(...o.findings.map((f: any) => f.priority));
                return worst(a) - worst(b) || b.findingCount - a.findingCount;
            });

        let budget = maxFindings;
        let cut = false;
        for (const object of reported) {
            if (object.findings.length > budget) {
                object.findings = object.findings.slice(0, Math.max(0, budget));
                object.truncated = true;
                cut = true;
            }
            budget -= object.findings.length;
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    status: 'success',
                    checked: target.label,
                    objectUri: target.uri,
                    variant,
                    totalFindings: total,
                    findingsByPriority: byPriority,
                    objectsWithFindings: reported.length,
                    ...(minPriority ? { minPriority } : {}),
                    ...(cut ? { truncated: true, hint: `Showing ${maxFindings} of ${total} findings. Raise maxFindings, or narrow with minPriority.` } : {}),
                    objects: reported.filter((object: any) => object.findings.length > 0),
                    steps,
                    ...(total === 0
                        ? { hint: `No findings at all under check variant ${variant}.` }
                        : { note: 'Priority 1 is the worst. Read the rule behind a finding with atcDocumentation and its documentationUri.' })
                })
            }]
        };
    }

    /** What to check, as an ADT URI the ATC run accepts. */
    private atcTarget(args: any): { uri: string; label: string } {
        if (typeof args?.objectUrl === 'string' && args.objectUrl.trim()) {
            return { uri: args.objectUrl.trim(), label: args.objectUrl.trim() };
        }
        const packageName = String(args?.packageName || '').trim().toUpperCase();
        if (packageName) {
            return {
                uri: `/sap/bc/adt/vit/wb/object_type/devck/object_name/${encodeURIComponent(packageName)}`,
                label: `package ${packageName}`
            };
        }
        const name = String(args?.objectName || '').trim();
        if (!name) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'What should be checked? Pass objectName (with objectType), packageName, or objectUrl.'
            );
        }
        const objectType = String(args?.objectType || 'CLAS/OC').trim().toUpperCase();
        const uri = objectUrlFor(objectType, name);
        if (!uri) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `atcCheck does not know the ADT URI of a ${objectType}. Pass objectUrl instead.`
            );
        }
        return { uri, label: `${name.toUpperCase()} (${objectType})` };
    }
}
