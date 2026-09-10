import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from 'abap-adt-api';
import { sourceCache } from '../lib/sourceCache.js';
import {
    classSourceUrl,
    interfaceSourceUrl,
    locateMethod,
    locateType,
    objectUrlOf
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
                description: 'Syntax check for a CDS object, which is addressed differently from ABAP: the DDL source URL goes in as the main URL. For ordinary ABAP use syntaxCheckCode.',
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
                description: 'Completion proposals for a cursor position: what may be written at line/column of this source. Needs the source and the position, exactly like the editor, so it is worth having when composing a call against an unfamiliar interface; codeCompletionFull adds the insert text and codeCompletionElement the details of one proposal.',
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
                description: 'Where the symbol under a cursor position is defined - the F3 of ADT. Takes the source URL with a line and column, and answers with the object and position of the declaration, so it needs the source read first to count the position. To go the other way, use usageReferences or impactOf.',
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
                description: 'Where-used for the symbol at a cursor position, or for the whole object when no position is given. The answer is a flat list that is really a tree - one row per package, per object, and per place inside it - so it is large: a widely used class answers with hundreds of rows and over a hundred thousand characters, past the response cap. Prefer impactOf, which asks this and rolls it up; use whereUsedMethod for one method by name.',
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
                name: 'whereUsedMethod',
                description: 'Who calls this method. usageReferences needs the line and column of the name inside the source, which means reading the class first and counting characters; here the method name is enough. Returns the callers with the object they sit in, and their source snippets with snippets=true.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        className: {
                            type: 'string',
                            description: 'Class holding the method, e.g. ZCL_APP_PCK_PLAN.'
                        },
                        interfaceName: {
                            type: 'string',
                            description: 'Interface holding the method, for an interface method.'
                        },
                        objectSourceUrl: {
                            type: 'string',
                            description: 'Source URL instead of a name, e.g. /sap/bc/adt/oo/classes/zcl_app/source/main.'
                        },
                        method: {
                            type: 'string',
                            description: 'Method name, e.g. CHECK_PLAN. The declaration is preferred over the implementation, because ADT answers a where-used on the declaration with every caller.'
                        },
                        snippets: {
                            type: 'boolean',
                            description: 'Also fetch the source snippet of each usage (one more backend call, much larger answer).'
                        }
                    },
                    required: ['method']
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
                            description: 'Class name, e.g. ZCL_APP_PCK_PLAN.'
                        },
                        interfaceName: {
                            type: 'string',
                            description: 'Interface name, e.g. ZIF_APP_C.'
                        },
                        objectSourceUrl: {
                            type: 'string',
                            description: 'Source URL instead of a name, e.g. /sap/bc/adt/oo/classes/zcl_app/source/main. Pass name as well.'
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
                description: 'Which syntax-check flavours this system offers, as the check endpoint understands them. Diagnostic; syntaxCheckCode picks the right one itself.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'codeCompletionFull',
                description: 'Completion proposals with the text to insert and the position to insert it at, for a cursor position in a source. The fuller form of codeCompletion.',
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
                description: 'Execute a class that implements IF_OO_ADT_CLASSRUN - the F9 of an ADT editor - and return its console output. The class has to exist and implement that interface; to run a piece of ABAP that does not, use runSnippet, which wraps it in such a class for you. This EXECUTES CODE on the system as the connected user, so it counts as a writing tool and read-only mode refuses it. A runtime error comes back as a bare 500; the reason is in ST22 (runSnippet reads the dump for you).',
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
                description: 'The details behind one completion proposal: its type, its documentation, where it comes from. Follows codeCompletion for the entry you want to know more about.',
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
                description: 'The source lines around each usage, for references you already have from usageReferences - pass those rows back in. One more backend call and a much larger answer, so ask for it when the call site itself matters.',
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
                description: 'Quick-fix proposals the system offers for a position in a source - the same list as the light bulb in ADT (create the missing method, add the missing variable). What comes back is passed to fixEdits to get the actual edits.',
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
                description: 'Turn one proposal from fixProposals into concrete edits: the ranges and the replacement text. It computes them and does NOT write - apply them with patchObjectSource or editObject.',
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
                            description: 'Object URL, e.g. /sap/bc/adt/oo/classes/zcl_app'
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
                description: 'The ABAP keyword or object documentation for a position in a source - the F1 of ADT. Answers with the help text as it is written for that release, which is worth reading before guessing at a statement variant.',
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
            case 'whereUsedMethod':
                return this.handleWhereUsedMethod(args);
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

    /**
     * Where-used for a method, by name.
     *
     * usageReferences resolves whatever the cursor is on, so its useful form
     * needs a position - and a position means reading the class, finding the
     * method and counting columns before the interesting call can even be
     * made. All of that happens here.
     *
     * Which URL carries the position is a backend detail: the source URL is
     * the one that matches how ADT itself asks, and if it comes back empty the
     * object URL is tried as well, with the answer saying which one replied.
     */
    async handleWhereUsedMethod(args: any): Promise<any> {
        const method = String(args?.method || '').trim();
        if (!method) {
            throw new McpError(ErrorCode.InvalidParams, 'Which method? Pass method.');
        }
        const { sourceUrl } = this.sourceUrlOf({ ...args, name: args?.name || args?.className || args?.interfaceName });
        const source = await this.sourceOf(sourceUrl);
        const at = locateMethod(source, method);
        if (!at) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `No declaration or implementation of '${method}' in ${sourceUrl}. Check the name with sourceOutline or classComponents.`
            );
        }

        const startTime = performance.now();
        try {
            let askedUrl = sourceUrl;
            let references = await this.readClient.usageReferences(sourceUrl, at.line, at.column);
            if ((references || []).length === 0) {
                const objectUrl = objectUrlOf(sourceUrl);
                const retry = await this.readClient.usageReferences(objectUrl, at.line, at.column);
                if ((retry || []).length > 0) {
                    references = retry;
                    askedUrl = objectUrl;
                }
            }
            this.trackRequest(startTime, true);

            const usages = (references || []).map((r: any) => ({
                name: r?.['adtcore:name'],
                type: r?.['adtcore:type'],
                uri: r?.uri,
                package: r?.packageRef?.['adtcore:name'],
                objectIdentifier: r?.objectIdentifier
            }));

            const snippets = args?.snippets === true && (references || []).length > 0
                ? await this.readClient.usageReferenceSnippets(references)
                : undefined;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'success',
                        method: method.toUpperCase(),
                        resolvedAt: {
                            sourceUrl,
                            line: at.line,
                            column: at.column,
                            kind: at.kind,
                            lineText: at.lineText
                        },
                        askedUrl,
                        count: usages.length,
                        usages,
                        ...(snippets ? { snippets } : {}),
                        ...(usages.length === 0
                            ? { note: 'No usages came back. A private method used only inside its own class, or a method reached only dynamically, looks exactly like this.' }
                            : {})
                    })
                }]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, `Failed to find usages of ${method}`);
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
