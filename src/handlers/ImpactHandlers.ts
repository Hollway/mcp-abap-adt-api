import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { UsageReferenceSnippet } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { objectUrlFor, sourceUrlFor } from '../lib/packageWalk';
import { locateMethod, classSourceUrl, interfaceSourceUrl } from '../lib/symbolPosition';
import { rollUpUsages } from '../lib/impact';
import type { ImpactObject, ImpactPlace, UsageRow } from '../lib/impact';
import { includedPrograms, includeSourceUrl } from '../lib/sourceScan';
import { extractCallsAcross, groupCalls, CALL_KINDS } from '../lib/abapCalls';
import type { CallSite, UnresolvedCall } from '../lib/abapCalls';

/**
 * What depends on an object - the question asked before changing one.
 *
 * usageReferences already answers it, in a form that cannot be read: a flat
 * list that is really a tree of packages, objects and the places inside them.
 * ZCL_APP_RETURN answers with 352 rows, about 178,000 characters, for what is
 * in the end a list of some 40 objects. This rolls that up, and can follow the
 * callers one step further to show what depends on them in turn.
 */

const MAX_BRANCHES = 25;
/** How many unresolved calls callsFrom lists before it only counts them. */
const MAX_UNRESOLVED_LISTED = 25;
/** BFS budget for abapPath: how many objects it will fetch usageReferences for before giving up. */
const MAX_PATH_NODES = 300;
const DEFAULT_MAX_PATH_DEPTH = 8;

export class ImpactHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'impactOf',
        description: 'What depends on an object, or on one method of it: the objects that use it, the places inside them, and the package each belongs to. This is usageReferences rolled up into an answer that can be read - that call returns a tree of package, object and member rows, which for a widely used class means hundreds of rows and over a hundred thousand characters for a list of forty objects. Usages in test includes are marked as such, standard SAP objects are left out unless asked for, and depth=2 follows the callers one step further to show what depends on them in turn. A method with no callers looks the same as one reached only dynamically, so an empty answer says so rather than reading as proof.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZCL_APP_RETURN. Use with objectType.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, FUGR/F, TABL/DT, DDLS/DF. Defaults to CLAS/OC.'
            },
            objectUrl: {
              type: 'string',
              description: 'ADT object URL, for a type objectName cannot address.'
            },
            methodName: {
              type: 'string',
              description: 'Narrow it to one method of the class or interface. The position inside the source is worked out here.'
            },
            depth: {
              type: 'number',
              description: '1 (default) for what uses the object; 2 also reports what uses those, with the object each was reached through.'
            },
            onlyCustom: {
              type: 'boolean',
              description: 'Keep only Z*, Y* and /namespace/ objects (default true). The count of standard objects left out is reported.'
            },
            includeTests: {
              type: 'boolean',
              description: 'Include usages that are only in test includes (default true); they are marked testOnly either way.'
            },
            packageName: {
              type: 'string',
              description: 'Only usages in this package.'
            },
            maxObjects: {
              type: 'number',
              description: 'How many objects to list. Default 100.'
            },
            maxPlacesPerObject: {
              type: 'number',
              description: 'How many places to list per object. Default 8; the rest are counted.'
            },
            snippets: {
              type: 'boolean',
              description: 'Also fetch the source snippet of each place actually listed (one more backend call, larger answer). Only covers depth 1 - indirect (depth=2) places never get snippets.'
            }
          },
          required: []
        }
      },
      {
        name: 'abapPath',
        description: 'Whether one object\'s code reaches another, and through what. Walks usageReferences backwards from "to" through its callers, breadth-first, until it reaches "from" or runs out of budget - the same data impactOf uses, just followed as a chain instead of rolled up one level. Pure ADT data, no ABAP parsing: a call made only dynamically (CALL METHOD (name)) is invisible to it, same as usageReferences itself.',
        inputSchema: {
          type: 'object',
          properties: {
            fromName: { type: 'string', description: 'Starting object, e.g. ZR_APP_REPORT. Use with fromType.' },
            fromType: { type: 'string', description: 'ADT type of fromName. Defaults to CLAS/OC.' },
            fromUrl: { type: 'string', description: 'ADT object URL for the start, for a type fromName cannot address.' },
            toName: { type: 'string', description: 'Target object, e.g. ZCL_APP_RETURN. Use with toType.' },
            toType: { type: 'string', description: 'ADT type of toName. Defaults to CLAS/OC.' },
            toUrl: { type: 'string', description: 'ADT object URL for the target, for a type toName cannot address.' },
            onlyCustom: {
              type: 'boolean',
              description: 'Only walk through Z*, Y* and /namespace/ objects (default true). A path through standard SAP code is rare and usually means the two objects are not really related.'
            },
            maxDepth: {
              type: 'number',
              description: `How many hops to try before giving up (default ${DEFAULT_MAX_PATH_DEPTH}).`
            },
            maxNodes: {
              type: 'number',
              description: `Total objects to fetch usageReferences for across the whole search before giving up (default ${MAX_PATH_NODES}). A widely used interface as an intermediate hop can otherwise turn this into a wide, expensive search.`
            }
          },
          required: []
        }
      },
      {
        name: 'callsFrom',
        description: 'What an object\'s own code calls: the other direction of impactOf. No backend call answers this - the where-used index only knows who calls whom, one object at a time - so the source is read and scanned. Answers with the objects reached, grouped by target, each with the lines that reach it: methods and constructors, function modules, forms and programs, transactions, database tables, the dictionary types its declarations name (TYPE zorders, LIKE zorders-id, SELECT-OPTIONS ... FOR), what the class inherits and implements, and the includes it pulls in. This is scanning, not parsing: a macro hides what it expands to, and a name built at runtime cannot be known before the program runs - every such call is listed as unresolved with the reason, so a missing edge is named rather than silently absent.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object whose code to scan, e.g. ZCL_APP_ORDER. Use with objectType.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F. Defaults to CLAS/OC.'
            },
            sourceUrl: {
              type: 'string',
              description: 'Source URL to scan instead, e.g. /sap/bc/adt/programs/programs/zr_app/source/main.'
            },
            kinds: {
              type: 'array',
              description: `Only these kinds of call: ${CALL_KINDS.join(', ')}. All of them by default.`,
              items: { type: 'string' }
            },
            onlyCustom: {
              type: 'boolean',
              description: 'Keep only Z*, Y* and /namespace/ targets (default true). Standard SAP calls are counted, not listed - a class that calls CL_GUI and CX_ROOT everywhere would otherwise bury its own dependencies.'
            },
            followIncludes: {
              type: 'boolean',
              description: 'Also read the includes the source names. A function group is read this way whichever way this is set: its main source holds nothing but INCLUDE lines, and every function module body lives in one of them.'
            },
            maxTargets: {
              type: 'number',
              description: 'How many targets to list. Default 100.'
            },
            maxPlacesPerTarget: {
              type: 'number',
              description: 'How many call sites to list per target. Default 8; the rest are counted.'
            },
            maxStatementChars: {
              type: 'number',
              description: 'How much of each statement to quote, default 160.'
            }
          },
          required: []
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'impactOf':
        return this.handleImpactOf(args);
      case 'abapPath':
        return this.handleAbapPath(args);
      case 'callsFrom':
        return this.handleCallsFrom(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown impact tool: ${toolName}`);
    }
  }

  private resolveTarget(args: any): { objectUrl: string; label: string; objectType: string; name: string } {
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
      return { objectUrl: url, label: `${name.toUpperCase()} (${objectType})`, objectType, name };
    }
    const objectUrl = String(args?.objectUrl || '').trim();
    if (!objectUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'What should be checked? Pass objectName (with objectType) or objectUrl.'
      );
    }
    return { objectUrl, label: objectUrl, objectType, name: '' };
  }

  /** Same idea as resolveTarget, for abapPath's two named ends (fromX / toX). */
  private resolveEnd(args: any, prefix: 'from' | 'to'): { objectUrl: string; label: string; objectType: string; name: string } {
    const name = String(args?.[`${prefix}Name`] || '').trim();
    const objectType = String(args?.[`${prefix}Type`] || 'CLAS/OC').trim().toUpperCase();
    if (name) {
      const url = objectUrlFor(objectType, name);
      if (!url) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No ADT URL is known for a ${objectType}. Pass ${prefix}Url instead.`
        );
      }
      return { objectUrl: url, label: `${name.toUpperCase()} (${objectType})`, objectType, name: name.toUpperCase() };
    }
    const objectUrl = String(args?.[`${prefix}Url`] || '').trim();
    if (!objectUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `What is the ${prefix === 'from' ? 'starting' : 'target'} object? Pass ${prefix}Name (with ${prefix}Type) or ${prefix}Url.`
      );
    }
    return { objectUrl, label: objectUrl, objectType, name: '' };
  }

  /** The position of a method inside its source, which is what ADT asks for. */
  private async methodPosition(
    args: any,
    objectType: string,
    name: string,
    methodName: string
  ): Promise<{ sourceUrl: string; line: number; column: number; kind: string }> {
    if (!name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'methodName needs objectName as well: the position of the method is found in the source of the class.'
      );
    }
    const sourceUrl = objectType.startsWith('INTF')
      ? interfaceSourceUrl(name)
      : objectType.startsWith('CLAS')
        ? classSourceUrl(name)
        : sourceUrlFor(objectType, name);
    if (!sourceUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `methodName only applies to a class or an interface; ${objectType} has no methods.`
      );
    }
    const source = await this.readClient.getObjectSource(sourceUrl);
    const at = locateMethod(source, methodName);
    if (!at) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No declaration or implementation of '${methodName}' in ${name.toUpperCase()}. Check the name with classComponents or sourceOutline.`
      );
    }
    return { sourceUrl, line: at.line, column: at.column, kind: at.kind };
  }

  /**
   * Ask for the references. As in whereUsedMethod, which URL carries the
   * position is a backend detail: the source URL matches how ADT itself asks,
   * and the object URL is tried when that comes back empty.
   */
  private async references(url: string, line?: number, column?: number): Promise<UsageRow[]> {
    const rows = await this.readClient.usageReferences(url, line, column);
    return (rows || []) as UsageRow[];
  }

  async handleImpactOf(args: any): Promise<any> {
    const { objectUrl, label, objectType, name } = this.resolveTarget(args);
    const methodName = String(args?.methodName || '').trim();
    const depth = Number(args?.depth) === 2 ? 2 : 1;
    const options = {
      onlyCustom: args?.onlyCustom !== false,
      includeTests: args?.includeTests !== false,
      packageName: args?.packageName,
      maxObjects: args?.maxObjects,
      maxPlacesPerObject: args?.maxPlacesPerObject
    };

    const startTime = performance.now();
    try {
      let rows: UsageRow[];
      let position: { sourceUrl: string; line: number; column: number; kind: string } | undefined;

      if (methodName) {
        position = await this.methodPosition(args, objectType, name, methodName);
        rows = await this.references(position.sourceUrl, position.line, position.column);
        if (rows.length === 0) rows = await this.references(objectUrl, position.line, position.column);
      } else {
        rows = await this.references(objectUrl);
      }

      const direct = rollUpUsages(rows, options);

      // One step further: what uses the objects that use this one. Bounded,
      // because every branch is another round trip.
      let indirect: Array<ImpactObject & { via: string[] }> | undefined;
      let branchesFollowed = 0;
      let branchesSkipped = 0;
      if (depth === 2) {
        const merged = new Map<string, ImpactObject & { via: Set<string> }>();
        const branches = direct.objects.filter(entry => entry.objectUrl);
        for (const branch of branches) {
          if (branchesFollowed >= MAX_BRANCHES) { branchesSkipped++; continue; }
          branchesFollowed++;
          let branchRows: UsageRow[] = [];
          try {
            branchRows = await this.references(branch.objectUrl!);
          } catch {
            // A branch that cannot be read is not worth failing the answer for.
            continue;
          }
          for (const entry of rollUpUsages(branchRows, options).objects) {
            if (entry.name === branch.name && entry.type === branch.type) continue;
            const key = `${entry.type}|${entry.name}`;
            const existing = merged.get(key);
            if (existing) { existing.via.add(branch.name); continue; }
            merged.set(key, { ...entry, via: new Set([branch.name]) });
          }
        }
        // Objects already listed as direct users are not news at the second level.
        const directKeys = new Set(direct.objects.map(entry => `${entry.type}|${entry.name}`));
        indirect = [...merged.entries()]
          .filter(([key]) => !directKeys.has(key))
          .map(([, entry]) => ({ ...entry, via: [...entry.via].sort() }))
          .sort((a, b) => b.places.length - a.places.length || a.name.localeCompare(b.name))
          .slice(0, Math.max(1, Number(options.maxObjects) || 100));
      }

      // Snippets only for what is actually listed at depth 1: fetching one for
      // every one of 352 raw rows is the exact blow-up rollUpUsages exists to
      // avoid. objectIdentifier is how a place maps back to the row that made
      // it, and it is stripped again below - it means nothing outside this call.
      let snippetsFetched = 0;
      if (args?.snippets === true) {
        const rowsByIdentifier = new Map<string, UsageRow>();
        for (const row of rows) {
          if (row.objectIdentifier && !rowsByIdentifier.has(row.objectIdentifier)) {
            rowsByIdentifier.set(row.objectIdentifier, row);
          }
        }
        const wantedRows: UsageRow[] = [];
        const wantedIds = new Set<string>();
        for (const object of direct.objects) {
          for (const place of object.places) {
            const id = place.objectIdentifier;
            if (!id || wantedIds.has(id)) continue;
            const row = rowsByIdentifier.get(id);
            if (row) { wantedIds.add(id); wantedRows.push(row); }
          }
        }
        if (wantedRows.length > 0) {
          const snippetRows = await this.readClient.usageReferenceSnippets(wantedRows as any);
          const byIdentifier = new Map((snippetRows || []).map((s: UsageReferenceSnippet) => [s.objectIdentifier, s.snippets]));
          for (const object of direct.objects) {
            for (const place of object.places) {
              if (place.objectIdentifier) {
                const snippets = byIdentifier.get(place.objectIdentifier);
                if (snippets) (place as ImpactPlace & { snippets?: unknown }).snippets = snippets;
              }
            }
          }
          snippetsFetched = wantedRows.length;
        }
      }
      // Internal correlation key only; never part of the answer.
      for (const object of direct.objects) {
        for (const place of object.places) delete place.objectIdentifier;
      }

      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            target: {
              object: label,
              ...(methodName ? { method: methodName.toUpperCase() } : {}),
              ...(position ? { resolvedAt: position } : {})
            },
            depth,
            rowsFromBackend: rows.length,
            summary: direct.summary,
            ...(direct.standardObjectsHidden
              ? { standardObjectsHidden: direct.standardObjectsHidden }
              : {}),
            ...(direct.objectsHidden
              ? {
                objectsHidden: direct.objectsHidden,
                note: `Listing ${direct.objects.length} of ${direct.summary.objects} objects; raise maxObjects to see the rest.`
              }
              : {}),
            usedBy: direct.objects,
            ...(args?.snippets === true
              ? { snippetsFetched, snippetsNote: 'Only for the places listed above at depth 1; indirect (depth=2) places never get snippets.' }
              : {}),
            ...(indirect
              ? {
                indirect,
                indirectNote: `What uses those, followed through ${branchesFollowed} of ${direct.objects.length} callers${branchesSkipped ? `; ${branchesSkipped} not followed (limit ${MAX_BRANCHES})` : ''}.`
              }
              : {}),
            ...(direct.summary.objects === 0
              ? {
                emptyNote: methodName
                  ? 'Nothing came back. A private method used only inside its own class, or one reached only dynamically (CALL METHOD (name)), looks exactly like this.'
                  : 'Nothing came back. An object reached only dynamically, or only from outside this system, looks exactly like this.'
              }
              : {})
          }, null, 2)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw wrapAdtError(error, `Failed to work out what depends on ${label}`);
    }
  }

  /** Where the text of the object to scan lives, and what to call it in the answer. */
  private resolveSource(args: any): { sourceUrl: string; label: string; objectType: string; name: string } {
    const name = String(args?.objectName || '').trim();
    const objectType = String(args?.objectType || 'CLAS/OC').trim().toUpperCase();
    if (name) {
      const url = sourceUrlFor(objectType, name);
      if (!url) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No ADT source is served for a ${objectType}. Pass sourceUrl instead, or use a type that has text.`
        );
      }
      return { sourceUrl: url, label: `${name.toUpperCase()} (${objectType})`, objectType, name: name.toUpperCase() };
    }
    const sourceUrl = String(args?.sourceUrl || '').trim();
    if (!sourceUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Whose calls? Pass objectName (with objectType) or sourceUrl.'
      );
    }
    const fromUrl = decodeURIComponent(
      sourceUrl.split('#')[0].replace(/\/source\/main$/, '').split('/').filter(Boolean).pop() || ''
    ).toUpperCase();
    return { sourceUrl, label: fromUrl || sourceUrl, objectType, name: fromUrl };
  }

  /**
   * The includes of an object, where its code really sits.
   *
   * A function group serves nothing but INCLUDE lines at its own URL - every
   * function module body is in an include - so it is followed whatever was
   * asked for, and its includes live under the group rather than among the
   * report includes. A report is followed only when asked, because its
   * includes are one call each.
   */
  private async readIncludes(
    main: string,
    objectType: string,
    groupName: string
  ): Promise<{ sources: Array<{ name: string; source: string }>; unread: Array<{ name: string; error: string }> }> {
    const sources: Array<{ name: string; source: string }> = [];
    const unread: Array<{ name: string; error: string }> = [];
    const isGroup = objectType.startsWith('FUGR');
    for (const name of includedPrograms(main)) {
      const urls = isGroup && groupName
        ? [
          `/sap/bc/adt/functions/groups/${encodeURIComponent(groupName.toLowerCase())}/includes/${encodeURIComponent(name.toLowerCase())}/source/main`,
          includeSourceUrl(name)
        ]
        : [includeSourceUrl(name)];
      let lastError = '';
      let read = false;
      for (const url of urls) {
        try {
          sources.push({ name, source: await this.readClient.getObjectSource(url) });
          read = true;
          break;
        } catch (error: any) {
          lastError = error?.message || `${error}`;
        }
      }
      // An include that cannot be read is reported, not thrown: one generated
      // or system include among twenty is no reason to lose the other nineteen.
      if (!read) unread.push({ name, error: lastError });
    }
    return { sources, unread };
  }

  /**
   * Read the object's text and scan it for what it reaches.
   *
   * The whole answer comes from the source, so what is in the source is what
   * can be found: nothing here asks the backend to confirm that a target
   * exists, and nothing is filtered out by whether it does.
   */
  async handleCallsFrom(args: any): Promise<any> {
    const { sourceUrl, label, objectType, name } = this.resolveSource(args);
    const kinds = Array.isArray(args?.kinds)
      ? args.kinds.map((kind: any) => String(kind).trim().toLowerCase())
      : undefined;
    const unknownKind = kinds?.find((kind: string) => !CALL_KINDS.includes(kind as any));
    if (unknownKind) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `kinds: '${unknownKind}' is not one of ${CALL_KINDS.join(', ')}.`
      );
    }
    const onlyCustom = args?.onlyCustom !== false;
    const wantIncludes = args?.followIncludes === true || objectType.startsWith('FUGR');

    const startTime = performance.now();
    try {
      const main = await this.readClient.getObjectSource(sourceUrl);
      const scanned: Array<{ name: string; source: string }> = [{ name: name || label, source: main }];
      let includesUnread: Array<{ name: string; error: string }> = [];
      if (wantIncludes) {
        const read = await this.readIncludes(main, objectType, name);
        scanned.push(...read.sources);
        includesUnread = read.unread;
      }

      // Scanned together, not one at a time: a function group declares its
      // globals in one include and uses them in another, so a call through
      // gs_screen-handler is only resolvable with every include in hand.
      const found = extractCallsAcross(scanned, { onlyCustom, kinds });
      const calls: CallSite[] = found.calls;
      const unresolved: UnresolvedCall[] = found.unresolved;
      const statements = found.statements;
      const standardTargetsHidden = found.standardTargetsHidden;

      const { targets, targetsHidden } = groupCalls(calls, {
        maxTargets: Number(args?.maxTargets) || undefined,
        maxPlacesPerTarget: Number(args?.maxPlacesPerTarget) || undefined,
        maxStatementChars: Number(args?.maxStatementChars) || undefined
      });

      // No prototype: one of the kinds counted here is called 'constructor',
      // and on a plain object that name already holds a function - the count
      // came out as "function Object() { [native code] }111".
      const byKind: Record<string, number> = Object.create(null);
      for (const call of calls) byKind[call.kind] = (byKind[call.kind] || 0) + 1;

      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            target: { object: label, sourceUrl },
            sourcesScanned: scanned.map(source => ({
              name: source.name,
              lines: source.source.split(/\r?\n/).length
            })),
            ...(includesUnread.length ? { includesUnread } : {}),
            summary: {
              targets: targets.length + targetsHidden,
              calls: calls.length,
              statements,
              byKind
            },
            ...(standardTargetsHidden ? { standardTargetsHidden } : {}),
            ...(targetsHidden
              ? {
                targetsHidden,
                note: `Listing ${targets.length} targets; raise maxTargets to see the rest.`
              }
              : {}),
            calls: targets,
            ...(unresolved.length
              ? {
                unresolved: unresolved.slice(0, MAX_UNRESOLVED_LISTED),
                unresolvedNote: `${unresolved.length} call(s) name their target at runtime, or through a reference this source does not declare${unresolved.length > MAX_UNRESOLVED_LISTED ? `; listing the first ${MAX_UNRESOLVED_LISTED}` : ''}. Each is a real edge this answer cannot name - usageReferences on the suspected target, or impactOf, is how to settle one.`
              }
              : {}),
            ...(calls.length === 0
              ? {
                emptyNote: wantIncludes
                  ? 'Nothing was found in the source or its includes. An object that only declares data, or one whose work is all in macros, looks exactly like this.'
                  : 'Nothing was found in this source. A program whose code lives in its includes looks exactly like this - pass followIncludes to read them.'
              }
              : {}),
            scanNote: 'Read from the source text, not from the where-used index: what a macro expands to is not seen, and no target is checked against the repository. Targets outside Z*, Y* and /namespace/ are counted only, unless onlyCustom is false.'
          }, null, 2)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw wrapAdtError(error, `Failed to work out what ${label} calls`);
    }
  }

  /**
   * BFS over usageReferences, starting at "to" and walking backwards through
   * its callers - the same call impactOf makes, just followed as a chain
   * instead of rolled up one level. The first path found is shortest, because
   * BFS visits every object at distance N before any at distance N+1.
   */
  async handleAbapPath(args: any): Promise<any> {
    const toEnd = this.resolveEnd(args, 'to');
    const fromEnd = this.resolveEnd(args, 'from');
    const onlyCustom = args?.onlyCustom !== false;
    const maxDepth = Math.max(1, Number(args?.maxDepth) || DEFAULT_MAX_PATH_DEPTH);
    const maxNodes = Math.max(1, Number(args?.maxNodes) || MAX_PATH_NODES);
    const urlKey = (url: string): string => url.trim().toLowerCase();
    const toKey = urlKey(toEnd.objectUrl);
    const fromKey = urlKey(fromEnd.objectUrl);

    const startTime = performance.now();
    try {
      type PathNode = { name: string; type: string; package?: string; objectUrl: string };
      const nodes = new Map<string, PathNode>([
        [toKey, { name: toEnd.name || toEnd.label, type: toEnd.objectType, objectUrl: toEnd.objectUrl }]
      ]);
      const parentOf = new Map<string, { parentKey: string; via: ImpactPlace[] }>();
      const visited = new Set<string>([toKey]);
      let queue: string[] = [toKey];
      let nodesFetched = 0;
      let foundKey: string | undefined = toKey === fromKey ? toKey : undefined;
      let depthReached = 0;

      outer: while (!foundKey && queue.length > 0 && depthReached < maxDepth && nodesFetched < maxNodes) {
        depthReached++;
        const nextQueue: string[] = [];
        for (const currentKey of queue) {
          if (nodesFetched >= maxNodes) break;
          nodesFetched++;
          const current = nodes.get(currentKey)!;
          let rows: UsageRow[];
          try {
            rows = await this.references(current.objectUrl);
          } catch {
            // A node that cannot be read is a dead end, not a failed search.
            continue;
          }
          const rolled = rollUpUsages(rows, { onlyCustom, includeTests: true, maxObjects: 100 });
          for (const caller of rolled.objects) {
            if (!caller.objectUrl) continue;
            const callerKey = urlKey(caller.objectUrl);
            if (visited.has(callerKey)) continue;
            visited.add(callerKey);
            nodes.set(callerKey, { name: caller.name, type: caller.type, package: caller.package, objectUrl: caller.objectUrl });
            parentOf.set(callerKey, { parentKey: currentKey, via: caller.places });
            if (callerKey === fromKey) { foundKey = callerKey; break outer; }
            nextQueue.push(callerKey);
          }
        }
        queue = nextQueue;
      }

      this.trackRequest(startTime, true);

      if (!foundKey) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              found: false,
              from: { object: fromEnd.label },
              to: { object: toEnd.label },
              nodesVisited: nodesFetched,
              depthReached,
              note: `No path found within ${depthReached} hop(s), ${nodesFetched} object(s) checked (limit ${maxNodes}). A call made only dynamically (CALL METHOD (name), CALL FUNCTION lv_fm) would not show up here; the real path may also simply be longer than maxDepth allows.`
            }, null, 2)
          }]
        };
      }

      const chain: string[] = [];
      for (let cursor: string | undefined = foundKey; cursor; cursor = parentOf.get(cursor)?.parentKey) {
        chain.push(cursor);
      }
      const path = chain.map((nodeKey, index) => {
        const node = nodes.get(nodeKey)!;
        const via = index < chain.length - 1 ? parentOf.get(nodeKey)?.via : undefined;
        return {
          name: node.name,
          type: node.type,
          ...(node.package ? { package: node.package } : {}),
          ...(via && via.length ? { callsNextVia: via } : {})
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            found: true,
            hops: chain.length - 1,
            nodesVisited: nodesFetched,
            path
          }, null, 2)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw wrapAdtError(error, `Failed to find a path from ${fromEnd.label} to ${toEnd.label}`);
    }
  }
}
