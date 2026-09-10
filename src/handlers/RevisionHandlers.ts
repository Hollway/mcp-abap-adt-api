import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { classIncludes } from 'abap-adt-api';
import { objectUrlFor, sourceUrlFor } from '../lib/packageWalk';
import { unifiedDiff } from '../lib/textDiff';

/**
 * Versions of an object, and what changed between two of them.
 *
 * What the backend calls a revision's "version" is the transport request that
 * carried it - not a number - and the number is only in the content URI:
 * .../includes/main/versions/<timestamp>/00087/content. Both are worth having:
 * the transport is how a change is talked about ("what did DEVK9A3MT7 do to
 * this class"), the number is how the versions are ordered.
 *
 * A long-lived class answers with every version it ever had - ZCL_APP answers
 * with 90, most of them "Копия <request>" rows left by transport copies - so
 * the list is filterable and capped. Handing all of it over costs about 28,000
 * characters to answer a question about the last two changes.
 */

const CLASS_INCLUDES: readonly string[] = [
  'definitions', 'implementations', 'macros', 'testclasses', 'main'
];

interface RevisionRow {
  revision: string;
  transport: string;
  title: string;
  date: string;
  author: string;
  uri: string;
}

type ComparisonSide =
  | { kind: 'revision'; row: RevisionRow }
  | { kind: 'version'; version: string };

/** The five-digit number ADT puts in a revision's content URI. */
export const revisionNumberOf = (uri: string): string => {
  const match = /\/versions\/[^/]+\/([^/]+)\/content$/.exec(String(uri || ''));
  return match ? match[1] : '';
};

export class RevisionHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'revisions',
                description: 'The version history of an object: who changed it when, and under which transport request. Takes a name (with objectType), or objectUrl for a type it cannot address. Mind what the backend means by "version": that field is the transport request that carried the change, while the version NUMBER is the "revision" field - and that is what compareRevisions takes. A long-lived object has a long history (ZCL_APP answers with 90 versions, most of them copies left by transport releases), so the newest 20 come back unless limit says otherwise, and author/transport/titleContains narrow it down.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'Object name, e.g. ZCL_APP. Use with objectType.'
                        },
                        objectType: {
                            type: 'string',
                            description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, DDLS/DF, TABL/DS. Defaults to CLAS/OC.'
                        },
                        objectUrl: {
                            type: 'string',
                            description: 'ADT object URL, e.g. /sap/bc/adt/oo/classes/zcl_app. Only needed for a type objectName cannot address.'
                        },
                        clsInclude: {
                            type: 'string',
                            description: 'For a class, which include to take the history of: definitions, implementations, macros, testclasses or main (the default).'
                        },
                        limit: {
                            type: 'number',
                            description: 'How many of the newest versions to return. Default 20; 0 means all of them.'
                        },
                        author: {
                            type: 'string',
                            description: 'Keep only versions written by this user.'
                        },
                        transport: {
                            type: 'string',
                            description: 'Keep only the version(s) carried by this transport request.'
                        },
                        titleContains: {
                            type: 'string',
                            description: 'Keep only versions whose description contains this text, case-insensitive.'
                        }
                    },
                    required: []
                }
            },
            {
                name: 'compareRevisions',
                description: 'What changed between two versions of one object, as a unified diff. Name each side by a revision number from revisions, by a transport request, or by "active" (what the system executes), "inactive" (the working version) or "latest" (newest in the history). With neither side given it compares the two newest versions, which answers "what did the last change do"; "active" against "inactive" shows an edit that is written but not activated. The diff anchors on lines that occur once on each side, so an inserted method reads as an insertion instead of two rewritten methods.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'Object name, e.g. ZCL_APP. Use with objectType.'
                        },
                        objectType: {
                            type: 'string',
                            description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, DDLS/DF, TABL/DS. Defaults to CLAS/OC.'
                        },
                        objectUrl: {
                            type: 'string',
                            description: 'ADT object URL, e.g. /sap/bc/adt/oo/classes/zcl_app. Only needed for a type objectName cannot address.'
                        },
                        clsInclude: {
                            type: 'string',
                            description: 'For a class, which include to compare: definitions, implementations, macros, testclasses or main (the default).'
                        },
                        from: {
                            type: 'string',
                            description: 'The older side: a revision number ("00087"), a transport request, "active", "inactive" or "latest". Defaults to the second newest version.'
                        },
                        to: {
                            type: 'string',
                            description: 'The newer side, same forms. Defaults to the newest version.'
                        },
                        context: {
                            type: 'number',
                            description: 'Lines of context around each change. Default 3.'
                        },
                        maxDiffChars: {
                            type: 'number',
                            description: 'Cut the diff off after this many characters, keeping the summary. Default 40000.'
                        }
                    },
                    required: []
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'revisions':
                return this.handleRevisions(args);
            case 'compareRevisions':
                return this.handleCompareRevisions(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown revision tool: ${toolName}`);
        }
    }

    /** Object URL from a friendly name, or the one that was passed. */
    private resolveObject(args: any): { objectUrl: string; label: string; objectType: string } {
        const name = String(args?.objectName || '').trim();
        const objectType = String(args?.objectType || 'CLAS/OC').trim().toUpperCase();
        if (name) {
            const url = objectUrlFor(objectType, name);
            if (!url) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `No ADT URL is known for a ${objectType}. Pass objectUrl instead.`
                );
            }
            return { objectUrl: url, label: `${name.toUpperCase()} (${objectType})`, objectType };
        }
        const objectUrl = String(args?.objectUrl || '').trim();
        if (!objectUrl) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Which object? Pass objectName (with objectType) or objectUrl.'
            );
        }
        return { objectUrl, label: objectUrl, objectType };
    }

    private classInclude(args: any): classIncludes | undefined {
        const include = String(args?.clsInclude || '').trim().toLowerCase();
        if (!include) return undefined;
        if (!CLASS_INCLUDES.includes(include)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `clsInclude must be one of ${CLASS_INCLUDES.join(', ')}; got "${args.clsInclude}".`
            );
        }
        return include as classIncludes;
    }

    /**
     * Where the live text of this object (or class include) is served. The
     * "active" and "inactive" sides are not revisions and have no version URI.
     */
    private sourceUrlOf(args: any, objectUrl: string, objectType: string, include?: string): string {
        if (include && include !== 'main') return `${objectUrl}/includes/${include}/source/main`;
        const name = String(args?.objectName || '').trim();
        if (name) {
            const url = sourceUrlFor(objectType, name);
            if (url) return url;
        }
        return `${objectUrl}/source/main`;
    }

    /**
     * Which includes of a class actually carry a version history, for when the
     * one that was asked for does not. The library's answer to that is
     * "Revision URL not found for object X", which sounds like the object has
     * no history at all - and ZCL_APP, which has 91 versions of its main
     * include, answers exactly that for testclasses.
     */
    private async includesWithHistory(objectUrl: string): Promise<string[]> {
        try {
            const structure: any = await this.readClient.objectStructure(objectUrl);
            const includes = Array.isArray(structure?.includes) ? structure.includes : [];
            return includes
                .filter((include: any) => (include?.links || []).some(
                    (link: any) => link?.rel === 'http://www.sap.com/adt/relations/versions'
                ))
                .map((include: any) => String(include['class:includeType'] || ''))
                .filter(Boolean);
        } catch {
            // The hint is a nicety; failing to build it must not replace the
            // original error with one about reading the structure.
            return [];
        }
    }

    private async readRevisions(args: any): Promise<{
        objectUrl: string;
        label: string;
        objectType: string;
        include?: classIncludes;
        rows: RevisionRow[];
    }> {
        const { objectUrl, label, objectType } = this.resolveObject(args);
        const include = this.classInclude(args);
        let raw;
        try {
            raw = await this.readClient.revisions(objectUrl, include);
        } catch (error: any) {
            if (!/Revision URL not found/i.test(String(error?.message || ''))) throw error;
            const available = await this.includesWithHistory(objectUrl);
            throw new McpError(
                ErrorCode.InvalidParams,
                include
                  ? `The ${include} include of ${label} has no version history.${available.length ? ` These do: ${available.join(', ')}.` : ''}`
                  : `${label} has no version history: the backend serves no versions link for it.`
            );
        }
        const rows: RevisionRow[] = raw.map(revision => ({
            revision: revisionNumberOf(revision.uri),
            transport: revision.version || '',
            title: revision.versionTitle || '',
            date: revision.date || '',
            author: revision.author || '',
            uri: revision.uri
        }));
        return { objectUrl, label, objectType, include, rows };
    }

    async handleRevisions(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const { label, include, rows } = await this.readRevisions(args);
            const author = String(args?.author || '').trim().toUpperCase();
            const transport = String(args?.transport || '').trim().toUpperCase();
            const titleContains = String(args?.titleContains || '').trim().toLowerCase();

            let filtered = rows;
            if (author) filtered = filtered.filter(row => row.author.toUpperCase() === author);
            if (transport) filtered = filtered.filter(row => row.transport.toUpperCase() === transport);
            if (titleContains) {
                filtered = filtered.filter(row => row.title.toLowerCase().includes(titleContains));
            }

            const limit = Number(args?.limit) === 0 ? 0 : Math.max(1, Number(args?.limit) || 20);
            const returned = limit > 0 ? filtered.slice(0, limit) : filtered;

            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            object: label,
                            ...(include ? { clsInclude: include } : {}),
                            total: rows.length,
                            ...(filtered.length !== rows.length ? { matched: filtered.length } : {}),
                            returned: returned.length,
                            ...(returned.length < filtered.length
                                ? {
                                    note: `The newest ${returned.length} of ${filtered.length}. Raise limit, or narrow with author/transport/titleContains.`
                                }
                                : {}),
                            revisions: returned
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get revisions');
        }
    }

    /**
     * Turn "00087", a transport request, "active", "inactive" or "latest" into
     * something readable, and keep what it turned out to be: a diff whose sides
     * are not named is evidence of nothing.
     */
    private pickSide(rows: RevisionRow[], wanted: unknown, fallbackIndex: number): ComparisonSide {
        const text = String(wanted ?? '').trim();
        if (!text) {
            const row = rows[fallbackIndex];
            if (!row) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `This object has ${rows.length} version(s) in its history, too few to compare by default. Name the sides, e.g. from="active", to="inactive".`
                );
            }
            return { kind: 'revision', row };
        }
        const lower = text.toLowerCase();
        if (lower === 'active' || lower === 'inactive') return { kind: 'version', version: lower };
        if (lower === 'latest') {
            if (!rows[0]) throw new McpError(ErrorCode.InvalidParams, 'This object has no version history.');
            return { kind: 'revision', row: rows[0] };
        }
        const byNumber = rows.find(row => row.revision === text || row.revision === text.padStart(5, '0'));
        if (byNumber) return { kind: 'revision', row: byNumber };
        const byTransport = rows.find(row => row.transport.toUpperCase() === text.toUpperCase());
        if (byTransport) return { kind: 'revision', row: byTransport };
        throw new McpError(
            ErrorCode.InvalidParams,
            `"${text}" is neither a revision number nor a transport in this object's history, nor "active", "inactive" or "latest". Call revisions to see what there is.`
        );
    }

    private describeSide(side: ComparisonSide): Record<string, string> {
        return side.kind === 'revision'
            ? {
                kind: 'revision',
                revision: side.row.revision,
                transport: side.row.transport,
                title: side.row.title,
                date: side.row.date,
                author: side.row.author
            }
            : { kind: 'version', version: side.version };
    }

    private labelSide(side: ComparisonSide): string {
        return side.kind === 'revision'
            ? `revision ${side.row.revision} (${side.row.transport || 'no request'})`
            : `${side.version} version`;
    }

    async handleCompareRevisions(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const { label, objectUrl, objectType, include, rows } = await this.readRevisions(args);
            const sourceUrl = this.sourceUrlOf(args, objectUrl, objectType, include);

            // The history comes newest first, so the default comparison -
            // rows[1] against rows[0] - answers "what did the last change do".
            const to = this.pickSide(rows, args?.to, 0);
            const from = this.pickSide(rows, args?.from, 1);

            const read = async (side: ComparisonSide): Promise<string> =>
                side.kind === 'revision'
                    ? await this.readClient.getObjectSource(side.row.uri)
                    : await this.readClient.getObjectSource(sourceUrl, { version: side.version as any });

            const [beforeText, afterText] = await Promise.all([read(from), read(to)]);

            const { diff, stats } = unifiedDiff(beforeText, afterText, {
                context: args?.context === undefined ? 3 : Math.max(0, Number(args.context) || 0),
                beforeLabel: this.labelSide(from),
                afterLabel: this.labelSide(to)
            });

            const maxDiffChars = Math.max(1000, Number(args?.maxDiffChars) || 40000);
            const truncated = diff.length > maxDiffChars;

            // Releasing a transport leaves a copy version with the same text,
            // so on a busy object the two newest versions are often identical
            // and the default comparison shows nothing. Say why, rather than
            // letting it read as "the last change did nothing".
            const defaulted = !String(args?.from ?? '').trim() && !String(args?.to ?? '').trim();
            const copyNote = defaulted && stats.identical && rows.length > 2
                ? 'The two newest versions have the same text - a transport release leaves a copy version behind. Name an older side, or call revisions to see which requests really changed the object.'
                : undefined;

            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            object: label,
                            ...(include ? { clsInclude: include } : {}),
                            from: this.describeSide(from),
                            to: this.describeSide(to),
                            summary: {
                                identical: stats.identical,
                                linesAdded: stats.added,
                                linesRemoved: stats.removed,
                                hunks: stats.hunks,
                                ...(stats.coarse ? { coarse: true } : {})
                            },
                            ...(copyNote ? { note: copyNote } : {}),
                            ...(truncated
                                ? {
                                    diffTruncated: true,
                                    diffNote: `The diff is ${diff.length} characters; this is the first ${maxDiffChars}. Raise maxDiffChars, or lower context.`
                                }
                                : {}),
                            diff: truncated ? diff.slice(0, maxDiffChars) : diff
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to compare revisions');
        }
    }
}
