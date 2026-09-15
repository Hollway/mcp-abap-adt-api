import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from 'abap-adt-api';
import { sourceCache } from '../lib/sourceCache.js';
import {
    classSourceUrl,
    cursorAt,
    interfaceSourceUrl,
    locateMethod,
    locateType,
    objectUrlOf
} from '../lib/symbolPosition';
import type { CursorAt, SymbolPosition } from '../lib/symbolPosition';
import { pageUsages, snippetableReferences } from '../lib/usageReferences';
import { documentText } from '../lib/htmlText';
import { fixProposalRows, FIX_PROPOSAL_FIELDS } from '../lib/quickFixes';
import { requireShape } from '../lib/argShape';

export class CodeAnalysisHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'syntaxCheckCode',
                description: 'Perform ABAP syntax check. Provide the source in "code", or omit it: the source last read or written for "url" this session is reused, and failing that it is read. An include is a special case this handles for you - it compiles only as part of its program, and this backend reads the content it is given as that program, so an include\'s own text checked on its own comes back as "REPORT/PROGRAM statement missing". For an include URL the main program is looked up, its stored source is what gets checked, and the answer says so in checkedAgainst. Write the include first: a change that is not saved cannot be checked this way.',
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
                description: 'Syntax check for a CDS object, which is addressed differently from ABAP: the DDL source URL goes in as the main URL. For ordinary ABAP use syntaxCheckCode. A URL that names no object is said so - the backend answers an empty message list for a view that does not exist, which reads exactly like a clean check.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        cdsUrl: {
                            type: 'string',
                            description: 'The DDL source URL, e.g. /sap/bc/adt/ddic/ddl/sources/i_country.'
                        }
                    },
                    required: ['cdsUrl']
                }
            },
            {
                name: 'codeCompletion',
                description: 'Completion proposals for a cursor position: what may be written at line/column of this source. Needs the source and the position, exactly like the editor, so it is worth having when composing a call against an unfamiliar interface. A position outside the source is refused here rather than answered with an empty list, which is what the backend does and which reads like "nothing may be written here". Each proposal carries IDENTIFIER - that is the patternKey codeCompletionFull takes; codeCompletionElement gives the details of what is under the cursor.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: {
                            type: 'string',
                            description: 'Source URL the position is in, e.g. /sap/bc/adt/oo/classes/cl_abap_gzip/source/main.'
                        },
                        source: {
                            type: 'string',
                            description: 'The source as the editor holds it, including whatever is half-written at the cursor. Omit it to complete against the stored source. A page of a source is not a smaller source: the backend parses what it is sent.'
                        },
                        line: { type: 'number', description: 'Line of the cursor, counting from 1.' },
                        column: { type: 'number', description: 'Column of the cursor in that line, counting from 0.' }
                    },
                    required: ['sourceUrl', 'line', 'column']
                }
            },
            {
                name: 'findDefinition',
                description: 'Where the symbol under a cursor position is defined - the F3 of ADT. Takes the source URL with a line and column, and answers with the object and position of the declaration, so it needs the source read first to count the position. The position is checked against the source you pass before the call is spent, and the answer quotes the name the cursor was on: a line out by one is answered confidently, about a different object, and nothing in the backend answer says so. When nothing is found the answer says found: false rather than handing back an empty URL. To go the other way, use usageReferences or impactOf.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'Source URL the position is in, e.g. /sap/bc/adt/oo/classes/cl_abap_gzip/source/main.'
                        },
                        source: {
                            type: 'string',
                            description: 'The source itself, only for a text not yet written to the system - omit it and the whole stored source is read, from the session cache when it is there. Never pass a page of a source: the position is resolved inside the text sent, and a class cut short answers "The source code of this class is incomplete".'
                        },
                        line: { type: 'number', description: 'Line of the name, counting from 1.' },
                        startCol: { type: 'number', description: 'Column where the name starts, counting from 0.' },
                        endCol: { type: 'number', description: 'Column just past the end of the name, counting from 0.' },
                        implementation: {
                            type: 'boolean',
                            description: 'Go to the implementation rather than the declaration - the difference between a method definition and its METHOD block.'
                        },
                        mainProgram: {
                            type: 'string',
                            description: 'For a position inside an include: the program it compiles as part of.'
                        }
                    },
                    required: ['url', 'line', 'startCol', 'endCol']
                }
            },
            {
                name: 'usageReferences',
                description: 'Where-used for the symbol at a cursor position, or for the whole object when no position is given. The backend answers with the whole tree at once and has no paging of its own - measured, CL_ABAP_TYPEDESCR answers with 40,660 rows and 21 million characters, a hundred times the response cap - so the answer is summarised and paged here: counts of rows, usage sites, objects and packages over the whole result, then one page of rows trimmed to name, type, package, uri and the objectIdentifier that usageReferenceSnippets needs. The rows are a tree flattened: only those carrying an objectIdentifier are usage sites, and onlyWithSnippets keeps just those. The fetch still costs what it costs on the backend; what is saved is the reading. For a rolled-up answer over the whole tree use impactOf, for one method by name whereUsedMethod.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'Object URL, e.g. /sap/bc/adt/oo/classes/cl_abap_gzip. A source URL works too.'
                        },
                        line: {
                            type: 'number',
                            description: 'Line of the symbol to ask about, counting from 1. Without it the whole object is asked about.'
                        },
                        column: {
                            type: 'number',
                            description: 'Column inside that line, counting from 0.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Rows in this page, default 100. The summary always counts the whole answer, not the page.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Rows to skip, for the next page. Default 0.'
                        },
                        onlyWithSnippets: {
                            type: 'boolean',
                            description: 'Keep only rows that carry an objectIdentifier - the usage sites, the only rows usageReferenceSnippets can show source for. The grouping rows of the tree are dropped.'
                        }
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
                description: 'The text one completion proposal would insert, for a cursor position in a source. Measured, it answers a single string - not a list of proposals, and not the position to insert it at, whatever its name suggests: run codeCompletion for the list, then this for the one entry you picked. patternKey is that entry\'s IDENTIFIER, and a value that names no proposal makes the backend raise an exception rather than answer empty.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: {
                            type: 'string',
                            description: 'Source URL the position is in, the same one codeCompletion was asked with.'
                        },
                        source: { type: 'string', description: 'The source as the editor holds it; omit it for the stored one.' },
                        line: { type: 'number', description: 'Line of the cursor, counting from 1.' },
                        column: { type: 'number', description: 'Column of the cursor in that line, counting from 0.' },
                        patternKey: {
                            type: 'string',
                            description: 'IDENTIFIER of the proposal from codeCompletion. A name it does not know answers 500 "Обнаружена особая ситуация" / "Exception occurred".'
                        }
                    },
                    required: ['sourceUrl', 'line', 'column', 'patternKey']
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
                description: 'What the name under the cursor is: its name, its ADT type, a link to its documentation and its components. It answers about the position, not about a proposal from codeCompletion - put the cursor on the name you are asking about.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceUrl: {
                            type: 'string',
                            description: 'Source URL the position is in, e.g. /sap/bc/adt/oo/classes/cl_abap_gzip/source/main.'
                        },
                        source: { type: 'string', description: 'The source as the editor holds it; omit it for the stored one.' },
                        line: { type: 'number', description: 'Line of the cursor, counting from 1.' },
                        column: { type: 'number', description: 'Column of the cursor in that line, counting from 0.' }
                    },
                    required: ['sourceUrl', 'line', 'column']
                }
            },
            {
                name: 'usageReferenceSnippets',
                description: 'The source lines around each usage, for references you already have from usageReferences - pass those rows back in. The request is built out of objectIdentifier alone, and rows without one are the grouping rows of the tree: handing those over answers with nothing and says nothing, so they are refused here with the reason. One backend call and a large answer - roughly 3,000 characters per usage site - so ask for the sites that matter rather than a page of them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        references: {
                            type: 'array',
                            description: 'Rows from usageReferences, as they came. Only those carrying objectIdentifier count; ask usageReferences with onlyWithSnippets to get just those.'
                        }
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
                description: 'The ABAP keyword or object documentation for a position in a source - the F1 of ADT. Answers with the help text as it is written for that release, which is worth reading before guessing at a statement variant. The backend sends a whole HTML page, some 14,000 characters of which the text is a fraction, so the text is what comes back unless html is set.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUri: {
                            type: 'string',
                            description: 'The source URL the position belongs to, e.g. /sap/bc/adt/oo/classes/cl_salv_table/source/main.'
                        },
                        body: {
                            type: 'string',
                            description: 'The source text the position is counted in.'
                        },
                        line: {
                            type: 'number',
                            description: 'Line of the cursor, counted from 1.'
                        },
                        column: {
                            type: 'number',
                            description: 'Column of the cursor, counted from 0.'
                        },
                        language: {
                            type: 'string',
                            description: 'Documentation language, e.g. EN. Defaults to the logon language.'
                        },
                        html: {
                            type: 'boolean',
                            description: 'Return the HTML page as well as the text. Off by default.'
                        }
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
    /**
     * A CDS URL that names nothing answers with an empty message list, which is
     * the same answer a clean view gets. The object is confirmed first, so a
     * misspelled name is never reported as a passed check.
     */
    async handleSyntaxCheckCdsUrl(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            let exists = true;
            let objectName: string | undefined;
            try {
                const structure: any = await this.readClient.objectStructure(args.cdsUrl);
                objectName = structure?.['adtcore:name'];
                exists = !!structure;
            } catch {
                exists = false;
            }
            if (!exists) {
                this.trackRequest(startTime, true);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found: false,
                            cdsUrl: args.cdsUrl,
                            reason: 'No object answers at this URL, and the check endpoint reports an empty message list for it - which is not the same as a clean syntax check.',
                            hint: 'CDS sources live at /sap/bc/adt/ddic/ddl/sources/<name>; searchObject finds the address.'
                        })
                    }]
                };
            }
            const result = await this.readClient.syntaxCheck(args.cdsUrl);
            this.trackRequest(startTime, true);
            const messages = Array.isArray(result) ? result : [];
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found: true,
                            cdsUrl: args.cdsUrl,
                            objectName,
                            clean: messages.length === 0,
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
        let readSource = false;
        let mainUrl = args?.mainUrl;
        let mainUrlResolved: string | undefined;
        let codeIgnored = false;

        // An include is not checked on its own. The backend compiles whatever
        // content it is given as the main program, so an include's own text
        // comes back as "REPORT/PROGRAM statement missing" - a syntax error
        // about the wrong thing, and one the caller cannot act on. What it
        // wants is the main program: the include is compiled as part of it,
        // from what is stored, which is why a write has to come first.
        const isInclude = /\/programs\/includes\//.test(String(args.url));
        let checkedAgainst: string | undefined;
        if (isInclude) {
            if (!mainUrl) {
                mainUrl = await this.mainProgramOf(String(args.url));
                mainUrlResolved = mainUrl;
            }
            if (mainUrl) {
                checkedAgainst = mainUrl;
                codeIgnored = !!code && code !== sourceCache.get(mainUrl);
                code = await this.sourceOf(mainUrl);
                readSource = true;
                usedCachedSource = false;
            }
        }

        if (code === undefined || code === null || code === '') {
            const cached = sourceCache.get(args.url);
            if (cached !== undefined) {
                code = cached;
                usedCachedSource = true;
            } else {
                // Reading it here is the call the caller would have to make
                // anyway: this endpoint cannot check anything without the
                // whole text.
                try {
                    code = await this.sourceOf(args.url);
                    readSource = true;
                } catch (error: any) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `No source was provided, none is cached for '${args.url}', and reading it failed: ${error?.message}. Pass "code", or a URL that serves a source.`
                    );
                }
            }
        }

        // Everything that is not an include is its own main URL, and the call
        // fails outright without one ("mainUrl and content are required") -
        // which made a check on a class need two parameters that could only
        // ever hold the same value.
        if (!mainUrl) mainUrl = args.url;

        const startTime = performance.now();
        try {
            const result = await this.readClient.syntaxCheck(args.url, mainUrl, code, args?.mainProgram, args?.version);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            usedCachedSource,
                            ...(readSource ? { readSource } : {}),
                            ...(mainUrlResolved ? { mainUrlResolved } : {}),
                            ...(checkedAgainst
                                ? {
                                    checkedAgainst,
                                    ...(codeIgnored ? { codeIgnored: true } : {}),
                                    includeNote: `An include is compiled as part of ${checkedAgainst}, and the check is over that program as it is stored${codeIgnored ? ' - the code passed here was not used, because this backend reads content as the main program and an include\'s own text comes back as "REPORT/PROGRAM statement missing"' : ''}. Write the include first; a change that is not saved cannot be checked this way.`
                                }
                                : {}),
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
        const source = await this.positionSource(args.sourceUrl, args.source);
        const cursor = this.checkCursor(source.text, args.line, args.column);
        try {
            const result = await this.readClient.codeCompletion(
                args.sourceUrl,
                source.text,
                args.line,
                args.column
            );
            this.trackRequest(startTime, true);
            const proposals = Array.isArray(result) ? result : [];
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            proposals: proposals.length,
                            at: cursor.token,
                            line: cursor.lineText,
                            sourceFrom: source.from,
                            result,
                            hint: proposals.length === 0
                                ? 'No proposals here. The backend answers an empty list both when nothing may be written at this position and when the source it was sent does not parse as far as the cursor.'
                                : 'IDENTIFIER of a proposal is the patternKey codeCompletionFull takes.'
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Code completion failed');
        }
    }

    /**
     * The position, checked against the source that was passed with it.
     *
     * A position outside the source is always the caller's mistake, and the
     * backend answers it with a wrong object, an empty list or a 500 rather
     * than with a complaint. A position that is merely not on a name is a
     * mistake only where a name is what the call is about: completion is
     * asked at blank positions by definition.
     */
    /**
     * The source a position is counted against.
     *
     * These calls send the source with the position, and the backend resolves
     * the position inside the text it is given - so a page of a source is not
     * a smaller version of it but a different, broken one. Measured live: the
     * first 400 lines of CL_SALV_TABLE, which is how a caller would naturally
     * read a large class, answered "The source code of this class is
     * incomplete". Omitting it now reads the whole thing, from the cache when
     * this session already has it, which is what a caller wants unless it is
     * asking about an edit it has not written yet.
     */
    private async positionSource(url: any, given: any): Promise<{ text: string; from: 'argument' | 'server' }> {
        if (typeof given === 'string' && given.length > 0) return { text: given, from: 'argument' };
        if (typeof url !== 'string' || url.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'Pass the source URL, or the source itself.');
        }
        return { text: await this.sourceOf(url), from: 'server' };
    }

    private checkCursor(source: any, line: any, column: any, needsName = false): CursorAt {
        const cursor = cursorAt(source, line, column);
        if (cursor.problem && (cursor.outside || needsName)) {
            throw new McpError(ErrorCode.InvalidParams, cursor.problem);
        }
        return cursor;
    }

    async handleFindDefinition(args: any): Promise<any> {
        const startTime = performance.now();
        const source = await this.positionSource(args.url, args.source);
        const cursor = this.checkCursor(source.text, args.line, args.startCol, true);
        try {
            const result = await this.readClient.findDefinition(
                args.url,
                source.text,
                args.line,
                args.startCol,
                args.endCol,
                args.implementation,
                args.mainProgram
            );
            this.trackRequest(startTime, true);
            // An empty URL is how the backend says it found nothing, and it
            // says it with status 200 - which reads as an answer rather than
            // as the absence of one.
            const found = !!(result && result.url);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            found,
                            at: cursor.token,
                            line: cursor.lineText,
                            sourceFrom: source.from,
                            result: found ? result : undefined,
                            hint: found
                                ? undefined
                                : `No definition for "${cursor.token}" at line ${args.line}, column ${args.startCol}. The backend answers this for a name it cannot navigate to - a keyword, a literal, or a symbol from a source it does not compile the way it was sent. Check the position is the one you meant: lines count from 1 and columns from 0, and a line out by one answers about a different object without saying so.`
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
            const rows = await this.readClient.usageReferences(
                args.url,
                args.line,
                args.column
            );
            const page = pageUsages(rows, {
                offset: args.offset,
                maxResults: args.maxResults,
                onlyWithSnippets: args.onlyWithSnippets
            });
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ...page,
                            hint: page.more
                                ? `More rows follow: ask again with offset=${page.offset + page.returned}.`
                                : undefined,
                            snippetsHint: page.summary.usageSites > 0 && !args.onlyWithSnippets
                                ? `${page.summary.usageSites} of the ${page.summary.total} rows are usage sites with source behind them; onlyWithSnippets keeps just those.`
                                : undefined
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

    /**
     * The main program an include belongs to, as a source URL.
     *
     * An include compiles only inside a program, so a syntax check on one
     * without a main URL is answered with 400 - and the include's own URL
     * says nothing about which program that is. Answers undefined rather than
     * throwing: a check that then fails says so itself, which is better than
     * losing a lookup that was only meant to help.
     */
    protected async mainProgramOf(sourceUrl: string): Promise<string | undefined> {
        const startTime = performance.now();
        try {
            const includeUrl = sourceUrl.split('#')[0].replace(/\/source\/main.*$/, '');
            const mains: any[] = await this.readClient.mainPrograms(includeUrl);
            this.trackRequest(startTime, true);
            const uri = mains?.[0]?.['adtcore:uri'] || mains?.[0]?.uri;
            if (!uri) return undefined;
            return /\/source\/main/.test(uri) ? uri : `${uri}/source/main`;
        } catch {
            this.trackRequest(startTime, false);
            return undefined;
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

    /**
     * The library answers with a Map, and JSON.stringify writes a Map as {} -
     * so this tool reported an empty result on every system it ever ran on.
     */
    async handleSyntaxCheckTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const checkTypes = await this.readClient.syntaxCheckTypes();
            const result: Record<string, string[]> = {};
            if (checkTypes instanceof Map) {
                for (const [key, value] of checkTypes.entries()) {
                    result[String(key)] = Array.isArray(value) ? value.map(String) : [];
                }
            } else if (checkTypes && typeof checkTypes === 'object') {
                Object.assign(result, checkTypes);
            }
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            checkTypes: Object.keys(result).length,
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
        if (typeof args.patternKey !== 'string' || args.patternKey.trim().length === 0) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Pass patternKey - the IDENTIFIER of the proposal from codeCompletion whose insert text you want.'
            );
        }
        const source = await this.positionSource(args.sourceUrl, args.source);
        this.checkCursor(source.text, args.line, args.column);
        try {
            const result = await this.readClient.codeCompletionFull(args.sourceUrl, source.text, args.line, args.column, args.patternKey);
            this.trackRequest(startTime, true);
            const text = typeof result === 'string' ? result : '';
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            sourceFrom: source.from,
                            result,
                            hint: text.length === 0
                                ? `The backend answered with no insert text for "${args.patternKey}". It does that for a proposal that inserts nothing on its own - check the IDENTIFIER came from codeCompletion at this very position.`
                                : undefined
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
        const source = await this.positionSource(args.sourceUrl, args.source);
        this.checkCursor(source.text, args.line, args.column);
        try {
            const result = await this.readClient.codeCompletionElement(args.sourceUrl, source.text, args.line, args.column);
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
            const passed = this.parseObjectArg(args.references, 'references');
            const usable = snippetableReferences(passed);
            if (usable.length === 0) {
                const given = Array.isArray(passed) ? passed.length : 0;
                throw new McpError(
                    ErrorCode.InvalidParams,
                    given === 0
                        ? 'Pass the rows usageReferences answered with - references is empty.'
                        : `None of the ${given} rows carries an objectIdentifier, and the request is built out of that alone - these are the grouping rows of the tree, not usage sites. Ask usageReferences again with onlyWithSnippets: true.`
                );
            }
            const result = await this.readClient.usageReferenceSnippets(usable);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            asked: usable.length,
                            ignored: (Array.isArray(passed) ? passed.length : 0) - usable.length,
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
            const proposals = fixProposalRows(result);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            url: args.url,
                            line: args.line,
                            column: args.column,
                            found: proposals.length,
                            proposals,
                            hint: proposals.length
                                ? 'Hand one of these rows back to fixEdits, unchanged, to see the edits it would make.'
                                : 'No quick fix is offered at this position.'
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
        const proposal = this.parseObjectArg(args.proposal, 'proposal');
        requireShape(proposal, {
            parameter: 'proposal',
            fields: FIX_PROPOSAL_FIELDS,
            producedBy: 'fixProposals'
        });
        try {
            const result = await this.readClient.fixEdits(proposal as any, args.source);
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

    /**
     * The backend answers with a whole HTML page - doctype, head, icon links
     * and all - of which the documentation is a small part. It is handed over
     * as text unless the page itself was asked for.
     */
    async handleAbapDocumentation(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.readClient.abapDocumentation(args.objectUri, args.body, args.line, args.column, args.language);
            this.trackRequest(startTime, true);
            const doc = documentText(String(result ?? ''), !!args?.html);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            objectUri: args.objectUri,
                            line: args.line,
                            column: args.column,
                            found: doc.chars > 0,
                            ...doc
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
