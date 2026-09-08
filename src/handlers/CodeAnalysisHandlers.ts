import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from 'abap-adt-api';
import { sourceCache } from '../lib/sourceCache.js';
import {
    classSourceUrl,
    interfaceSourceUrl,
    locateType
} from '../lib/symbolPosition';
import type { SymbolPosition } from '../lib/symbolPosition';

export class CodeAnalysisHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'syntaxCheckCode',
                description: 'Perform ABAP syntax check. Provide the source in "code", or omit it to reuse the source last read/written for "url" via getObjectSource/setObjectSource (cached this session).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description: 'The ABAP source to check. Optional if the source for "url" was already read or written this session.'
                        },
                        url: { type: 'string' },
                        mainUrl: { type: 'string' },
                        mainProgram: { type: 'string' },
                        version: { type: 'string' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'syntaxCheckCdsUrl',
                description: 'Perform ABAP syntax check with CDS URL',
                inputSchema: {
                    type: 'object',
                    properties: {
                        cdsUrl: { type: 'string' }
                    },
                    required: ['cdsUrl']
                }
            },
            {
                name: 'codeCompletion',
                description: 'Get code completion suggestions',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: { type: 'string' },
                        source: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' }
                    },
                    required: ['sourceUrl', 'source', 'line', 'column']
                }
            },
            {
                name: 'findDefinition',
                description: 'Find symbol definition',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        source: { type: 'string' },
                        line: { type: 'number' },
                        startCol: { type: 'number' },
                        endCol: { type: 'number' },
                        implementation: { type: 'boolean' },
                        mainProgram: { type: 'string' }
                    },
                    required: ['url', 'source', 'line', 'startCol', 'endCol']
                }
            },
            {
                name: 'usageReferences',
                description: 'Find symbol references',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'typeHierarchy',
                description: 'Subclasses or superclasses of a class or interface. Pass className or interfaceName and the declaration is located in the source here - the backend resolves a hierarchy from a cursor position rather than from a name, which is why url/body/line/offset are only the escape hatch. Defaults to descendants; set superTypes to walk upwards.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        className: {
                            type: 'string',
                            description: 'Class name, e.g. ZCL_MM_PCK_PLAN.'
                        },
                        interfaceName: {
                            type: 'string',
                            description: 'Interface name, e.g. ZIF_MM_C.'
                        },
                        objectSourceUrl: {
                            type: 'string',
                            description: 'Source URL instead of a name, e.g. /sap/bc/adt/oo/classes/zcl_mm/source/main. Pass name as well.'
                        },
                        name: {
                            type: 'string',
                            description: 'Which type to point at, when the source holds more than one. Defaults to className/interfaceName.'
                        },
                        superTypes: {
                            type: 'boolean',
                            description: 'Walk upwards (superclasses, implemented interfaces) instead of downwards (default false).'
                        },
                        url: {
                            type: 'string',
                            description: 'Escape hatch: object URL, used with body, line and offset instead of the lookup.'
                        },
                        body: {
                            type: 'string',
                            description: 'Escape hatch: the source to resolve the position in.'
                        },
                        line: {
                            type: 'number',
                            description: 'Escape hatch: 1-based line of the type name.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Escape hatch: 0-based column of the type name.'
                        }
                    }
                }
            },
            {
                name: 'syntaxCheckTypes',
                description: 'Retrieves syntax check types.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'codeCompletionFull',
                description: 'Performs full code completion.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: { type: 'string' },
                        source: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' },
                        patternKey: { type: 'string' }
                    },
                    required: ['sourceUrl', 'source', 'line', 'column', 'patternKey']
                }
            },
            {
                name: 'runClass',
                description: 'Runs a class.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        className: { type: 'string' }
                    },
                    required: ['className']
                }
            },
            {
                name: 'codeCompletionElement',
                description: 'Retrieves code completion element information.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: { type: 'string' },
                        source: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' }
                    },
                    required: ['sourceUrl', 'source', 'line', 'column']
                }
            },
            {
                name: 'usageReferenceSnippets',
                description: 'Retrieves usage reference snippets.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        references: { type: 'array' }
                    },
                    required: ['references']
                }
            },
            {
                name: 'fixProposals',
                description: 'Retrieves fix proposals.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        source: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' }
                    },
                    required: ['url', 'source', 'line', 'column']
                }
            },
            {
                name: 'fixEdits',
                description: 'Applies fix edits.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        proposal: {
                            type: 'object',
                            description: 'One proposal from fixProposals (object, or a JSON string).'
                        },
                        source: { type: 'string' }
                    },
                    required: ['proposal', 'source']
                }
            },
            {
                name: 'fragmentMappings',
                description: 'Locate a named fragment of an object and get the line and column where it starts - the cheap way to find one method in a class of a few thousand lines. type is an ADT fragment type, <OBJTYPE>/<code>: CLAS/OM for a class method, CLAS/OA for an attribute. There is no working fragment type for a FORM of a report; use findInSource for that.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'Object URL, e.g. /sap/bc/adt/oo/classes/zcl_mm'
                        },
                        type: {
                            type: 'string',
                            description: 'ADT fragment type, e.g. CLAS/OM. Bare names such as FORM are not fragment types and the backend rejects them.'
                        },
                        name: {
                            type: 'string',
                            description: 'Fragment name, e.g. the method name.'
                        }
                    },
                    required: ['url', 'type', 'name']
                }
            },
            {
                name: 'abapDocumentation',
                description: 'Retrieves ABAP documentation.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUri: { type: 'string' },
                        body: { type: 'string' },
                        line: { type: 'number' },
                        column: { type: 'number' },
                        language: { type: 'string' }
                    },
                    required: ['objectUri', 'body', 'line', 'column']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'syntaxCheckCode':
                return this.handleSyntaxCheckCode(args);
            case 'syntaxCheckCdsUrl':
                return this.handleSyntaxCheckCdsUrl(args);
            case 'codeCompletion':
                return this.handleCodeCompletion(args);
            case 'findDefinition':
                return this.handleFindDefinition(args);
            case 'usageReferences':
                return this.handleUsageReferences(args);
            case 'typeHierarchy':
                return this.handleTypeHierarchy(args);
            case 'syntaxCheckTypes':
                return this.handleSyntaxCheckTypes(args);
            case 'codeCompletionFull':
                return this.handleCodeCompletionFull(args);
            case 'runClass':
                return this.handleRunClass(args);
            case 'codeCompletionElement':
                return this.handleCodeCompletionElement(args);
            case 'usageReferenceSnippets':
                return this.handleUsageReferenceSnippets(args);
            case 'fixProposals':
                return this.handleFixProposals(args);
            case 'fixEdits':
                return this.handleFixEdits(args);
            case 'fragmentMappings':
                return this.handleFragmentMappings(args);
            case 'abapDocumentation':
                return this.handleAbapDocumentation(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown code analysis tool: ${toolName}`);
        }
    }
    async handleSyntaxCheckCdsUrl(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.syntaxCheck(args.cdsUrl);
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
            throw wrapAdtError(error, 'Syntax check failed');
        }
    }
    async handleSyntaxCheckCode(args: any): Promise<any> {
        // Reuse the source cached by getObjectSource/setObjectSource for this
        // URL when the caller does not pass it explicitly (issue #2). Resolved
        // before the try so a missing-source error keeps its InvalidParams code.
        let code = args?.code;
        let usedCachedSource = false;
        if (code === undefined || code === null || code === '') {
            const cached = sourceCache.get(args.url);
            if (cached === undefined) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `No source provided and none cached for '${args.url}'. Pass "code", or call getObjectSource/setObjectSource for this URL first.`
                );
            }
            code = cached;
            usedCachedSource = true;
        }

        const startTime = performance.now();
        try {
            const result = await this.readClient.syntaxCheck(args.url, args?.mainUrl, code, args?.mainProgram, args?.version);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            usedCachedSource,
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Syntax check failed');
        }
    }

    async handleCodeCompletion(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.codeCompletion(
                args.sourceUrl,
                args.source,
                args.line,
                args.column
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
            throw wrapAdtError(error, 'Code completion failed');
        }
    }

    async handleFindDefinition(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.findDefinition(
                args.url,
                args.source,
                args.line,
                args.startCol,
                args.endCol,
                args.implementation,
                args.mainProgram
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
            throw wrapAdtError(error, 'Find definition failed');
        }
    }

    async handleUsageReferences(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.usageReferences(
                args.url,
                args.line,
                args.column
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
            throw wrapAdtError(error, 'Usage references failed');
        }
    }

    /**
     * The source of an object, from the cache when it is already there.
     *
     * These lookups exist to save the caller a read of the whole source, so
     * re-reading one it has just fetched would defeat the point.
     */
    protected async sourceOf(sourceUrl: string): Promise<string> {
        const cached = sourceCache.get(sourceUrl);
        if (cached !== undefined) return cached;
        const startTime = performance.now();
        try {
            const source = await this.readClient.getObjectSource(sourceUrl);
            this.trackRequest(startTime, true);
            sourceCache.set(sourceUrl, source);
            return source;
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to read ${sourceUrl}`);
        }
    }

    /** Which source URL a name-or-url argument set points at, and which name. */
    protected sourceUrlOf(args: any): { sourceUrl: string; name: string } {
        if (typeof args?.objectSourceUrl === 'string' && args.objectSourceUrl.trim()) {
            const name = String(args?.name || args?.className || args?.interfaceName || '').trim();
            if (!name) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'With objectSourceUrl, pass name too - the position is found by looking that name up in the source.'
                );
            }
            return { sourceUrl: args.objectSourceUrl.trim(), name };
        }
        if (typeof args?.className === 'string' && args.className.trim()) {
            return {
                sourceUrl: classSourceUrl(args.className),
                name: String(args?.name || args.className).trim()
            };
        }
        if (typeof args?.interfaceName === 'string' && args.interfaceName.trim()) {
            return {
                sourceUrl: interfaceSourceUrl(args.interfaceName),
                name: String(args?.name || args.interfaceName).trim()
            };
        }
        throw new McpError(
            ErrorCode.InvalidParams,
            'Which object? Pass className, interfaceName, or objectSourceUrl together with name.'
        );
    }

    async handleTypeHierarchy(args: any): Promise<any> {
        // A caller that already knows the position skips the lookup.
        const raw = typeof args?.url === 'string' && typeof args?.body === 'string'
            && typeof args?.line === 'number' && typeof args?.offset === 'number';

        let url: string;
        let body: string;
        let line: number;
        let offset: number;
        let resolved: SymbolPosition | undefined;

        if (raw) {
            url = args.url;
            body = args.body;
            line = args.line;
            offset = args.offset;
        } else {
            const { sourceUrl, name } = this.sourceUrlOf(args);
            body = await this.sourceOf(sourceUrl);
            const found = locateType(body, name);
            if (!found) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `No CLASS or INTERFACE statement for '${name}' in ${sourceUrl}. Check the name, or pass url, body, line and offset yourself.`
                );
            }
            resolved = found;
            url = sourceUrl;
            line = found.line;
            offset = found.column;
        }

        const startTime = performance.now();
        try {
            const nodes = await this.readClient.typeHierarchy(
                url,
                body,
                line,
                offset,
                args?.superTypes === true
            );
            this.trackRequest(startTime, true);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        direction: args?.superTypes === true ? 'superTypes' : 'subTypes',
                        ...(resolved ? { resolvedAt: { line, column: offset, lineText: resolved.lineText } } : {}),
                        count: (nodes || []).length,
                        nodes
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to read the type hierarchy');
        }
    }

    async handleSyntaxCheckTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.syntaxCheckTypes();
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
            throw wrapAdtError(error, 'Syntax check types failed');
        }
    }

    async handleCodeCompletionFull(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.codeCompletionFull(args.sourceUrl, args.source, args.line, args.column, args.patternKey);
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
            throw wrapAdtError(error, 'Code completion full failed');
        }
    }

    async handleRunClass(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.runClass(args.className);
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
            throw wrapAdtError(error, 'Run class failed');
        }
    }

    async handleCodeCompletionElement(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.codeCompletionElement(args.sourceUrl, args.source, args.line, args.column);
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
            throw wrapAdtError(error, 'Code completion element failed');
        }
    }

    async handleUsageReferenceSnippets(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.usageReferenceSnippets(this.parseObjectArg(args.references, 'references'));
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
            throw wrapAdtError(error, 'Usage reference snippets failed');
        }
    }

    async handleFixProposals(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.fixProposals(args.url, args.source, args.line, args.column);
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
            throw wrapAdtError(error, 'Fix proposals failed');
        }
    }

    async handleFixEdits(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.fixEdits(this.parseObjectArg(args.proposal, 'proposal'), args.source);
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
            throw wrapAdtError(error, 'Fix edits failed');
        }
    }

    async handleFragmentMappings(args: any): Promise<any> {
        const startTime = performance.now();
        // An ADT fragment type is always <OBJTYPE>/<code>. A bare word - FORM
        // was the one that cost an afternoon - is not one, and the backend
        // answers 400 or 500 to it. Saying so here costs nothing; the call
        // itself used to be worse than useless, because a rejected fragment
        // type is one of the ways an ADT session dies.
        const type = String(args?.type || '');
        if (!type.includes('/')) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `'${type}' is not an ADT fragment type - those are written <OBJTYPE>/<code>, e.g. CLAS/OM for a class method. ` +
                'To find a FORM, a MODULE or any other statement in a report, use findInSource.'
            );
        }
        try {
            const result = await this.readClient.fragmentMappings(args.url, args.type, args.name);
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
            // The backend rejects fragment types it does not know for the
            // object at hand, and the rejection says nothing useful. Point at
            // what does work rather than passing the bare 400 on.
            throw wrapAdtError(
                error,
                `Fragment mappings failed for type '${type}'. Class methods answer to CLAS/OM; ` +
                'for a FORM, a MODULE or free-standing code in a report, use findInSource instead of a fragment type. This ran on the read session, so no lock was lost'
            );
        }
    }

    async handleAbapDocumentation(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.abapDocumentation(args.objectUri, args.body, args.line, args.column, args.language);
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
            throw wrapAdtError(error, 'ABAP documentation failed');
        }
    }
}
