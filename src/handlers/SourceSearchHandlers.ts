import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import type { ObjectSourceOptions, ObjectVersion } from "abap-adt-api";
import {
  findInSource,
  outlineSource,
  includedPrograms,
  includeSourceUrl,
  ScanError
} from '../lib/sourceScan';
import type { OutlineEntry, SourceMatch } from '../lib/sourceScan';

const VERSIONS: ObjectVersion[] = ['active', 'inactive', 'workingArea'];

interface SearchedSource {
  name: string;
  sourceUrl: string;
  source: string;
}

/**
 * Search and outline over object source.
 *
 * These do not exist in ADT: fragmentMappings locates a class method and
 * nothing else, so finding a FORM in a report meant paging the whole source
 * through the caller - several reads of a few hundred lines each, and the
 * context to hold them. Reading and scanning on this side costs one read and
 * returns line numbers.
 */
export class SourceSearchHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'findInSource',
        description: 'Find text or a regular expression in the source of an ABAP object and get the matching line numbers with context - without pulling the source through the caller. This is how to locate a FORM, a MODULE or any statement in a report: there is no ADT fragment type for those, and asking fragmentMappings for one is answered with 400. For a report, searchIncludes follows its INCLUDE statements too.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: {
              type: 'string',
              description: 'Source URL, e.g. /sap/bc/adt/programs/programs/zr_app_foo/source/main'
            },
            pattern: {
              type: 'string',
              description: 'What to look for. Plain text by default; set regex to treat it as a JavaScript regular expression.'
            },
            regex: {
              type: 'boolean',
              description: 'Treat pattern as a regular expression (default false).'
            },
            ignoreCase: {
              type: 'boolean',
              description: 'Case-insensitive search (default true - ABAP source mixes cases freely).'
            },
            contextLines: {
              type: 'number',
              description: 'Lines of context to return around each match (default 0).'
            },
            maxMatches: {
              type: 'number',
              description: 'Stop collecting after this many matches (default 200). The total count is reported either way.'
            },
            skipComments: {
              type: 'boolean',
              description: 'Ignore commented-out code: * in the first column, and anything after a " (default false).'
            },
            searchIncludes: {
              type: 'boolean',
              description: 'Also search the includes the program pulls in with INCLUDE (default false). One extra read per include.'
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active", "inactive" or "workingArea". Omit for the ADT default, which is the inactive one.'
            }
          },
          required: ['objectSourceUrl', 'pattern']
        }
      },
      {
        name: 'sourceOutline',
        description: 'Table of contents of an ABAP source: every REPORT, CLASS, METHOD, FORM, MODULE, FUNCTION, INCLUDE and event block with the line it starts on. Read this before paging through a long report or class - it turns "where is that subroutine" into one call. Text scanning, so it works on programs, includes and function groups alike.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: {
              type: 'string',
              description: 'Source URL, e.g. /sap/bc/adt/programs/programs/zr_app_foo/source/main'
            },
            kinds: {
              type: 'array',
              description: 'Only these kinds, e.g. ["FORM","METHOD"]. Omit for all of them.',
              items: { type: 'string' }
            },
            searchIncludes: {
              type: 'boolean',
              description: 'Also outline the includes the program pulls in (default false).'
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active", "inactive" or "workingArea".'
            }
          },
          required: ['objectSourceUrl']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'findInSource':
        return this.handleFindInSource(args);
      case 'sourceOutline':
        return this.handleSourceOutline(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown source search tool: ${toolName}`);
    }
  }

  private versionOption(args: any): ObjectSourceOptions {
    const version = args?.version;
    if (typeof version !== 'string' || version.length === 0) return {};
    if (!VERSIONS.includes(version as ObjectVersion)) {
      throw new McpError(ErrorCode.InvalidParams, `version must be one of ${VERSIONS.join(', ')}`);
    }
    return { version: version as ObjectVersion };
  }

  /** Name to show for a source URL: the object it belongs to. */
  private nameOf(sourceUrl: string): string {
    const withoutSource = sourceUrl.split('#')[0].replace(/\/source\/main$/, '');
    return decodeURIComponent(withoutSource.split('/').filter(Boolean).pop() || sourceUrl).toUpperCase();
  }

  /**
   * The sources to scan: the object itself, plus its includes when asked.
   *
   * An include that cannot be read is reported rather than thrown: a program
   * may well name an include that lives in another system or is generated, and
   * losing the whole search over one of them would be the wrong trade.
   */
  private async collectSources(
    args: any
  ): Promise<{ sources: SearchedSource[]; unreadable: { name: string; error: string }[] }> {
    const options = this.versionOption(args);
    const main = await this.readClient.getObjectSource(args.objectSourceUrl, options);
    const sources: SearchedSource[] = [{
      name: this.nameOf(args.objectSourceUrl),
      sourceUrl: args.objectSourceUrl,
      source: main
    }];
    const unreadable: { name: string; error: string }[] = [];

    if (args?.searchIncludes === true) {
      for (const name of includedPrograms(main)) {
        const sourceUrl = includeSourceUrl(name);
        try {
          sources.push({ name, sourceUrl, source: await this.readClient.getObjectSource(sourceUrl, options) });
        } catch (error: any) {
          unreadable.push({ name, error: error?.message || `${error}` });
        }
      }
    }
    return { sources, unreadable };
  }

  async handleFindInSource(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const { sources, unreadable } = await this.collectSources(args);
      const maxMatches = args?.maxMatches !== undefined ? Number(args.maxMatches) : 200;

      let remaining = maxMatches;
      let totalMatches = 0;
      const perSource: { name: string; sourceUrl: string; totalLines: number; matches: SourceMatch[] }[] = [];

      for (const source of sources) {
        const found = findInSource(source.source, {
          pattern: args.pattern,
          regex: args.regex === true,
          ignoreCase: args.ignoreCase !== false,
          contextLines: Number(args.contextLines) || 0,
          maxMatches: Math.max(0, remaining),
          skipComments: args.skipComments === true
        });
        totalMatches += found.totalMatches;
        remaining -= found.matches.length;
        if (found.matches.length > 0 || sources.length === 1) {
          perSource.push({
            name: source.name,
            sourceUrl: source.sourceUrl,
            totalLines: found.totalLines,
            matches: found.matches
          });
        }
      }

      const returned = perSource.reduce((sum, s) => sum + s.matches.length, 0);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        pattern: args.pattern,
        searched: sources.map(s => s.name),
        totalMatches,
        returnedMatches: returned,
        truncated: totalMatches > returned,
        results: perSource,
        unreadableIncludes: unreadable.length ? unreadable : undefined,
        hint: totalMatches === 0
          ? 'No match. ADT serves the inactive version by default - pass version="active" to search what actually runs, and searchIncludes for a report split across includes.'
          : undefined
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof ScanError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw wrapAdtError(error, 'Failed to search the source');
    }
  }

  async handleSourceOutline(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const { sources, unreadable } = await this.collectSources(args);
      const kinds = args?.kinds
        ? this.parseObjectArg<string[]>(args.kinds, 'kinds').map(k => String(k).toUpperCase())
        : undefined;

      const results = sources.map(source => {
        const entries: OutlineEntry[] = outlineSource(source.source)
          .filter(e => !kinds || kinds.includes(e.kind));
        return {
          name: source.name,
          sourceUrl: source.sourceUrl,
          totalLines: source.source.split(/\r?\n/).length,
          entries
        };
      });

      const count = results.reduce((sum, r) => sum + r.entries.length, 0);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        entries: count,
        results,
        unreadableIncludes: unreadable.length ? unreadable : undefined,
        hint: count === 0
          ? 'Nothing recognised. The source may be an include holding only data declarations, or the kinds filter excluded everything.'
          : 'Line numbers refer to the version read; use them with getObjectSource startLine/maxLines or patchObjectSource.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to outline the source');
    }
  }

  private answer(payload: Record<string, unknown>) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload)
      }]
    };
  }
}
