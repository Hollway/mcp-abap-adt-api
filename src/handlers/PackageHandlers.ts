import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { findInSource, ScanError } from '../lib/sourceScan';
import {
  walkPackage,
  countByType,
  sourceUrlFor,
  READABLE_TYPES,
  type PackageNode,
  type WalkedObject
} from '../lib/packageWalk';

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_OBJECTS = 500;
const DEFAULT_SEARCH_OBJECTS = 200;
const DEFAULT_TOTAL_CHARS = 80000;

/**
 * Working on a package rather than on one object at a time.
 *
 * Understanding an unfamiliar development used to start with a fan of single
 * calls: nodeContents for one level, a guess at which objects matter,
 * getObjectSource per object, findInSource per object. Every one of those
 * steps is cheap and the sequence is long, which is why the first question
 * about a package - what is in it, and where is this string used - was the
 * most expensive one to answer.
 */
export class PackageHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'packageTree',
        description: 'List what is in a package, following its sub-packages: every object with its type, the package it sits in and the URL that serves its source where there is one. nodeContents answers one level and gives most objects a SAPGUI bridge URI that serves no content; this resolves the source locations and walks the tree breadth-first, so a limit leaves a complete picture of the upper levels and names the packages it did not open.',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'Package to walk, e.g. ZAPP_BASE.'
            },
            maxDepth: {
              type: 'number',
              description: `How deep to go: 1 is the package alone, 2 adds its sub-packages. Default ${DEFAULT_DEPTH}.`
            },
            maxObjects: {
              type: 'number',
              description: `Cap on the objects returned, default ${DEFAULT_MAX_OBJECTS}. A single real package can hold 900.`
            },
            objectTypes: {
              type: 'array',
              description: 'Only these ADT types, e.g. ["CLAS/OC","PROG/P"].',
              items: { type: 'string' }
            },
            readableOnly: {
              type: 'boolean',
              description: `Keep only objects whose text ADT serves (${READABLE_TYPES.join(', ')}).`
            }
          },
          required: ['packageName']
        }
      },
      {
        name: 'readSources',
        description: 'Read the source of several objects in one call, by name and type or by source URL. Each object is reported on its own, so one unreadable object does not lose the rest, and the answer stops adding sources once the character budget is used up - it says which objects it did not reach.',
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'Objects to read: [{name, objectType}], e.g. [{"name":"ZCL_APP","objectType":"CLAS/OC"}].',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  objectType: { type: 'string', description: 'ADT type, e.g. CLAS/OC or PROG/P.' }
                },
                required: ['name', 'objectType']
              }
            },
            sourceUrls: {
              type: 'array',
              description: 'Source URLs to read instead, e.g. ["/sap/bc/adt/programs/programs/zr_app_foo/source/main"].',
              items: { type: 'string' }
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active" for what the system runs, "inactive" for the working copy (the ADT default).'
            },
            maxLinesPerObject: {
              type: 'number',
              description: 'Keep only the first N lines of each source.'
            },
            maxTotalChars: {
              type: 'number',
              description: `Character budget for the whole answer, default ${DEFAULT_TOTAL_CHARS}.`
            }
          }
        }
      },
      {
        name: 'searchInPackage',
        description: 'Search the sources of a whole package for text or a regular expression, following its sub-packages: one call instead of a package listing plus a read and a search per object. Answers with the matching objects, the line numbers and the lines, and says how far it got - this reads every source it walks, so narrow it with objectTypes and maxObjects on a large package.',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'Package to search, e.g. ZAPP_BASE.'
            },
            pattern: {
              type: 'string',
              description: 'Text to find, or a regular expression when regex is true.'
            },
            regex: {
              type: 'boolean',
              description: 'Treat pattern as a JavaScript regular expression.'
            },
            ignoreCase: {
              type: 'boolean',
              description: 'Case-insensitive, which is the default - ABAP is not case-sensitive.'
            },
            contextLines: {
              type: 'number',
              description: 'Lines of context to include around each match.'
            },
            skipComments: {
              type: 'boolean',
              description: 'Skip commented-out lines, which a search for live code usually wants.'
            },
            objectTypes: {
              type: 'array',
              description: 'Only these ADT types.',
              items: { type: 'string' }
            },
            maxDepth: {
              type: 'number',
              description: `How deep to follow sub-packages, default ${DEFAULT_DEPTH}.`
            },
            maxObjects: {
              type: 'number',
              description: `Cap on the objects read, default ${DEFAULT_SEARCH_OBJECTS}.`
            },
            maxMatchesPerObject: {
              type: 'number',
              description: 'Cap on the matches reported per object, default 20.'
            }
          },
          required: ['packageName', 'pattern']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'packageTree':
        return this.handlePackageTree(args);
      case 'readSources':
        return this.handleReadSources(args);
      case 'searchInPackage':
        return this.handleSearchInPackage(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown package tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private packageName(args: any): string {
    const name = String(args?.packageName || '').trim().toUpperCase();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Which package? Pass packageName.');
    }
    return name;
  }

  /** One level of a package, as nodes. */
  private async nodesOf(packageName: string): Promise<PackageNode[]> {
    const startTime = performance.now();
    try {
      const structure = await this.readClient.nodeContents('DEVC/K', packageName);
      this.trackRequest(startTime, true);
      return (structure?.nodes || []) as PackageNode[];
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, `Failed to list package ${packageName}`);
    }
  }

  /**
   * A package that does not exist answers with an empty node list, exactly
   * like an empty one, so the two have to be told apart another way.
   *
   * Not by its object properties: /sap/bc/adt/vit/wb/object_type/devck/
   * object_name/ANYTHING answers 200 and echoes the name back, invented or
   * not. The repository search is the one that knows.
   */
  private async packageExists(packageName: string): Promise<boolean | undefined> {
    const startTime = performance.now();
    try {
      const found = await this.readClient.searchObject(packageName, 'DEVC/K', 5);
      this.trackRequest(startTime, true);
      return (found || []).some(
        entry => String((entry as any)['adtcore:name'] || '').toUpperCase() === packageName
      );
    } catch (error: any) {
      this.trackRequest(startTime, false);
      return undefined;
    }
  }

  private async walk(args: any, defaultMaxObjects: number, readableOnly?: boolean) {
    const packageName = this.packageName(args);
    return {
      packageName,
      walked: await walkPackage(packageName, name => this.nodesOf(name), {
        maxDepth: Number(args?.maxDepth) || DEFAULT_DEPTH,
        maxObjects: Number(args?.maxObjects) || defaultMaxObjects,
        objectTypes: Array.isArray(args?.objectTypes) ? args.objectTypes : undefined,
        readableOnly: readableOnly ?? args?.readableOnly === true
      })
    };
  }

  async handlePackageTree(args: any): Promise<any> {
    const { packageName, walked } = await this.walk(args, DEFAULT_MAX_OBJECTS);

    if (!walked.objects.length && walked.packages.length === 1 && !walked.notWalked.length) {
      const exists = await this.packageExists(packageName);
      return this.answer({
        status: exists === false ? 'error' : 'success',
        packageName,
        objectCount: 0,
        objects: [],
        packages: walked.packages,
        exists: exists ?? 'unknown',
        hint: exists === false
          ? `There is no package ${packageName}. An unknown package answers with an empty node list, the same as an empty one, so this was checked separately.`
          : `${packageName} exists and holds nothing that matches.`
      });
    }

    return this.answer({
      status: 'success',
      packageName,
      objectCount: walked.objects.length,
      countsByType: countByType(walked.objects),
      packages: walked.packages,
      deepestLevel: walked.deepestLevel,
      ...(walked.notWalked.length ? { notWalked: walked.notWalked } : {}),
      ...(walked.truncated ? { truncated: true } : {}),
      objects: walked.objects,
      ...(walked.truncated || walked.notWalked.length
        ? {
          hint: [
            walked.truncated ? 'The object limit was reached - raise maxObjects or narrow objectTypes.' : '',
            walked.notWalked.length ? `Not opened at this depth: ${walked.notWalked.join(', ')}. Raise maxDepth or walk them directly.` : ''
          ].filter(Boolean).join(' ')
        }
        : {})
    });
  }

  async handleReadSources(args: any): Promise<any> {
    const objects = this.parseObjectArg<any[]>(args?.objects, 'objects');
    const urls = this.parseObjectArg<string[]>(args?.sourceUrls, 'sourceUrls');

    const targets: Array<{ label: string; url: string; objectType?: string }> = [];
    for (const object of Array.isArray(objects) ? objects : []) {
      const name = String(object?.name || '').trim();
      const objectType = String(object?.objectType || '').trim().toUpperCase();
      if (!name || !objectType) {
        throw new McpError(ErrorCode.InvalidParams, 'Each entry of objects needs a name and an objectType.');
      }
      const url = sourceUrlFor(objectType, name);
      if (!url) {
        targets.push({ label: `${name} (${objectType})`, url: '', objectType });
        continue;
      }
      targets.push({ label: name.toUpperCase(), url, objectType });
    }
    for (const url of Array.isArray(urls) ? urls : []) {
      targets.push({ label: String(url), url: String(url) });
    }
    if (!targets.length) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass objects: [{name, objectType}] or sourceUrls: [...].');
    }

    const budget = Number(args?.maxTotalChars) > 0 ? Number(args.maxTotalChars) : DEFAULT_TOTAL_CHARS;
    const maxLines = Number(args?.maxLinesPerObject) > 0 ? Number(args.maxLinesPerObject) : undefined;
    const version = args?.version ? String(args.version) : undefined;

    const sources: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    const notReached: string[] = [];
    let used = 0;

    for (const target of targets) {
      if (!target.url) {
        failed.push({
          object: target.label,
          error: `ADT serves no source for a ${target.objectType}. Readable types are ${READABLE_TYPES.join(', ')}.`
        });
        continue;
      }
      if (used >= budget) { notReached.push(target.label); continue; }

      const startTime = performance.now();
      try {
        const response = await this.readClient.httpClient.request(target.url, {
          method: 'GET',
          ...(version ? { qs: { version } } : {})
        });
        this.trackRequest(startTime, true);
        const whole = String(response.body ?? '');
        const lines = whole.split(/\r?\n/);
        const kept = maxLines ? lines.slice(0, maxLines) : lines;
        let text = kept.join('\n');
        const room = budget - used;
        const cut = text.length > room;
        if (cut) text = text.slice(0, room);
        used += text.length;
        sources.push({
          object: target.label,
          ...(target.objectType ? { objectType: target.objectType } : {}),
          sourceUrl: target.url,
          totalLines: lines.length,
          ...(maxLines && lines.length > maxLines ? { linesShown: kept.length } : {}),
          ...(cut ? { truncated: true } : {}),
          source: text
        });
      } catch (error: any) {
        this.trackRequest(startTime, false);
        failed.push({ object: target.label, sourceUrl: target.url, error: describeAdtError(error).error });
      }
    }

    return this.answer({
      status: sources.length ? 'success' : 'error',
      requested: targets.length,
      read: sources.length,
      ...(failed.length ? { failed } : {}),
      ...(notReached.length ? { notReached, hint: `The ${budget}-character budget ran out. Raise maxTotalChars, use maxLinesPerObject, or ask for fewer objects.` } : {}),
      sources
    });
  }

  async handleSearchInPackage(args: any): Promise<any> {
    const pattern = String(args?.pattern || '');
    if (!pattern) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass pattern - the text or regular expression to look for.');
    }
    // Only objects with readable text: a search cannot say anything about a
    // data element, and reading one would just be a failed request per object.
    const { packageName, walked } = await this.walk(args, DEFAULT_SEARCH_OBJECTS, true);

    const maxMatches = Number(args?.maxMatchesPerObject) > 0 ? Number(args.maxMatchesPerObject) : 20;
    const scanOptions = {
      pattern,
      regex: args?.regex === true,
      ignoreCase: args?.ignoreCase !== false,
      contextLines: Number(args?.contextLines) || 0,
      maxMatches,
      skipComments: args?.skipComments === true
    };

    const hits: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    let scanned = 0;
    let totalMatches = 0;

    for (const object of walked.objects as WalkedObject[]) {
      if (!object.sourceUrl) continue;
      const startTime = performance.now();
      try {
        const response = await this.readClient.httpClient.request(object.sourceUrl, { method: 'GET' });
        this.trackRequest(startTime, true);
        scanned += 1;
        const result = findInSource(String(response.body ?? ''), scanOptions);
        if (!result.totalMatches) continue;
        totalMatches += result.totalMatches;
        hits.push({
          name: object.name,
          objectType: object.objectType,
          packageName: object.packageName,
          sourceUrl: object.sourceUrl,
          totalMatches: result.totalMatches,
          ...(result.truncated ? { truncated: true } : {}),
          matches: result.matches
        });
      } catch (error: any) {
        this.trackRequest(startTime, false);
        if (error instanceof ScanError) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        failed.push({ name: object.name, objectType: object.objectType, error: describeAdtError(error).error });
      }
    }

    return this.answer({
      status: 'success',
      packageName,
      pattern,
      packages: walked.packages,
      objectsScanned: scanned,
      objectsWithMatches: hits.length,
      totalMatches,
      ...(failed.length ? { failed } : {}),
      ...(walked.truncated ? { truncated: true } : {}),
      ...(walked.notWalked.length ? { notWalked: walked.notWalked } : {}),
      results: hits,
      hint: hits.length
        ? undefined
        : `Nothing found in ${scanned} source${scanned === 1 ? '' : 's'}. ${walked.truncated || walked.notWalked.length ? 'The walk did not cover the whole tree - see truncated and notWalked.' : 'The whole tree was covered.'}`
    });
  }
}
