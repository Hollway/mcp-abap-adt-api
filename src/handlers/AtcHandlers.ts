import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { AtcProposal } from 'abap-adt-api';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { objectUrlFor } from '../lib/packageWalk';
import { describeAdtError } from '../lib/adtError';
import { requireShape } from '../lib/argShape';
import { isVariantNameSafe, variantQuery, variantNames, judgeVariant } from '../lib/atcVariants';
import { documentText } from '../lib/htmlText';
import { filterUsers } from '../lib/userList';

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
                description: 'Run the ATC checks over an object or a whole package and report what they found: for each object, every finding with its priority, the check that raised it, the message, and the source line it points at. This is the whole sequence in one call - the check variant from the system customizing, a worklist, the run, the worklist read back - and getting it wrong is what made a run answer 500 (the run needs a worklist id where the library asks for a variant). Findings are ordered by priority, 1 being the worst. A standard SAP object answers with no findings because the backend drops it from the run - measured, and the answer says so rather than calling it clean; check custom code.',
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
                description: 'The users ATC knows for exemption approval - who can be named as an approver. Search with filter rather than reading the whole address book of the system.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filter: {
                            type: 'string',
                            description: 'Case-insensitive substring, matched against both the user id and the name. Without it the whole list comes back, which on a real system is several hundred entries.'
                        },
                        limit: {
                            type: 'number',
                            description: 'Cap on the users reported, default 50. The counts are always for everything found.'
                        }
                    }
                }
            },
            {
                name: 'atcDocumentation',
                description: 'The documentation of one ATC finding: what the check means and what it wants instead. Takes the documentationUri that atcCheck reports for each finding (atcWorklists carries the same URI). The backend writes it as an HTML page; what comes back is its text, with the page itself only when html is set. Verified live: a finding of the 075 master-language check answered with its Details of Analysis.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        docUri: {
                            type: 'string',
                            description: 'Documentation URI of the finding, from the atcWorklists answer.'
                        },
                        html: {
                            type: 'boolean',
                            description: 'Return the HTML page as well as the text. Off by default.'
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
        return this.tracked('Failed to get ATC customizing', async () => {
            const result = await this.readClient.atcCustomizing();
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
        });
    }

    /**
     * Whether the system knows this check variant. The worklist endpoint takes
     * any name and answers with an id, so the only honest moment to refuse one
     * is before that call. Code Inspector keeps them in SCICHKV_HD; a system
     * that will not answer that read is not argued with - the check says so
     * and the call goes ahead.
     */
    private async verifyVariant(variant: string): Promise<{ checked: boolean; exists?: boolean; examples?: string[] }> {
        if (!isVariantNameSafe(variant)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `"${variant}" is not a check variant name: they are up to 30 characters of A-Z, digits, underscore and the namespace slash. The name also travels in a query string, so nothing else is passed on.`
            );
        }
        try {
            const rows = await this.readClient.runQuery(variantQuery(), 500);
            return judgeVariant(variant, variantNames(rows));
        } catch {
            return { checked: false };
        }
    }

    async handleAtcCheckVariant(args: { variant: string }): Promise<any> {
        const startTime = performance.now();
        const verdict = await this.verifyVariant(String(args?.variant ?? ''));
        if (verdict.checked && !verdict.exists) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `This system has no ATC check variant called "${args?.variant}". The worklist endpoint would still answer with an id - a different one on every call - and the run started on it fails later with a bare 500. ` +
                (verdict.examples?.length ? `Global variants here include: ${verdict.examples.join(', ')}.` : 'atcCustomizing names the system check variant.')
            );
        }
        try {
            const result = await this.readClient.atcCheckVariant(args.variant);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            variant: args.variant,
                            variantVerified: verdict.checked === true,
                            worklistId: result,
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
        return this.tracked('Failed to create ATC run', async () => {
            const result = await this.adtclient.createAtcRun(args.variant, args.mainUrl, args.maxResults);
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
        });
    }

    async handleAtcWorklists(args: { runResultId: string, timestamp?: number, usedObjectSet?: string, includeExempted?: boolean }): Promise<any> {
        return this.tracked(error => describeAdtError(error).status === 500
                ? `The ATC worklist ${args?.runResultId} could not be read. A run result id comes from createAtcRun or from the run step of atcCheck - a worklist id, or an id from another system, is answered with this same 500`
                : 'Failed to get ATC worklists', async () => {
            const result = await this.readClient.atcWorklists(args.runResultId, args.timestamp || 0, args.usedObjectSet || "", args.includeExempted);
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
        });
    }

    async handleAtcUsers(args: any): Promise<any> {
        return this.tracked('Failed to get ATC users', async () => {
            const result = filterUsers(await this.readClient.atcUsers(), args);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...result
                        })
                    }
                ]
            };
        });
    }

    async handleAtcDocumentation(args: any): Promise<any> {
        return this.tracked('Failed to read the ATC documentation', async () => {
            // The library hands back the whole HTTP response here, not a
            // parsed document - only the body is of any use to a caller.
            const response: any = await this.readClient.atcDocumentation(args.docUri);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        docUri: args.docUri,
                        contentType: response?.headers?.['content-type'],
                        ...documentText(String(response?.body ?? ''), args?.html === true),
                        documentation: documentText(String(response?.body ?? '')).text
                    })
                }]
            };
        });
    }

    async handleAtcExemptProposal(args: { markerId: string }): Promise<any> {
        return this.tracked(error => describeAdtError(error).status === 500
                ? `No exemption proposal for marker ${args?.markerId}. The marker id comes from a finding of atcCheck - an invented one is answered with this same 500`
                : 'Failed to get ATC exempt proposal', async () => {
            const result = await this.readClient.atcExemptProposal(args.markerId);
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
        });
    }

    /**
     * Ask for a finding to be exempted.
     *
     * The library destructures the proposal down two levels - finding, and
     * restriction.rangeOfFindings - so anything that is not the object
     * atcExemptProposal answered with came back as "Cannot read properties of
     * undefined (reading 'rangeOfFindings')", which reads as a backend fault.
     */
    async handleAtcRequestExemption(args: { proposal: AtcProposal }): Promise<any> {
        const proposal: any = this.parseObjectArg(args.proposal, 'proposal');
        requireShape(proposal, {
            parameter: 'proposal',
            fields: ['finding', 'restriction'],
            producedBy: 'atcExemptProposal'
        });
        if (!proposal.restriction?.rangeOfFindings) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'The proposal has no restriction.rangeOfFindings, which is what the exemption request is built from. ' +
                'Pass the proposal atcExemptProposal answered with, unchanged.'
            );
        }
        return this.tracked('Failed to request ATC exemption', async () => {
            const result = await this.adtclient.atcRequestExemption(proposal);
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
        });
    }

    async handleIsProposalMessage(args: { proposal: AtcProposal }): Promise<any> {
        return this.tracked('Failed to check if proposal message', async () => {
            const result = await this.readClient.isProposalMessage(this.parseObjectArg(args.proposal, 'proposal'));
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
        });
    }

    /**
     * Who is on the hook for a finding.
     *
     * The call posts the finding reference to /sap/bc/adt/atc/items, which is
     * part of the exemption approval workflow. A system that does not run that
     * workflow has no such collection and answers 404 for every finding, which
     * on its own reads as "this finding has no contact".
     */
    async handleAtcContactUri(args: { findingUri: string }): Promise<any> {
        const findingUri = String(args?.findingUri || '').trim();
        if (!findingUri) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Pass findingUri - the uri of one finding, as atcCheck reports it under findingUri.'
            );
        }
        const startTime = performance.now();
        try {
            const result = await this.readClient.atcContactUri(findingUri);
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
            const info = describeAdtError(error);
            throw wrapAdtError(
                error,
                info.status === 404
                    ? 'No ATC contact for this finding: /sap/bc/adt/atc/items answered 404. That collection is the exemption approval workflow, so this is what a system without it answers for every finding, not a fact about this one'
                    : `Failed to get the ATC contact for ${findingUri}`
            );
        }
    }

    /**
     * Put a finding on somebody's desk. Same collection as atcContactUri, and
     * the same 404 on a system that does not run the approval workflow.
     */
    async handleAtcChangeContact(args: { itemUri: string, userId: string }): Promise<any> {
        const itemUri = String(args?.itemUri || '').trim();
        const userId = String(args?.userId || '').trim();
        if (!itemUri || !userId) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Pass itemUri - the item atcContactUri answered with - and userId, the user to make responsible.'
            );
        }
        const startTime = performance.now();
        try {
            const result = await this.adtclient.atcChangeContact(itemUri, userId);
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
            throw wrapAdtError(
                error,
                describeAdtError(error).status === 404
                    ? 'ATC contacts are not served by this system: /sap/bc/adt/atc/items answers 404, which is what a system without the exemption approval workflow answers for every item'
                    : `Failed to make ${userId} the ATC contact for ${itemUri}`
            );
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
        const verdict = await this.verifyVariant(variant);
        if (verdict.checked && !verdict.exists) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `This system has no ATC check variant called "${variant}". The worklist would open on it anyway and the run would then fail with a bare 500. ` +
                (verdict.examples?.length ? `Global variants here include: ${verdict.examples.join(', ')}.` : '')
            );
        }
        steps.push({
            step: 'variant',
            variant,
            from: args?.variant ? 'argument' : 'systemCheckVariant',
            verified: verdict.checked === true
        });

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
                        // The marker id the exemption tools take. The backend
                        // calls it quickfixInfo; atcExemptProposal calls it
                        // markerId, and without it here the exemption chain
                        // could not be reached from this report at all.
                        ...(finding.quickfixInfo ? { markerId: finding.quickfixInfo } : {}),
                        // The finding's own URI is what atcContactUri and the
                        // exemption tools take. Without it here, nothing this
                        // tool answers can be fed to them.
                        ...(finding.uri ? { findingUri: finding.uri } : {}),
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

        // A run over a standard SAP object finds nothing because it checks
        // nothing: the backend drops the object and says so among the run
        // infos, where "no findings" otherwise reads as "nothing wrong".
        const excluded = (run?.infos || [])
            .map((info: any) => String(info?.description || ''))
            .find((description: string) => /excluded from ATC check run/i.test(description));

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
                        ? {
                            hint: excluded
                                ? `No findings, but the run excluded the object: the backend reported "${excluded}". Standard SAP objects are excluded from an ATC run on this system, so this is not a clean bill of health - check a custom object instead.`
                                : `No findings at all under check variant ${variant}.`
                        }
                        : { note: 'Priority 1 is the worst. Read the rule behind a finding with atcDocumentation and its documentationUri; markerId is what atcExemptProposal takes, findingUri what atcContactUri takes, and the run id under steps re-reads the whole worklist with atcWorklists.' })
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
        const objectType = this.objectTypeArg(args);
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
